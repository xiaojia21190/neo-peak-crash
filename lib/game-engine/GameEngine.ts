/**
 * 游戏引擎核心（GameEngine）
 * - 管理回合生命周期（BETTING -> RUNNING -> SETTLING/COMPLETED）
 * - 处理下注、状态同步（Redis）与持久化（Prisma），并集成资金与风控流程
 */


import { EventEmitter } from 'events';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type {
  RoundConfig,
  GameState,
  ServerBet,
  PriceUpdate,
  PlaceBetRequest,
  PlaceBetResponse,
  SettlementItem,
  GameEngineEvents,
} from './types';
import {
  CENTER_ROW_INDEX,
  MIN_TARGET_TIME_OFFSET,
  HIT_TIME_TOLERANCE,
  MISS_TIME_BUFFER,
  DEFAULT_ROUND_CONFIG,
  REDIS_KEYS,
  ERROR_CODES,
  MAX_ROW_INDEX,
  MAX_ROUND_PAYOUT,
  MAX_SETTLEMENTS_PER_TICK,
} from './constants';
import {
  calculateRowIndex,
  calculateMultiplier,
} from './utils';
import { isValidMoneyAmount, roundMoney } from '../shared/gameMath';
import { GameError } from './errors';
import { PriceService } from './PriceService';
import { allowSlidingWindowRequest, buildRateLimitKey } from '../services/rateLimit';
import { FinancialService } from '../services/financial';
import { HousePoolService } from '../services/HousePoolService';
import { LockManager } from './LockManager';
import { SnapshotService } from './SnapshotService';
import { SettlementService } from './SettlementService';
import { RiskManager } from './RiskManager';

export class GameEngine extends EventEmitter {
  private config: RoundConfig;
  private state: GameState | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private settlementService: SettlementService;

  private betHeap: ServerBet[] = [];

  private snapshotService: SnapshotService;

  private pendingBetCountsByUser: Map<string, number> = new Map();
  private pendingBetCountsRoundId: string | null = null;
  private pendingBetCountsActiveBetsSize = 0;

  private lastEmitTimes: Map<string, number> = new Map();

  // 最新价格缓存（来自 PriceService）
  private priceCache: PriceUpdate | null = null;

  // Redis 锁管理器（回合/下注幂等与并发保护）
  private lockManager: LockManager;

  // 资金服务 / 资金池 / 风控
  private financialService: FinancialService;
  private housePoolService: HousePoolService;
  private riskManager: RiskManager;

  constructor(
    private redis: Redis,
    private prisma: PrismaClient,
    private priceService: PriceService,
    config?: Partial<RoundConfig>,
    deps?: { housePoolService?: HousePoolService }
  ) {
    super();
    this.config = { ...DEFAULT_ROUND_CONFIG, ...config };
    this.lockManager = new LockManager(redis);
    this.snapshotService = new SnapshotService(prisma);
    this.financialService = new FinancialService(prisma);
    this.housePoolService = deps?.housePoolService ?? new HousePoolService(prisma);
    this.riskManager = new RiskManager({ maxRoundPayoutRatio: MAX_ROUND_PAYOUT });
    this.settlementService = new SettlementService({
      prisma,
      financialService: this.financialService,
      housePoolService: this.housePoolService,
      snapshotService: this.snapshotService,
      asset: this.config.asset,
      hitTolerance: this.config.hitTolerance,
      callbacks: {
        getActiveBet: (betId) => this.state?.activeBets.get(betId),
        onBetSettled: (payload) => {
          void this.handleBetSettled(payload);
        },
      },
    });

    // 缓存最新价格（由 PriceService 推送）
    this.priceService.on('price', (price: PriceUpdate) => {
      this.priceCache = price;
    });

    // 价格源严重故障：取消当前回合/停止接收下注
    this.priceService.on('price_critical', () => {
      this.handlePriceUnavailable();
    });
  }

  // ========== Public API ==========

  /**
   * 获取当前游戏状态
   */
  getState(): GameState | null {
    return this.state;
  }

  /**
   * 获取当前回合配置
   */
  getConfig(): RoundConfig {
    return { ...this.config };
  }

  /**
   * 更新最新价格缓存（通常来自 PriceService）
   */
  updatePriceCache(price: PriceUpdate): void {
    this.priceCache = price;
  }

  // ========== Round Lifecycle ==========

  /**
   * 开始新回合
   */
  async startRound(): Promise<void> {
    if (this.state?.status === 'RUNNING' ||
      this.state?.status === 'BETTING' ||
      this.state?.status === 'SETTLING') {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '鐎圭寮跺﹢渚€宕堕悙鍙夔€弶鈺傜椤㈡垶??');
    }

    const lockTtl = (this.config.maxDuration + 60) * 1000;
    const lockToken = await this.lockManager.acquireRoundLock(this.config.asset, lockTtl);

