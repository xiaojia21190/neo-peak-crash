/**
 * 婵炴挸鎲￠崹娆忣嚕閺囩喐鎯涢柡宥囶焾缁哄墽鐚?
 * 缂佺媴绱曢幃濠囧炊閻愬弶鍊ら柣銏㈠枎閹筹繝宕ㄩ妸锔藉焸闁靛棔鐒︽慨鍥р枖閵娿儺妲遍柣鐐叉閳ь兛鑳堕～顐﹀箻閻愭惌姊炬繛鏉戭儏閹锋壆绱掗幘鍓佹??
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
} from './constants';
import {
  calculateRowIndex,
  calculateMultiplier,
} from './utils';
import { isValidMoneyAmount } from '../shared/gameMath';
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





  private lastEmitTimes: Map<string, number> = new Map();

  // 濞寸娀鏀遍悧鍝ョ磽閹惧磭??
  private priceCache: PriceUpdate | null = null;

  // 闁告帒妫楃粩宄邦嚕韫囨稒??
  private lockManager: LockManager;

  // 閻犳劑鍨规慨鐔煎嫉瀹ュ懎顫ら柨娑樼墕瀹曠喐绋夐埀顒勬嚂瀹€鍐厬闁挎稒纰嶆晶宥夊嫉婢跺绋囧Λ鐗堢箓瑜板宕濋…鎺旂
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
        onBetSettled: (payload) => this.emit('bet:settled', payload),
      },
    });

    // 闁烩晜鍨甸幆澶嬬闁垮澹愰柡鍥х摠閺?
    this.priceService.on('price', (price: PriceUpdate) => {
      this.priceCache = price;
    });

    // 闁烩晜鍨甸幆澶嬬闁垮澹愬☉鎾崇Т瑜版煡??
    this.priceService.on('price_critical', () => {
      this.handlePriceUnavailable();
    });
  }

  // ========== 闁稿浚鍓欓崣锟犲棘鐟欏嫮??==========

  /**
   * 闁兼儳鍢茶ぐ鍥亹閹惧啿顤呮繛鎾虫啞閸ㄦ瑩鎮╅懜纰樺??
   */
  getState(): GameState | null {
    return this.state;
  }

  /**
   * 闁兼儳鍢茶ぐ鍥煀瀹ュ洨鏋?
   */
  getConfig(): RoundConfig {
    return { ...this.config };
  }

  /**
   * 闁哄洤鐡ㄩ弻濠冪闁垮澹愮紓鍌涙尭閻°劑鏁嶉崼婊呰繑濠㈣埖鐗犻崕瀵告嫬閸愵亝鏆忛??
   */
  updatePriceCache(price: PriceUpdate): void {
    this.priceCache = price;
  }

  // ========== 闁搞儳鍋涢幃搴ㄦ偨閻旈攱鍤掗柛娑栧妽濠€?==========

  /**
   * 鐎殿喒鍋撳┑顔碱儐閺屽﹪宕堕悙鍙夊€?
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
   * 缂備焦鎸诲顐﹀炊閻愬弶??
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

      await this.prisma.round
        .updateMany({
          where: { id: roundId, status: { in: ['BETTING', 'RUNNING'] } },
          data: { status: 'SETTLING' },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to persist SETTLING status for cancelled round ${roundId}:`, error);
        });

      const pendingBets = Array.from(this.state.activeBets.values()).filter(
        (b) => b.status === 'PENDING'
      );

      for (const bet of pendingBets) {
        await this.refundBet(bet, reason);
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
        refundedBets: pendingBets.length,
      });

      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      console.log(`[GameEngine] Round ${roundId} cancelled, ${pendingBets.length} bets refunded`);
    } finally {
      try {
        await this.lockManager.releaseRoundLock(this.config.asset);
      } catch (error) {
        console.error(`[GameEngine] Failed to release round lock:`, error);
      }

      this.cleanup();
    }
  }

  private async refundBet(bet: ServerBet, reason: string): Promise<void> {
    const settledAt = new Date();
    const roundId = this.state?.roundId;

    const didRefund = await this.prisma.$transaction(async (tx) => {
      // 濞达綀娉曢??updateMany 閻庡湱鍋熼獮鍥嵁閸屾粎鎼奸柨娑欒壘瑜把囧即鐎涙ɑ鐓€ PENDING 闁绘鍩栭埀顑胯兌濞堟垵鈻旈妸銉ョ
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: 'PENDING' },
        data: {
          status: 'REFUNDED',
          settledAt,
        },
      });

      if (updated.count !== 1) return false;

      // 濞达綀娉曢??FinancialService 濠㈣泛瀚幃濠囨焻閳ь剙鈻庨幘鍛闁煎浜滄慨鈺冩媼閺夎法绉挎繛缈犵劍閹稿鏁?
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
      return;
    }

    bet.status = 'REFUNDED';

    this.emit('bet:refunded', {
      betId: bet.id,
      orderId: bet.orderId,
      userId: bet.userId,
      amount: bet.amount,
      reason,
    });
  }

  // ========== 闁硅埖娲橀弫鐐村緞閸曨厽鍊?==========

  /**
   * 濞戞挸顑嗛弫?
   */
  async placeBet(userId: string, request: PlaceBetRequest): Promise<PlaceBetResponse> {
    // 1. 闁绘鍩栭埀顑跨劍椤ュ懘??
    if (!this.state) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '鐟滅増鎸告晶鐘测柦閳╁啯绠掗弶鈺傜椤㈡垶绋夐鐘崇暠闁搞儳鍋涢??');
    }

    if (this.state.status !== 'BETTING') {
      throw new GameError(ERROR_CODES.BETTING_CLOSED, '鐟滅増鎸告晶鐘崇▔瀹ュ懎璁查柟鑸垫礃閺?');
    }

    // 2. 闁哄牃鍋撳鍫嗗嫭銇熼悹鍝勫暞婵洤鈻旈妸鈺傤€欓柛?
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

    // 3. 闁硅埖娲橀弫鐐达紣閹寸姴鑺抽梻鍕姇閸?
    if (!(await this.checkRateLimit(userId))) {
      throw new GameError(
        ERROR_CODES.RATE_LIMITED,
        `闁硅埖娲橀弫鐐存交閸ワ妇鑹惧Λ鐗堝灩缁犳帡鏁嶇仦鍓фЖ缂佸甯楀〒鑸靛緞?${this.config.maxBetsPerSecond} 婵炲棭鎽?`
      );
    }

    // 3. 闁哄啫鐖煎Λ鍨涢埀顒勫??
    const minTargetTime = this.state.elapsed + MIN_TARGET_TIME_OFFSET;
    if (request.targetTime <= minTargetTime) {
      throw new GameError(ERROR_CODES.TARGET_TIME_PASSED, '闁烩晩鍠楅悥锝夊籍閸洘锛熺€规瓕灏换鍐箣閺嵮佷喊閺?');
    }

    // 缁绢収鍠曠换姘舵儎椤旂晫鍨奸柡鍐ㄧ埣濡寧绋夊鍫⑿㈤弶鈺佹搐濞叉牠宕ラ崼鐔镐粯濠㈠爢鍕槯闂傗??
    if (request.targetTime > this.config.maxDuration) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝夊籍閸洘锛熷☉鎾崇Х閸忔鎼鹃崨鎵畺 ${this.config.maxDuration} 缂佸濡?`);
    }

    // 4. 闂佸弶鍨块·鍌毼涢埀顒勫??
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `闁硅埖娲橀弫鐐烘煂閹达富鏉洪梻鍥ｅ亾闁?${this.config.minBetAmount}-${this.config.maxBetAmount} 濞戞柨顑夊Λ绺?`
      );
    }

    // 缁绢収鍠曠换姘舵煂閹达富鏉哄☉鎾跺劋椤掓粓寮?
    if (request.amount <= 0 || !Number.isFinite(request.amount) || !isValidMoneyAmount(request.amount)) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁硅埖娲橀弫鐐烘煂閹达富鏉洪煫鍥ф嚇閵嗗繑绋夐悜姗嗗妧闁?');
    }

    // 5. 闁烩晩鍠楅悥锝囨偘鐏炵虎姊鹃??
    if (!Number.isFinite(request.targetRow) || request.targetRow < 0 || request.targetRow > MAX_ROW_INDEX) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝囨偘瀹€鈧崒銊ヮ嚕閺囩偟绠戝銈堫嚙濠??0-${MAX_ROW_INDEX} 濞戞柨顑夊Λ绺?`);
    }

    // 6. 闁活潿鍔嶉崺娑㈠箮閺囩喐鏆堥柡浣峰嵆閸ｆ椽姊介幇顒€??
    const userBetCount = Array.from(this.state.activeBets.values()).filter(
      (b) => b.userId === userId && b.status === 'PENDING'
    ).length;
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '鐎规瓕灏幓顏堝礆閻楀牊浠樺鍫嗗嫬顫屾繛澶堝妽閺嗙喖??');
    }

    // 7. 閻犱緤绱曢悾濠氬磹瀹ュ洤鑺?
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁哄啰濮甸弲銉╂儍閸曨偀鍋撳鍥ц??');
    }

    const riskAssessment = this.riskManager.assessBet({
      activeBets: this.state.activeBets.values(),
      poolBalance: await this.getPoolBalance(),
      amount: request.amount,
      multiplier,
      baseMaxBet: this.config.maxBetAmount,
    });

    if (!riskAssessment.allowed || request.amount > riskAssessment.maxBetAllowed) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `Bet amount exceeds current risk limit: ${this.config.minBetAmount}-${riskAssessment.maxBetAllowed}`
      );
    }

    // 8. 閻犱降鍨瑰畷鐑瓺濡ょ姴鐭侀??
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

    // 9. 妤犵偛鍊婚悺鎴﹀箑瑜庨ˉ鍛村蓟閵夘垳绐楅柛蹇撶墛閻擄紕鎷犻。鏅俤erId闁哄嫷鍨伴幆浣割啅閹绘帞鎽犻??
    const existingBet = await this.prisma.bet.findUnique({
      where: { orderId },
    });

    if (existingBet) {
      assertBetOwnership(existingBet);
      console.log(`[GameEngine] Duplicate bet request: ${orderId}`);
      return buildBetResponse(existingBet);
    }

    // 8. 闁告帒妫楃粩宄邦嚕韫囨稒??
    let lockAcquired = false;
    let betLockToken: string | null = null;
    let redisDegraded = false;

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
      // 9. 闁告鍠庨悺娆撳箥閿濆棭??+ 閻犱焦婢樼紞宥夊箮閺囩喐鏆堥柨娑樼墕鐏忓爼宕ュ鍥ㄦ殢闁规挳鏀遍悥鍫曟偝閳哄伆浣割嚕韫囨氨鍎查弶鈺佹处閺嗙喖骞戦鑲╂皑闁瑰灝绉崇紞鏃堟晬?
      const bet = await this.prisma.$transaction(async (tx) => {
        // 闁革负鍔嬬花銊╁礉閳ュ啿鏁跺ù婊冩湰椤愬ジ寮介敓鐘靛矗闁搞儳鍋涢幃搴ㄦ偐閼哥??闂傚啫寮堕娑欑▔瀹稿潱dRound妤犵偠娉涜ぐ?
        const currentRound = await tx.round.findUnique({
          where: { id: roundId },
          select: { status: true },
        });

        if (!currentRound || currentRound.status !== 'BETTING') {
          throw new GameError(ERROR_CODES.BETTING_CLOSED, '闁搞儳鍋涢幃搴☆啅閹绘帒褰犻梻鍌ゅ幗閸ㄣ劍绋夊鍛憼闁?');
        }

        // 闁告牕鐏濋幃鏇㈡偨閵婏箑鐓曢柛娆樹海閸忔ê銆掗崫銉ヨ礋婵☆垪鈧磭纭€闁挎稑鐭侀悜锔芥交閸ワ妇绋囧Λ鐗堢箖椤ュ懘寮?

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

        // 闂傚牏鍋涚亸鍫曞触瀹ュ洦鏆忛柟瀵稿厴濞撳墎鎲版担鐟扳拸婵炲棙鎷濈槐娆愭媴鐠恒劍??FinancialService??
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

        // 闁告帗绋戠紓鎾诲箮閺囩喐鏆堥悹浣规緲缂嶅秹鏁嶉崼婵嗙樁闁告氨骞坮derId??
        return newBet;
      });

      // 9. 婵烇綀顕ф慨鐐哄礆閻楀牊銇熼悹鍝勫暞婵洤鈻旈妸锔炬建
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

      this.state.activeBets.set(bet.id, serverBet);
      this.heapPush(serverBet);

      // 10. 闁告艾鏈鐐哄??Redis闁挎稑鐗嗙槐鎾愁潰閵夘垳绀?
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

      // 11. 闁兼儳鍢茶ぐ鍥嫉閳ь剟寮０浣虹▏濡増绻愮槐娆撳礌閸喗鍊抽柣顫妽閸╂稒娼婚弬鎸庣 0??
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

      // 12. 妤犵偞瀵ч幐閬嶅箮閺囩喐鏆堢痪顓у枦椤撳鏁嶉崼婵嗙樁??userId 闁告粌濂旂紞鎴烇紣濠靛懍绻嗛柟顓у灣閺併倖绂嶆惔锛勬毎闁告碍鍨佃ぐ鍌炴焻娓氬﹦绀?
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
      // 濠㈡儼绮剧憴锕傚籍閸撲胶褰岄柛妤佸▕閸ｆ挳寮ㄦィ鍐╂??
      await releaseLock();

      if (isUniqueConstraintError(error)) {
        const conflictingBet = await this.prisma.bet.findUnique({
          where: { orderId },
        });

        if (conflictingBet) {
          assertBetOwnership(conflictingBet);
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

      throw error;
    }
    // 闁瑰瓨鍔曟慨娑㈠籍閹偊鍞ㄩ梺澶告祰閸ゆ粓鎮為幆鎵畺闁哄牏鍣︾槐婵嬫焼閸喖甯抽梺鎻掔Т椤﹁尙鎷犻柨瀣??
  }

  /**
   * 闁硅埖娲橀弫鐐达紣閹寸姴鑺抽梻鍕姇閸╂螞閳ь剟寮?
   */
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

  // ========== Tick 鐎甸偊浜為獮?==========

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
   * 闁哄秶顭堢缓?Tick 鐎甸偊浜為獮?- 濞达綀娉曢弫銈夊嫉閳ь剛浜歌箛鎾跺灮濞村吋锚??
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

    while (this.betHeap.length > 0) {
      const bet = this.betHeap[0];

      if (bet.targetTime > this.state.elapsed + HIT_TIME_TOLERANCE) break;

      if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        this.heapPop();
        if (bet.status === 'PENDING') {
          toSettle.push({ bet, isWin: false });
          bet.status = 'SETTLING';
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
            bet.status = 'SETTLING';
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


  // ========== 閺夊牆鎳庢慨顏堝棘鐟欏嫮??==========

  /**
   * 缂傚倹鎸搁崯鎸庣闁垮澹愰煫鍥跺亞??
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
   * 闁告艾鏈鐐烘偐閼哥鍋撴担绋跨厒 Redis
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
   * 閻犱緤绱曢悾濠氬炊閻愬弶鍊ょ紓浣哄枙??
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
   * 濠㈣泛瀚幃濠冪闁垮澹愬☉鎾崇Т瑜版煡鎮?
   */
  private handlePriceUnavailable(): void {
    if (this.state && (this.state.status === 'RUNNING' || this.state.status === 'BETTING')) {
      console.warn('[GameEngine] Price unavailable, cancelling round...');
      this.cancelRound('濞寸娀鏀遍悧鎼佸嫉瀹ュ懎顫ゅ☉鎾崇Т瑜版煡鎮?').catch(console.error);
    }
  }

  /**
   * 婵炴挸鎳愰幃濠勬導閸曨剛??
   */
  private cleanup(): void {
    this.state = null;
    this.snapshotService.resetBuffer();
    this.settlementService.resetQueue();
    this.betHeap = [];
  }

  // ========== 闁哄牃鍋撻悘蹇撶箰閻栥垽骞欏鍕▕ ==========

  /**
   * 闁圭粯甯掗崣鍡涘箮閺囩喐鏆堥柛鎺斿濞撳墎浜歌箛鎾跺灮闁挎稑鐗婄??targetTime 闁圭儤甯掔花顓㈡??
   */
  private heapPush(bet: ServerBet): void {
    this.betHeap.push(bet);
    this.heapifyUp(this.betHeap.length - 1);
  }

  /**
   * 鐎殿喚鎳撻崵顓㈠醇閸℃稏鈧﹪骞庨弴鐔告??
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
   * 濞戞挸锕ョ拠鐐哄箼瀹ュ嫮绋?
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
   * 濞戞挸顑嗛惌鍥箼瀹ュ嫮绋?
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
   * 闁稿绮嶉娑橆嚕閺囩喐??
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

  // ========== 闁煎浜滄慨鈺呭炊閻愬弶鍊ょ紒鐙呯磿??==========

  private autoRoundTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRoundEnabled = false;
  private boundScheduleNextRound: ((delayMs: number) => void) | null = null;

  /**
   * 闁告凹鍨版慨鈺呮嚊椤忓嫬袟闁搞儳鍋涢幃搴☆嚗椤忓棗绠?
   * 闁搞儳鍋涢幃搴ｇ磼閹惧瓨灏嗛柛姘唉閸ゆ粓宕濋妸銉х；濠殿喖顑勭粭鍛▔閳ь剟宕堕悙鍙夊??
   */
  startAutoRound(delayMs = 3000): void {
    if (this.autoRoundEnabled) return;

    this.autoRoundEnabled = true;
    console.log('[GameEngine] Auto-round enabled');

    // 闁告帗绋戠紓鎾剁磼閹存繄鏆伴柣銊ュ閸ら亶寮弶璺ㄧ┛闁?濞寸姰鍎扮粚鍫曞触鎼达絿鏁剧紒澶婎煼??
    this.boundScheduleNextRound = () => this.scheduleNextRound(delayMs);

    // 闁烩晜鍨甸幆澶愬炊閻愬弶鍊ょ紓浣规尰濞碱偅绂嶇€ｂ晜??
    this.on('round:end', this.boundScheduleNextRound);
    this.on('round:cancelled', this.boundScheduleNextRound);

    // 鐎点倖鍎肩换婊堝触椤栨艾袟缂佹鍏涚粩鎾炊閻愬弶鍊ら柨娑樼灱缁増绂掗柨瀣闁哄牆绉存慨鐔煎籍閸洘锛熼柛鎴濇椤?
    this.scheduleNextRound(1000);
  }

  /**
   * 闁稿绮嶉娑㈡嚊椤忓嫬袟闁搞儳鍋涢幃搴☆嚗椤忓棗绠?
   */
  stopAutoRound(): void {
    this.autoRoundEnabled = false;

    if (this.autoRoundTimer) {
      clearTimeout(this.autoRoundTimer);
      this.autoRoundTimer = null;
    }

    // 闁告瑯浜炰簺闂傚嫨鍊涢崵婊堝礉閵娿儲绀€闁告艾鐗忓ù澶愬礂瀹曞洦鐣遍柣鈺傚灥閹??
    if (this.boundScheduleNextRound) {
      this.off('round:end', this.boundScheduleNextRound);
      this.off('round:cancelled', this.boundScheduleNextRound);
      this.boundScheduleNextRound = null;
    }

    console.log('[GameEngine] Auto-round disabled');
  }

  /**
   * 閻庣懓顦扮敮鎾寸▔鐎ｂ晝顏遍柛銉у仜閹?
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
        // 闂佹彃绉烽惁?
        this.scheduleNextRound(5000);
      }
    }, delayMs);
  }
}