    if (!lockToken) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, 'Unable to acquire round lock');
    }

    try {
      const startPrice = this.priceService.getLatestPrice();
      if (!startPrice) {
        throw new GameError(ERROR_CODES.PRICE_UNAVAILABLE, '濞寸娀鏀遍悧鎼佸嫉瀹懎顫ゅ☉鎾崇Т瑜版煡鎮?');
      }

      const now = Date.now();

      const round = await this.prisma.round.create({
        data: {
          asset: this.config.asset,
          status: 'BETTING',
          startPrice: startPrice.price,
          startedAt: new Date(now),
        },
      });

      this.state = {
        roundId: round.id,
        status: 'BETTING',
        asset: this.config.asset,
        startPrice: startPrice.price,
        currentPrice: startPrice.price,
        currentRow: CENTER_ROW_INDEX,
        elapsed: 0,
        roundStartTime: now,
        activeBets: new Map(),
      };

      await this.syncStateToRedis();
      this.startTickLoop();

      this.emit('round:start', {
        roundId: round.id,
        asset: this.config.asset,
        startPrice: startPrice.price,
        startTime: now,
        bettingDuration: this.config.bettingDuration,
        maxDuration: this.config.maxDuration,
      });

      setTimeout(() => this.transitionToRunning(), this.config.bettingDuration * 1000);

      console.log(`[GameEngine] Round ${round.id} started`);
    } catch (error) {
      console.error(`[GameEngine] startRound failed, releasing lock:`, error);
      await this.lockManager.releaseRoundLock(this.config.asset);
      throw error;
    }
  }

  private transitionToRunning(): void {
    if (!this.state || this.state.status !== 'BETTING') return;

    const roundId = this.state.roundId;

    void (async () => {
      // Persist status transition (authoritative gate for betting).
      const updated = await this.prisma.round.updateMany({
        where: { id: roundId, status: 'BETTING' },
        data: { status: 'RUNNING' },
      });

      if (updated.count !== 1) {
        console.warn(
          `[GameEngine] Round ${roundId} status transition BETTING->RUNNING skipped (round missing or already transitioned)`
        );
        return;
      }

      // If state has been cleaned up or replaced, do not mutate it.
      if (!this.state || this.state.roundId !== roundId) return;

      this.state.status = 'RUNNING';
      await this.syncStateToRedis().catch(console.error);

      this.emit('round:running', { roundId });

      console.log(`[GameEngine] Round ${roundId} now RUNNING`);
    })().catch((error) => {
      console.error(`[GameEngine] Failed to transition round ${roundId} to RUNNING:`, error);
      // Best-effort: close betting in-memory to avoid accepting late bets if DB update failed.
      if (this.state && this.state.roundId === roundId && this.state.status === 'BETTING') {
        this.state.status = 'RUNNING';
        this.syncStateToRedis().catch(console.error);
      }
    });
  }

  /**
   * 结束当前回合并进入结算流程
   */
  async endRound(reason: 'timeout' | 'manual' | 'crash' = 'timeout'): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
      this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    const endPrice = this.state.currentPrice;
    const settlementSnapshot = {
      elapsed: this.state.elapsed,
      currentRow: this.state.currentRow,
      currentPrice: this.state.currentPrice,
      roundStartTime: this.state.roundStartTime,
    };
    console.log(`[GameEngine] Ending round ${roundId} (reason: ${reason})`);

    this.stopTickLoop();

    try {
      await this.prisma.round
        .updateMany({
          where: { id: roundId, status: { in: ['BETTING', 'RUNNING'] } },
          data: { status: 'SETTLING' },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to persist SETTLING status for round ${roundId}:`, error);
        });

      await this.syncStateToRedis().catch((error) => {
        console.error(`[GameEngine] Failed to sync state to Redis for round ${roundId}:`, error);
      });

      this.settleAllPendingBets();

      const flushed = await this.settlementService.flushQueue().catch((error) => {
        console.error(`[GameEngine] Failed to flush settlement queue for round ${roundId}:`, error);
        return false;
      });

      let snapshotFlushError: unknown;
      try {
        await this.snapshotService.flushSnapshots();
      } catch (error) {
        snapshotFlushError = error;
        console.error(`[GameEngine] Failed to flush snapshots for round ${roundId}:`, error);
      }

      await this.settlementService.compensateUnsettledBets(roundId, settlementSnapshot);

      const pendingCount = await this.settlementService.countPendingBets(roundId);
      if (pendingCount > 0) {
        const retryReason = flushed ? 'pending_bets' : 'flush_timeout';
        this.settlementService.scheduleRetry(roundId, settlementSnapshot, retryReason);
      }

      if (snapshotFlushError) {
        throw snapshotFlushError;
      }

      const stats = this.calculateRoundStats();

      const completed = await this.prisma.round
        .updateMany({
          where: { id: roundId, status: 'SETTLING' },
          data: {
            status: 'COMPLETED',
            endPrice,
            endedAt: new Date(),
            totalBets: stats.totalBets,
            totalVolume: stats.totalVolume,
            totalPayout: stats.totalPayout,
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to update round ${roundId} in database:`, error);
          return { count: 0 };
        });

      if (completed.count !== 1) {
        console.warn(`[GameEngine] Round ${roundId} status transition SETTLING->COMPLETED did not apply`);
      }

      this.emit('round:end', {
        roundId,
        endPrice,
        reason,
        stats: {
          totalBets: stats.totalBets,
          totalWins: stats.totalWins,
          totalPayout: stats.totalPayout,
        },
      });
    } catch (error) {
      console.error(`[GameEngine] endRound failed for round ${roundId}:`, error);
      try {
        const stats = this.calculateRoundStats();
        this.emit('round:end', {
          roundId,
          endPrice,
          reason: 'crash',
          stats: {
            totalBets: stats.totalBets,
            totalWins: stats.totalWins,
            totalPayout: stats.totalPayout,
          },
        });
      } catch (emitError) {
        console.error(`[GameEngine] Failed to emit round:end after failure for round ${roundId}:`, emitError);
      }
    } finally {
      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
        await this.redis.del(this.riskManager.buildReservedExpectedPayoutKey(roundId));
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      try {
        await this.lockManager.releaseRoundLock(this.config.asset);
      } catch (error) {
        console.error(`[GameEngine] Failed to release round lock for round ${roundId}:`, error);
      }

      this.cleanup();
    }

    console.log(`[GameEngine] Round ${roundId} completed`);
  }

  async cancelRound(reason: string): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
      this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    console.log(`[GameEngine] Cancelling round ${roundId} (reason: ${reason})`);

    try {
      this.stopTickLoop();
      // Prevent further in-memory settlement mutations while we perform refunds.
      this.settlementService.resetQueue();

      await this.prisma.round
        .updateMany({
          where: { id: roundId, status: { in: ['BETTING', 'RUNNING'] } },
          data: { status: 'SETTLING' },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to persist SETTLING status for cancelled round ${roundId}:`, error);
        });

      const dbUnsettledBets = await this.prisma.bet
        .findMany({
          where: {
            roundId,
            status: { in: ['PENDING', 'SETTLING'] },
          },
          select: {
            id: true,
            orderId: true,
            userId: true,
            amount: true,
            multiplier: true,
            targetRow: true,
            targetTime: true,
            status: true,
            isPlayMode: true,
            createdAt: true,
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to query unsettled bets for cancelled round ${roundId}:`, error);
          return [];
        });

      const betsToRefund: ServerBet[] = [];
      const seenBetIds = new Set<string>();

      for (const dbBet of dbUnsettledBets) {
        if (seenBetIds.has(dbBet.id)) continue;
        seenBetIds.add(dbBet.id);

        const memBet = this.state?.activeBets.get(dbBet.id);
        if (memBet) {
          betsToRefund.push(memBet);
          continue;
        }

        betsToRefund.push({
          id: dbBet.id,
          orderId: dbBet.orderId ?? '',
          userId: dbBet.userId,
          amount: Number(dbBet.amount),
          multiplier: Number(dbBet.multiplier),
          targetRow: Number(dbBet.targetRow ?? 0),
          targetTime: Number(dbBet.targetTime ?? 0),
          placedAt: dbBet.createdAt.getTime(),
          status: dbBet.status as ServerBet['status'],
          isPlayMode: dbBet.isPlayMode,
        });
      }

      if (betsToRefund.length === 0) {
        // Best-effort fallback to in-memory state in case the DB query failed.
        betsToRefund.push(
          ...Array.from(this.state.activeBets.values()).filter(
            (b) => b.status === 'PENDING' || b.status === 'SETTLING'
          )
        );
      }

      let refundedBets = 0;
      for (const bet of betsToRefund) {
        if (await this.refundBet(bet, reason)) {
          refundedBets += 1;
        }
      }

      const cancelled = await this.prisma.round.updateMany({
        where: { id: roundId, status: 'SETTLING' },
        data: {
          status: 'CANCELLED',
          endedAt: new Date(),
        },
      });

      if (cancelled.count !== 1) {
        console.warn(`[GameEngine] Round ${roundId} status transition SETTLING->CANCELLED did not apply`);
      }

      this.emit('round:cancelled', {
        roundId,
        reason,
        refundedBets,
      });

      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
        await this.redis.del(this.riskManager.buildReservedExpectedPayoutKey(roundId));
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      console.log(`[GameEngine] Round ${roundId} cancelled, ${refundedBets} bets refunded`);
    } finally {
      try {
        await this.lockManager.releaseRoundLock(this.config.asset);
      } catch (error) {
        console.error(`[GameEngine] Failed to release round lock:`, error);
      }

      this.cleanup();
    }
  }

  private async refundBet(bet: ServerBet, reason: string): Promise<boolean> {
    const settledAt = new Date();
    const roundId = this.state?.roundId;
    const statusBefore = bet.status;

    const didRefund = await this.prisma.$transaction(async (tx) => {
      // Idempotency: only refund if bet is still pending/settling
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: { in: ['PENDING', 'SETTLING'] } },
        data: {
          status: 'REFUNDED',
          settledAt,
        },
      });

      if (updated.count !== 1) return false;

      // Refund via FinancialService ledger entry
      await this.financialService.changeBalance(
        {
          userId: bet.userId,
          amount: bet.amount,
          type: 'REFUND',
          isPlayMode: bet.isPlayMode,
          relatedBetId: bet.id,
          remark: `Refund bet ${bet.id}${roundId ? ` (round ${roundId})` : ''}: ${reason}`,
        },
        tx
      );

      if (!bet.isPlayMode) {
        await this.housePoolService.applyDelta(
          { asset: this.config.asset, amount: -bet.amount },
          tx
        );
      }

      return true;
    });

    if (!didRefund) {
      console.log(`[GameEngine] Bet ${bet.id} already refunded/settled, skipping`);
      return false;
    }

    if (statusBefore === 'PENDING') {
      this.decrementUserPendingBetCount(bet.userId);
    }

    bet.status = 'REFUNDED';

    if (!bet.isPlayMode && roundId) {
      await this.releaseExpectedPayoutReservation(roundId, bet.orderId);
    }

    this.emit('bet:refunded', {
      betId: bet.id,
      orderId: bet.orderId,
      userId: bet.userId,
      amount: bet.amount,
      reason,
    });

    return true;
  }

  // ========== Betting ==========

  /**
   * 创建一笔下注（会扣款并写入 DB/Redis），并返回 betId 与 multiplier
   */
  async placeBet(userId: string, request: PlaceBetRequest): Promise<PlaceBetResponse> {
    // 1. Validate there is an active betting round
    if (!this.state) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '鐟滅増鎸告晶鐘测柦閳╁啯绠掗弶鈺傜椤㈡垶绋夐鐘崇暠闁搞儳鍋涢??');
    }

    if (this.state.status !== 'BETTING') {
      throw new GameError(ERROR_CODES.BETTING_CLOSED, '鐟滅増鎸告晶鐘崇▔瀹ュ懎璁查柟鑸垫礃閺?');
    }

    // 2. Validate user status / anonymous constraints
    const isAnonymous = userId.startsWith('anon-');
    if (!isAnonymous) {
      const userStatus = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { active: true, silenced: true },
      });

      if (!userStatus) {
        throw new GameError(ERROR_CODES.USER_NOT_FOUND, '用户不存在');
      }

      if (!userStatus.active) {
        throw new GameError(ERROR_CODES.USER_BANNED, '账号已被封禁');
      }

      if (userStatus.silenced) {
        throw new GameError(ERROR_CODES.USER_SILENCED, '账号已被禁言');
      }
    }

    if (isAnonymous && !request.isPlayMode) {
      throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '闁告牕鐏濋幃鏇㈡偨閵婏箑鐓曢柛娆樹海閸忔ɑ鎷呯捄銊︽殢婵炴挸鎽滅敮鍝勎熼垾宕囩??');
    }

    const roundId = this.state.roundId;

    const maxActiveBets = parseInt(process.env.MAX_ACTIVE_BETS ?? '10000', 10);
    if (this.state.activeBets.size >= maxActiveBets) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '缂侇垵宕电划娲箮閺囩喐鏆堥柡浣峰嵆閸ｅ搫顔忛懠鑸靛涧濞戞挸锕娲晬瀹€鍐惧殲缂佸绉撮幃妤呭礃瀹ュ牏妲?');
    }

    // 3. Rate limiting
    if (!(await this.checkRateLimit(userId))) {
      throw new GameError(
        ERROR_CODES.RATE_LIMITED,
        `闁硅埖娲橀弫鐐存交閸ワ妇鑹惧Λ鐗堝灩缁犳帡鏁嶇仦鍓фЖ缂佸甯楀〒鑸靛緞?${this.config.maxBetsPerSecond} 婵炲棭鎽?`
      );
    }

    // 4. Validate target time
    const minTargetTime = this.state.elapsed + MIN_TARGET_TIME_OFFSET;
    if (request.targetTime <= minTargetTime) {
      throw new GameError(ERROR_CODES.TARGET_TIME_PASSED, '闁烩晩鍠楅悥锝夊籍閸洘锛熺€规瓕灏换鍐箣閺嵮佷喊閺?');
    }

    // Validate target time within round duration
    if (request.targetTime > this.config.maxDuration) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝夊籍閸洘锛熷☉鎾崇Х閸忔鎼鹃崨鎵畺 ${this.config.maxDuration} 缂佸濡?`);
    }

    // 5. Validate bet amount
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `闁硅埖娲橀弫鐐烘煂閹达富鏉洪梻鍥ｅ亾闁?${this.config.minBetAmount}-${this.config.maxBetAmount} 濞戞柨顑夊Λ绺?`
      );
    }

    // Validate money amount format
    if (request.amount <= 0 || !Number.isFinite(request.amount) || !isValidMoneyAmount(request.amount)) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁硅埖娲橀弫鐐烘煂閹达富鏉洪煫鍥ф嚇閵嗗繑绋夐悜姗嗗妧闁?');
    }

    // 6. Validate target row
    if (!Number.isFinite(request.targetRow) || request.targetRow < 0 || request.targetRow > MAX_ROW_INDEX) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝囨偘瀹€鈧崒銊ヮ嚕閺囩偟绠戝銈堫嚙濠??0-${MAX_ROW_INDEX} 濞戞柨顑夊Λ绺?`);
    }

    // 7. Enforce per-user max pending bets
    const userBetCount = this.getUserPendingBetCount(userId);
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '鐎规瓕灏幓顏堝礆閻楀牊浠樺鍫嗗嫬顫屾繛澶堝妽閺嗙喖??');
    }

    // 8. Calculate multiplier
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁哄啰濮甸弲銉╂儍閸曨偀鍋撳鍥ц??');
    }

    // 9. Validate orderId
    if (!request.orderId || typeof request.orderId !== 'string' || request.orderId.trim() === '') {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '閻犱降鍨瑰畷鐑瓺濞戞挸绉烽崗妯荤▔閾忓厜??');
    }

    const orderId = request.orderId;
    const duplicateOrderMessage = 'Order ID already used';
    const buildBetResponse = (bet: { id: string; multiplier: unknown; targetTime?: unknown; targetRow?: unknown }) => ({
      betId: bet.id,
      multiplier: Number(bet.multiplier),
      targetTime: Number(bet.targetTime ?? 0),
      targetRow: Number(bet.targetRow ?? 0),
    });
    const assertBetOwnership = (bet: { userId: string }) => {
      if (bet.userId !== userId) {
        console.warn(`[GameEngine] Order ID ${orderId} belongs to different user`);
        throw new GameError(ERROR_CODES.DUPLICATE_BET, duplicateOrderMessage);
      }
    };
    const isUniqueConstraintError = (err: unknown): boolean => {
      return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002');
    };

    // 10. Idempotency: handle duplicate orderId
    const existingBet = await this.prisma.bet.findUnique({
      where: { orderId },
    });

    if (existingBet) {
      assertBetOwnership(existingBet);
      this.maybeTrackExistingDbBet(existingBet, orderId);
      console.log(`[GameEngine] Duplicate bet request: ${orderId}`);
      return buildBetResponse(existingBet);
    }

    // 11. Acquire bet lock (Redis best-effort)
    let lockAcquired = false;
    let betLockToken: string | null = null;
    let redisDegraded = false;
    let payoutReservation: Awaited<ReturnType<RiskManager['reserveExpectedPayout']>> | null = null;
    const riskTtlMs = (this.config.maxDuration + 60) * 1000;
    let betCreated = false;

    try {
      betLockToken = await this.lockManager.acquireBetLock(orderId, 30000);
      lockAcquired = Boolean(betLockToken);
      if (lockAcquired) {
        console.log(`[GameEngine] Redis lock acquired for order ${orderId}`);
      } else {
        console.warn(`[GameEngine] Redis lock busy for order ${orderId}, proceeding with DB idempotency gate`);
      }
    } catch (error) {
      redisDegraded = true;
      console.warn(`[GameEngine] Redis lock unavailable for order ${orderId}, proceeding with DB idempotency gate`, error);
    }

    const releaseLock = async () => {
      if (!betLockToken) return;
      try {
        const released = await this.lockManager.releaseBetLock(orderId, betLockToken);
        if (!released) {
          console.warn(
            `[GameEngine] Bet lock release skipped for order ${orderId} (token expired or replaced)`
          );
        }
      } catch (releaseError) {
        console.error(`[GameEngine] Failed to release bet lock for order ${orderId}:`, releaseError);
      }
    };

    try {
      if (!request.isPlayMode) {
        const poolBalance = await this.getPoolBalance();
        const maxRoundPayout = this.riskManager.getMaxRoundPayout(poolBalance);
        const projectedPayout = this.riskManager.calculateProjectedPayout(request.amount, multiplier);
        // House pool already receives the stake amount on bet placement, so the incremental liability we
        // need to reserve is the net payout (gross payout - stake).
        const expectedPayout = roundMoney(Math.max(0, projectedPayout - request.amount));

        payoutReservation = await this.riskManager.reserveExpectedPayout({
          redis: this.redis,
          roundId,
          orderId,
          expectedPayout,
          maxRoundPayout,
          ttlMs: riskTtlMs,
        });

        if (!payoutReservation.allowed) {
          throw new GameError(ERROR_CODES.INVALID_AMOUNT, 'Bet exceeds risk limits');
        }
      }

      const bet = await this.prisma.$transaction(async (tx) => {
        const currentRound = await tx.round.findUnique({
          where: { id: roundId },
          select: { status: true },
        });

        if (!currentRound || currentRound.status !== 'BETTING') {
          throw new GameError(ERROR_CODES.BETTING_CLOSED, '闁搞儳鍋涢幃搴☆啅閹绘帒褰犻梻鍌ゅ幗閸ㄣ劍绋夊鍛憼闁?');
        }


        // Create bet first so we can reliably attach relatedBetId for the BET transaction.
        const newBet = await tx.bet.create({
          data: {
            userId,
            roundId,
            orderId: request.orderId,
            amount: request.amount,
            multiplier,
            rowIndex: Math.round(request.targetRow),
            colIndex: Math.round(request.targetTime),
            targetRow: request.targetRow,
            targetTime: request.targetTime,
            asset: this.config.asset,
            isPlayMode: request.isPlayMode ?? false,
            status: 'PENDING',
          },
        });

        if (!isAnonymous) {
          const result = await this.financialService.conditionalChangeBalance(
            {
              userId,
              amount: -request.amount,
              type: 'BET',
              isPlayMode: request.isPlayMode,
              minBalance: request.amount,
              relatedBetId: newBet.id,
              remark: `闁硅埖娲橀??${this.config.asset} 闁搞儳鍋涢幃?${roundId}`,
            },
            tx
          );

          if (!result.success) {
            throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, result.error || '濞达絾鐟╅·鍌涚▔瀹ュ牆鍠?');
          }

        }

        if (!request.isPlayMode) {
          await this.housePoolService.applyDelta(
            { asset: this.config.asset, amount: request.amount },
            tx
          );
        }

        return newBet;
      });

      betCreated = true;

      const serverBet: ServerBet = {
        id: bet.id,
        orderId: request.orderId,
        userId,
        amount: request.amount,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        placedAt: Date.now(),
        status: 'PENDING',
        isPlayMode: request.isPlayMode ?? false,
      };

      this.trackActiveBet(serverBet, { pushToHeap: true });

      setImmediate(() => {
        if (!this.state || this.state.roundId !== roundId) return;

        this.redis
          .zadd(
            `${REDIS_KEYS.ACTIVE_BETS}${roundId}`,
            request.targetTime,
            JSON.stringify(serverBet)
          )
          .catch((err) => console.error('[GameEngine] Redis sync failed:', err));
      });

      let newBalance = 0;
      if (!isAnonymous) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { balance: true, playBalance: true },
        });
        newBalance = request.isPlayMode
          ? Number(user?.playBalance ?? 0)
          : Number(user?.balance ?? 0);
      }

      this.emit('bet:confirmed', {
        userId,
        orderId: request.orderId,
        betId: bet.id,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        amount: request.amount,
        newBalance,
      });

      console.log(`[GameEngine] Bet ${bet.id} placed by ${userId}`);

      return {
        betId: bet.id,
        multiplier,
        targetTime: request.targetTime,
        targetRow: request.targetRow,
      };
    } catch (error) {
      await releaseLock();

      if (isUniqueConstraintError(error)) {
        const conflictingBet = await this.prisma.bet.findUnique({
          where: { orderId },
        });

        if (conflictingBet) {
          assertBetOwnership(conflictingBet);
          this.maybeTrackExistingDbBet(conflictingBet, orderId);
          if (redisDegraded) {
            console.warn(
              `[GameEngine] Redis degraded; DB unique constraint hit for order ${orderId}, returning existing bet`
            );
          } else if (!lockAcquired) {
            console.warn(
              `[GameEngine] Redis lock busy; DB unique constraint hit for order ${orderId}, returning existing bet`
            );
          } else {
            console.log(`[GameEngine] DB unique constraint hit for order ${orderId}, returning existing bet`);
          }
          return buildBetResponse(conflictingBet);
        }

        console.warn(`[GameEngine] DB unique constraint hit but bet not found for order ${orderId}`);
      }

      if (payoutReservation?.didReserve && !betCreated && !request.isPlayMode) {
        await this.releaseExpectedPayoutReservation(roundId, orderId);
      }

      throw error;
    }
  }

  /**
   * 释放风控预留的预期赔付（best-effort）
   */
  private async releaseExpectedPayoutReservation(roundId: string, orderId: string): Promise<void> {
    try {
      await this.riskManager.releaseExpectedPayout({
        redis: this.redis,
        roundId,
        orderId,
        ttlMs: (this.config.maxDuration + 60) * 1000,
      });
    } catch (error) {
      console.error(
        `[GameEngine] Failed to release expected payout reservation for order ${orderId} (round ${roundId}):`,
        error
      );
    }
  }

  private async handleBetSettled(payload: {
    betId: string;
    orderId: string;
    userId: string;
    isWin: boolean;
    payout: number;
    hitDetails?: unknown;
  }): Promise<void> {
    const roundId = this.state?.roundId;
    if (roundId) {
      await this.releaseExpectedPayoutReservation(roundId, payload.orderId);
    }

    this.emit('bet:settled', payload);
  }

  private syncPendingBetCounts(): void {
    if (!this.state) {
      this.pendingBetCountsByUser.clear();
      this.pendingBetCountsRoundId = null;
      this.pendingBetCountsActiveBetsSize = 0;
      return;
    }

    const roundId = this.state.roundId;
    const activeBetsSize = this.state.activeBets.size;

    if (this.pendingBetCountsRoundId === roundId && this.pendingBetCountsActiveBetsSize === activeBetsSize) {
      return;
    }

    this.pendingBetCountsByUser.clear();
    for (const bet of this.state.activeBets.values()) {
      if (bet.status !== 'PENDING') continue;
      this.pendingBetCountsByUser.set(bet.userId, (this.pendingBetCountsByUser.get(bet.userId) ?? 0) + 1);
    }

    this.pendingBetCountsRoundId = roundId;
    this.pendingBetCountsActiveBetsSize = activeBetsSize;
  }

  private getUserPendingBetCount(userId: string): number {
    this.syncPendingBetCounts();
    return this.pendingBetCountsByUser.get(userId) ?? 0;
  }

  private incrementUserPendingBetCount(userId: string): void {
    if (!this.state) return;
    this.syncPendingBetCounts();
    this.pendingBetCountsByUser.set(userId, (this.pendingBetCountsByUser.get(userId) ?? 0) + 1);
  }

  private decrementUserPendingBetCount(userId: string): void {
    if (!this.state) return;
    this.syncPendingBetCounts();
    const current = this.pendingBetCountsByUser.get(userId) ?? 0;
    if (current <= 1) {
      this.pendingBetCountsByUser.delete(userId);
      return;
    }
    this.pendingBetCountsByUser.set(userId, current - 1);
  }

  private trackActiveBet(bet: ServerBet, options: { pushToHeap?: boolean } = {}): void {
    if (!this.state) return;

    this.syncPendingBetCounts();

    const existing = this.state.activeBets.get(bet.id);
    if (existing) {
      if (options.pushToHeap && existing.status === 'PENDING' && !this.betHeap.some((b) => b.id === existing.id)) {
        this.heapPush(existing);
      }
      return;
    }

    this.state.activeBets.set(bet.id, bet);
    this.pendingBetCountsActiveBetsSize = this.state.activeBets.size;

    if (bet.status === 'PENDING') {
      this.incrementUserPendingBetCount(bet.userId);
      if (options.pushToHeap && !this.betHeap.some((b) => b.id === bet.id)) {
        this.heapPush(bet);
      }
    }
  }

  private maybeTrackExistingDbBet(dbBet: unknown, fallbackOrderId: string): void {
    if (!this.state || !dbBet || typeof dbBet !== 'object') return;

    const raw = dbBet as {
      id?: unknown;
      orderId?: unknown;
      userId?: unknown;
      roundId?: unknown;
      amount?: unknown;
      multiplier?: unknown;
      targetRow?: unknown;
      targetTime?: unknown;
      status?: unknown;
      isPlayMode?: unknown;
      createdAt?: unknown;
    };

    if (typeof raw.id !== 'string' || typeof raw.userId !== 'string') return;

    const roundId = typeof raw.roundId === 'string' ? raw.roundId : null;
    if (!roundId || roundId !== this.state.roundId) return;

    const status = typeof raw.status === 'string' ? raw.status : null;
    if (status !== 'PENDING' && status !== 'SETTLING') return;

    const orderId =
      typeof raw.orderId === 'string' && raw.orderId.trim() !== '' ? raw.orderId : fallbackOrderId;

    const serverBet: ServerBet = {
      id: raw.id,
      orderId,
      userId: raw.userId,
      amount: Number(raw.amount ?? 0),
      multiplier: Number(raw.multiplier ?? 0),
      targetRow: Number(raw.targetRow ?? 0),
      targetTime: Number(raw.targetTime ?? 0),
      placedAt: raw.createdAt instanceof Date ? raw.createdAt.getTime() : Date.now(),
      status: status as ServerBet['status'],
      isPlayMode: Boolean(raw.isPlayMode),
    };

    this.trackActiveBet(serverBet, { pushToHeap: serverBet.status === 'PENDING' });
  }

  private async checkRateLimit(userId: string): Promise<boolean> {
    const configuredWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10);
    const windowMs = Number.isFinite(configuredWindowMs) && configuredWindowMs > 0 ? configuredWindowMs : 1000;
    return allowSlidingWindowRequest({
      redis: this.redis,
      key: buildRateLimitKey(userId),
      windowMs,
      maxRequests: this.config.maxBetsPerSecond,
    });
  }

  // ========== Tick Loop ==========

  private startTickLoop(): void {
    this.tickTimer = setInterval(() => this.tick(), this.config.tickInterval);
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Tick：更新 elapsed/price/row，并把到期下注推入结算队列
   */
  private tick(): void {
    if (!this.state || this.state.status === 'SETTLING' || this.state.status === 'COMPLETED') {
      return;
    }

    const now = Date.now();
    this.state.elapsed = (now - this.state.roundStartTime) / 1000;

    if (this.priceCache) {
      this.state.currentPrice = this.priceCache.price;
      this.state.currentRow = calculateRowIndex(this.priceCache.price, this.state.startPrice);
    }

    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: SettlementItem[] = [];
    let settledCount = 0;

    while (this.betHeap.length > 0) {
      if (settledCount >= MAX_SETTLEMENTS_PER_TICK) {
        // [Protection] Stop processing for this tick to prevent event loop starvation
        break;
      }

      const bet = this.betHeap[0];

      if (bet.targetTime > this.state.elapsed + HIT_TIME_TOLERANCE) break;

      if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        this.heapPop();
        if (bet.status === 'PENDING') {
          toSettle.push({ bet, isWin: false });
          this.decrementUserPendingBetCount(bet.userId);
          bet.status = 'SETTLING';
          settledCount++;
        }
        continue;
      }

      const timeDiff = Math.abs(this.state.elapsed - bet.targetTime);
      if (timeDiff <= HIT_TIME_TOLERANCE) {
        const minRow = Math.min(prevRow, this.state.currentRow) - this.config.hitTolerance;
        const maxRow = Math.max(prevRow, this.state.currentRow) + this.config.hitTolerance;

        if (bet.targetRow >= minRow && bet.targetRow <= maxRow) {
          this.heapPop();
          if (bet.status === 'PENDING') {
            toSettle.push({
              bet,
              isWin: true,
              hitDetails: {
                hitPrice: this.state.currentPrice,
                hitRow: this.state.currentRow,
                hitTime: this.state.elapsed,
              },
            });
            this.decrementUserPendingBetCount(bet.userId);
            bet.status = 'SETTLING';
            settledCount++;
          }
          continue;
        }
      }

      break;
    }

    this.state.prevRow = this.state.currentRow;

    if (toSettle.length > 0) {
      this.settlementService.enqueue(toSettle);
    }

    this.snapshotService.bufferSnapshot({
      roundId: this.state.roundId,
      elapsed: this.state.elapsed,
      roundStartTime: this.state.roundStartTime,
      currentPrice: this.state.currentPrice,
      currentRow: this.state.currentRow,
    });

    this.emitThrottled('state:update', {
      elapsed: this.state.elapsed,
      currentPrice: this.state.currentPrice,
      currentRow: this.state.currentRow,
    });

    if (this.state.elapsed >= this.config.maxDuration) {
      const roundId = this.state.roundId;
      setImmediate(() => {
        if (!this.state || this.state.roundId !== roundId) return;
        void this.endRound('timeout').catch((error) => {
          console.error('[GameEngine] endRound failed:', error);
        });
      });
    }
  }
  private settleAllPendingBets(): void {
    const toSettle: SettlementItem[] = [];
    while (this.betHeap.length > 0) {
      const bet = this.heapPop()!;
      if (bet.status !== 'PENDING') continue;

      const timeDiff = Math.abs(this.state!.elapsed - bet.targetTime);
      const rowDiff = Math.abs(this.state!.currentRow - bet.targetRow);
      const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;

      this.decrementUserPendingBetCount(bet.userId);
      bet.status = 'SETTLING';

      toSettle.push({
        bet,
        isWin,
        hitDetails: isWin
          ? {
            hitPrice: this.state!.currentPrice,
            hitRow: this.state!.currentRow,
            hitTime: this.state!.elapsed,
          }
          : undefined,
      });
    }

    if (toSettle.length > 0) {
      this.settlementService.enqueue(toSettle);
    }
  }


  // ========== Internal Helpers ==========

  /**
   * 节流事件发送（同事件在 intervalMs 内最多发送一次）
   */
  private emitThrottled(event: string, data: unknown, intervalMs = 50): void {
    const now = Date.now();
    const lastEmit = this.lastEmitTimes.get(event) || 0;

    if (now - lastEmit >= intervalMs) {
      this.emit(event, data);
      this.lastEmitTimes.set(event, now);
    }
  }

  /**
   * 同步当前回合状态到 Redis
   */
  private async syncStateToRedis(): Promise<void> {
    if (!this.state) return;

    await this.redis.hset(`${REDIS_KEYS.ROUND_STATE}${this.state.asset}`, {
      id: this.state.roundId,
      status: this.state.status,
      startPrice: this.state.startPrice.toString(),
      currentRow: this.state.currentRow.toString(),
      elapsed: this.state.elapsed.toString(),
    });
  }

  /**
   * 解析资金池初始余额（来自环境变量）
   */
  private resolveInitialPoolBalance(): number {
    const envBalance = process.env.HOUSE_POOL_BALANCE ?? process.env.GAME_POOL_BALANCE ?? '100000';
    const parsed = Number(envBalance);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private async getPoolBalance(): Promise<number> {
    const asset = this.config.asset;
    try {
      const balance = await this.housePoolService.getBalance(asset);
      if (balance !== null) return balance;
      return await this.housePoolService.initialize(asset, this.resolveInitialPoolBalance());
    } catch (error) {
      console.error(`[GameEngine] Failed to resolve house pool balance for ${asset}:`, error);
      return 0;
    }
  }

  private calculateRoundStats(): {
    totalBets: number;
    totalWins: number;
    totalVolume: number;
    totalPayout: number;
  } {
    const bets = Array.from(this.state!.activeBets.values()).filter((bet) => !bet.isPlayMode);
    return {
      totalBets: bets.length,
      totalWins: bets.filter((b) => b.status === 'WON').length,
      totalVolume: bets.reduce((sum, b) => sum + b.amount, 0),
      totalPayout: bets
        .filter((b) => b.status === 'WON')
        .reduce((sum, b) => sum + this.settlementService.calculatePayout(b.amount, b.multiplier, true), 0),
    };
  }

  /**
   * 价格源不可用时的处理（取消回合）
   */
  private handlePriceUnavailable(): void {
    if (this.state && (this.state.status === 'RUNNING' || this.state.status === 'BETTING')) {
      console.warn('[GameEngine] Price unavailable, cancelling round...');
      this.cancelRound('濞寸娀鏀遍悧鎼佸嫉瀹ュ懎顫ゅ☉鎾崇Т瑜版煡鎮?').catch(console.error);
    }
  }

  /**
   * 清理内存状态
   */
  private cleanup(): void {
    this.state = null;
    this.snapshotService.resetBuffer();
    this.settlementService.resetQueue();
    this.betHeap = [];
    this.pendingBetCountsByUser.clear();
    this.pendingBetCountsRoundId = null;
    this.pendingBetCountsActiveBetsSize = 0;
  }

  // ========== Bet Heap (by targetTime) ==========

  /**
   * 将 bet 放入最小堆（按 targetTime）
   */
  private heapPush(bet: ServerBet): void {
    this.betHeap.push(bet);
    this.heapifyUp(this.betHeap.length - 1);
  }

  /**
   * 弹出 targetTime 最小的 bet
   */
  private heapPop(): ServerBet | undefined {
    if (this.betHeap.length === 0) return undefined;
    if (this.betHeap.length === 1) return this.betHeap.pop();

    const top = this.betHeap[0];
    this.betHeap[0] = this.betHeap.pop()!;
    this.heapifyDown(0);
    return top;
  }

  /**
   * 最小堆上浮
   */
  private heapifyUp(idx: number): void {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.betHeap[idx].targetTime >= this.betHeap[parent].targetTime) break;
      [this.betHeap[idx], this.betHeap[parent]] = [this.betHeap[parent], this.betHeap[idx]];
      idx = parent;
    }
  }

  /**
   * 最小堆下沉
   */
  private heapifyDown(idx: number): void {
    const len = this.betHeap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < len && this.betHeap[left].targetTime < this.betHeap[smallest].targetTime) {
        smallest = left;
      }
      if (right < len && this.betHeap[right].targetTime < this.betHeap[smallest].targetTime) {
        smallest = right;
      }
      if (smallest === idx) break;

      [this.betHeap[idx], this.betHeap[smallest]] = [this.betHeap[smallest], this.betHeap[idx]];
      idx = smallest;
    }
  }

  /**
   * 停止引擎（停止 tick/自动回合，并取消当前回合）
   */
  async stop(): Promise<void> {
    this.stopTickLoop();
    this.stopAutoRound();

    if (this.state) {
      await this.cancelRound('鐎殿喗娲橀幖鎼佸磻濠婂嫷鍓?');
    }

    this.settlementService.dispose();

    console.log('[GameEngine] Stopped');
  }

  // ========== Auto-Round ==========

  private autoRoundTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRoundEnabled = false;
  private boundScheduleNextRound: ((delayMs: number) => void) | null = null;

  /**
   * 启用自动开局（回合结束/取消后自动调度下一回合）
   */
  startAutoRound(delayMs = 3000): void {
    if (this.autoRoundEnabled) return;

    this.autoRoundEnabled = true;
    console.log('[GameEngine] Auto-round enabled');

    // Bind handler for auto-round scheduling
    this.boundScheduleNextRound = () => this.scheduleNextRound(delayMs);

    // Re-schedule after round end/cancel
    this.on('round:end', this.boundScheduleNextRound);
    this.on('round:cancelled', this.boundScheduleNextRound);

    // Start the first round soon
    this.scheduleNextRound(1000);
  }

  /**
   * 关闭自动开局
   */
  stopAutoRound(): void {
    this.autoRoundEnabled = false;

    if (this.autoRoundTimer) {
      clearTimeout(this.autoRoundTimer);
      this.autoRoundTimer = null;
    }

    // Remove auto-round listeners
    if (this.boundScheduleNextRound) {
      this.off('round:end', this.boundScheduleNextRound);
      this.off('round:cancelled', this.boundScheduleNextRound);
      this.boundScheduleNextRound = null;
    }

    console.log('[GameEngine] Auto-round disabled');
  }

  /**
   * 调度下一回合（自动开局）
   */
  private scheduleNextRound(delayMs: number): void {
    if (!this.autoRoundEnabled) return;

    console.log(`[GameEngine] Next round in ${delayMs}ms`);

    this.autoRoundTimer = setTimeout(async () => {
      if (!this.autoRoundEnabled) return;

      try {
        await this.startRound();
      } catch (error) {
        console.error('[GameEngine] Failed to start next round:', error);
        // Backoff and retry
        this.scheduleNextRound(5000);
      }
    }, delayMs);
  }
}



