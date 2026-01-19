/**
 * 游戏引擎核心类
 * 管理回合生命周期、投注处理、碰撞检测和结算
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
  HitDetails,
  GameEngineEvents,
  RoundStatus,
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
} from './constants';
import {
  calculateRowIndex,
  calculateMultiplier,
  generateServerSeed,
  hashSeed,
} from './utils';
import { roundMoney } from '../shared/gameMath';
import { GameError } from './errors';
import { PriceService } from './PriceService';
import { allowSlidingWindowRequest, buildRateLimitKey } from '../services/rateLimit';
import { DistributedLock } from './DistributedLock';

export class GameEngine extends EventEmitter {
  private config: RoundConfig;
  private state: GameState | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private serverSeed: string | null = null;

  // 结算队列（异步批处理）
  private settlementQueue: SettlementItem[] = [];
  private isSettling = false;

  // 价格快照缓冲
  private priceSnapshotBuffer: Array<{
    roundId: string;
    timestamp: Date;
    price: number;
    rowIndex: number;
  }> = [];
  private lastSnapshotFlush = 0;
  private snapshotFlushPromise: Promise<void> | null = null;
  private snapshotFlushBackoffUntil = 0;
  private snapshotFlushFailures = 0;

  // 节流控制
  private lastEmitTimes: Map<string, number> = new Map();

  // 价格缓存
  private priceCache: PriceUpdate | null = null;

  // 分布式锁
  private distributedLock: DistributedLock;
  private roundLockToken: string | null = null;

  constructor(
    private redis: Redis,
    private prisma: PrismaClient,
    private priceService: PriceService,
    config?: Partial<RoundConfig>
  ) {
    super();
    this.config = { ...DEFAULT_ROUND_CONFIG, ...config };
    this.distributedLock = new DistributedLock(redis);

    // 监听价格更新
    this.priceService.on('price', (price: PriceUpdate) => {
      this.priceCache = price;
    });

    // 监听价格不可用
    this.priceService.on('price_critical', () => {
      this.handlePriceUnavailable();
    });
  }

  // ========== 公共方法 ==========

  /**
   * 获取当前游戏状态
   */
  getState(): GameState | null {
    return this.state;
  }

  /**
   * 获取配置
   */
  getConfig(): RoundConfig {
    return { ...this.config };
  }

  /**
   * 更新价格缓存（供外部调用）
   */
  updatePriceCache(price: PriceUpdate): void {
    this.priceCache = price;
  }

  // ========== 回合生命周期 ==========

  /**
   * 开始新回合
   */
  async startRound(): Promise<void> {
    if (this.state?.status === 'RUNNING' ||
        this.state?.status === 'BETTING' ||
        this.state?.status === 'SETTLING') {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '已有回合进行中');
    }

    // 1. 获取分布式锁
    const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
    const lockTtl = (this.config.maxDuration + 60) * 1000; // 回合最大时长 + 60秒缓冲
    this.roundLockToken = await this.distributedLock.acquire(lockKey, lockTtl);

    if (!this.roundLockToken) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '无法获取回合锁，可能有其他实例正在运行');
    }

    // 2. 检查价格可用性
    const startPrice = this.priceService.getLatestPrice();
    if (!startPrice) {
      await this.distributedLock.release(lockKey, this.roundLockToken);
      this.roundLockToken = null;
      throw new GameError(ERROR_CODES.PRICE_UNAVAILABLE, '价格服务不可用');
    }

    // 3. 生成 Provably Fair 种子（仅内存保存）
    this.serverSeed = generateServerSeed();
    const commitHash = hashSeed(this.serverSeed);

    const now = Date.now();

    // 4. 创建回合记录（不存储 serverSeed 明文）
    const round = await this.prisma.round.create({
      data: {
        asset: this.config.asset,
        status: 'BETTING',
        commitHash,
        startPrice: startPrice.price,
        startedAt: new Date(now),
      },
    });

    // 5. 初始化状态
    this.state = {
      roundId: round.id,
      status: 'BETTING',
      asset: this.config.asset,
      startPrice: startPrice.price,
      currentPrice: startPrice.price,
      currentRow: CENTER_ROW_INDEX,
      elapsed: 0,
      roundStartTime: now,
      commitHash,
      activeBets: new Map(),
    };

    // 6. 同步到 Redis
    await this.syncStateToRedis();

    // 7. 启动 Tick 循环
    this.startTickLoop();

    // 8. 广播回合开始
    this.emit('round:start', {
      roundId: round.id,
      asset: this.config.asset,
      commitHash,
      startPrice: startPrice.price,
      startTime: now,
      bettingDuration: this.config.bettingDuration,
      maxDuration: this.config.maxDuration,
    });

    // 9. 投注阶段倒计时
    setTimeout(() => this.transitionToRunning(), this.config.bettingDuration * 1000);

    console.log(`[GameEngine] Round ${round.id} started`);
  }

  /**
   * 转换到运行状态
   */
  private transitionToRunning(): void {
    if (!this.state || this.state.status !== 'BETTING') return;

    this.state.status = 'RUNNING';
    this.syncStateToRedis().catch(console.error);

    this.emit('round:running', { roundId: this.state.roundId });

    console.log(`[GameEngine] Round ${this.state.roundId} now RUNNING`);
  }

  /**
   * 结束回合
   */
  async endRound(reason: 'timeout' | 'manual' | 'crash' = 'timeout'): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
        this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    // 立即切换到 SETTLING 防止重入
    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    const endPrice = this.state.currentPrice;
    const serverSeed = this.serverSeed;
    console.log(`[GameEngine] Ending round ${roundId} (reason: ${reason})`);

    // 1. 停止 Tick
    this.stopTickLoop();

    try {
      // 2. 同步状态到 Redis（失败也不阻塞回合结束，避免未处理拒绝导致进程退出）
      await this.syncStateToRedis().catch((error) => {
        console.error(`[GameEngine] Failed to sync state to Redis for round ${roundId}:`, error);
      });

      // 3. 结算所有未结算投注
      this.settleAllPendingBets();

      // 4. 等待结算队列处理完成
      await this.flushSettlementQueue().catch((error) => {
        console.error(`[GameEngine] Failed to flush settlement queue for round ${roundId}:`, error);
      });

      // 5. 兜底：补偿DB中未结算的投注（DB 超时不应导致回合结束流程崩溃）
      const unsettledBets = await this.prisma.bet
        .findMany({
          where: {
            roundId,
            status: 'PENDING',
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to query unsettled bets for round ${roundId}:`, error);
          return [];
        });

      if (unsettledBets.length > 0) {
        console.warn(`[GameEngine] Found ${unsettledBets.length} unsettled bets, compensating...`);
        for (const dbBet of unsettledBets) {
          try {
            const timeDiff = Math.abs(this.state!.elapsed - Number(dbBet.targetTime ?? 0));
            const rowDiff = Math.abs(this.state!.currentRow - Number(dbBet.targetRow ?? 0));
            const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;
            const payout = isWin ? Number(dbBet.amount) * Number(dbBet.multiplier) : 0;

            await this.prisma.$transaction(async (tx) => {
              await tx.bet.update({
                where: { id: dbBet.id },
                data: {
                  status: isWin ? 'WON' : 'LOST',
                  isWin,
                  payout,
                  settledAt: new Date(),
                },
              });

              if (isWin && payout > 0) {
                const balanceField = dbBet.isPlayMode ? 'playBalance' : 'balance';
                await tx.user.update({
                  where: { id: dbBet.userId },
                  data: { [balanceField]: { increment: payout } },
                });
              }

              await tx.user.update({
                where: { id: dbBet.userId },
                data: {
                  totalBets: { increment: 1 },
                  totalWins: isWin ? { increment: 1 } : undefined,
                  totalLosses: !isWin ? { increment: 1 } : undefined,
                  totalProfit: {
                    increment: isWin ? payout - Number(dbBet.amount) : -Number(dbBet.amount),
                  },
                },
              });
            });
          } catch (error) {
            console.error(`[GameEngine] Failed to compensate bet ${dbBet.id} for round ${roundId}:`, error);
          }
        }
      }

      // 6. 刷新价格快照
      await this.flushPriceSnapshots();

      // 7. 计算统计
      const stats = this.calculateRoundStats();

      // 8. 更新数据库（此时才写入 serverSeed 明文）
      await this.prisma.round
        .update({
          where: { id: roundId },
          data: {
            status: 'COMPLETED',
            serverSeed,
            endPrice,
            endedAt: new Date(),
            totalBets: stats.totalBets,
            totalVolume: stats.totalVolume,
            totalPayout: stats.totalPayout,
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to update round ${roundId} in database:`, error);
        });

      // 9. 广播回合结束（即使 DB 更新失败，也尽量通知客户端结束）
      this.emit('round:end', {
        roundId,
        serverSeed: serverSeed!,
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
      // 防止未处理 Promise 拒绝导致进程退出
      try {
        const stats = this.calculateRoundStats();
        this.emit('round:end', {
          roundId,
          serverSeed: serverSeed ?? '',
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
      // 10. 清理Redis ACTIVE_BETS键
      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      // 11. 释放分布式锁
      if (this.roundLockToken) {
        const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
        try {
          await this.distributedLock.release(lockKey, this.roundLockToken);
        } catch (error) {
          console.error(`[GameEngine] Failed to release round lock for round ${roundId}:`, error);
        } finally {
          this.roundLockToken = null;
        }
      }

      // 12. 清理
      this.cleanup();
    }

    console.log(`[GameEngine] Round ${roundId} completed`);
  }

  /**
   * 取消回合并退款
   */
  async cancelRound(reason: string): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
        this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    // 立即切换到 SETTLING 防止重入
    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    console.log(`[GameEngine] Cancelling round ${roundId} (reason: ${reason})`);

    // 1. 停止 Tick
    this.stopTickLoop();

    // 3. 退款所有待结算投注
    const pendingBets = Array.from(this.state.activeBets.values()).filter(
      (b) => b.status === 'PENDING'
    );

    for (const bet of pendingBets) {
      await this.refundBet(bet, reason);
    }

    // 4. 更新数据库
    await this.prisma.round.update({
      where: { id: roundId },
      data: {
        status: 'CANCELLED',
        serverSeed: this.serverSeed,
        endedAt: new Date(),
      },
    });

    // 5. 广播回合取消
    this.emit('round:cancelled', {
      roundId,
      serverSeed: this.serverSeed!,
      reason,
      refundedBets: pendingBets.length,
    });

    // 6. 清理Redis ACTIVE_BETS键
    try {
      await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
    } catch (error) {
      console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
    }

    // 7. 清理
    this.cleanup();

    console.log(`[GameEngine] Round ${roundId} cancelled, ${pendingBets.length} bets refunded`);
  }

  /**
   * 退款单个投注
   */
  private async refundBet(bet: ServerBet, reason: string): Promise<void> {
    const settledAt = new Date();
    const roundId = this.state?.roundId;

    const didRefund = await this.prisma.$transaction(async (tx) => {
      // 使用 updateMany 实现幂等：只更新 PENDING 状态的注单
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: 'PENDING' },
        data: {
          status: 'REFUNDED',
          settledAt,
        },
      });

      if (updated.count !== 1) return false;

      // 退还余额
      const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';

      const user = await tx.user.findUnique({
        where: { id: bet.userId },
        select: { balance: true, playBalance: true },
      });

      if (!user) {
        throw new Error(`User ${bet.userId} not found`);
      }

      const balanceBefore = Number(balanceField === 'balance' ? user.balance : user.playBalance);

      await tx.user.update({
        where: { id: bet.userId },
        data: { [balanceField]: { increment: bet.amount } },
      });

      const balanceAfter = balanceBefore + bet.amount;

      // 记录 REFUND 流水（仅真实余额）
      if (!bet.isPlayMode) {
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'REFUND',
            amount: bet.amount,
            balanceBefore,
            balanceAfter,
            relatedBetId: bet.id,
            remark: `Refund bet ${bet.id}${roundId ? ` (round ${roundId})` : ''}: ${reason}`,
            status: 'COMPLETED',
            completedAt: settledAt,
          },
        });
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

  // ========== 投注处理 ==========

  /**
   * 下注
   */
  async placeBet(userId: string, request: PlaceBetRequest): Promise<PlaceBetResponse> {
    // 1. 状态检查
    if (!this.state) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '当前没有进行中的回合');
    }

    if (this.state.status !== 'BETTING' && this.state.status !== 'RUNNING') {
      throw new GameError(ERROR_CODES.BETTING_CLOSED, '当前不可投注');
    }

    // 2. 最大活跃投注限制
    const maxActiveBets = parseInt(process.env.MAX_ACTIVE_BETS ?? '10000', 10);
    if (this.state.activeBets.size >= maxActiveBets) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '系统投注数量已达上限，请稍后再试');
    }

    // 3. 投注频率限制
    if (!(await this.checkRateLimit(userId))) {
      throw new GameError(
        ERROR_CODES.RATE_LIMITED,
        `投注过于频繁，每秒最多 ${this.config.maxBetsPerSecond} 次`
      );
    }

    // 3. 时间检查
    const minTargetTime = this.state.elapsed + MIN_TARGET_TIME_OFFSET;
    if (request.targetTime <= minTargetTime) {
      throw new GameError(ERROR_CODES.TARGET_TIME_PASSED, '目标时间已过或太近');
    }

    // 确保目标时间不超过回合最大时长
    if (request.targetTime > this.config.maxDuration) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `目标时间不能超过 ${this.config.maxDuration} 秒`);
    }

    // 4. 金额检查
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `投注金额需在 ${this.config.minBetAmount}-${this.config.maxBetAmount} 之间`
      );
    }

    // 确保金额为正数
    if (request.amount <= 0 || !Number.isFinite(request.amount)) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '投注金额必须为正数');
    }

    // 5. 目标行检查
    if (!Number.isFinite(request.targetRow) || request.targetRow < 0 || request.targetRow > MAX_ROW_INDEX) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `目标行索引必须在 0-${MAX_ROW_INDEX} 之间`);
    }

    // 6. 用户投注数量限制
    const userBetCount = Array.from(this.state.activeBets.values()).filter(
      (b) => b.userId === userId && b.status === 'PENDING'
    ).length;
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '已达到最大投注数量');
    }

    // 7. 计算倍率
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '无效的倍率');
    }

    // 8. 幂等性检查：先查询orderId是否已存在
    const existingBet = await this.prisma.bet.findUnique({
      where: { orderId: request.orderId },
    });

    if (existingBet) {
      console.log(`[GameEngine] Duplicate bet request: ${request.orderId}`);
      return {
        betId: existingBet.id,
        multiplier: Number(existingBet.multiplier),
        targetTime: Number(existingBet.targetTime ?? 0),
        targetRow: Number(existingBet.targetRow ?? 0),
      };
    }

    // 8. 分布式锁
    const lockKey = `${REDIS_KEYS.BET_LOCK}${request.orderId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) {
      throw new GameError(ERROR_CODES.DUPLICATE_BET, '重复的投注请求');
    }

    try {
      // 9. 原子扣款 + 记录投注
      const bet = await this.prisma.$transaction(async (tx) => {
        // 在事务内二次校验回合状态,防止与endRound并发
        const currentRound = await tx.round.findUnique({
          where: { id: this.state!.roundId },
          select: { status: true },
        });

        if (!currentRound || (currentRound.status !== 'BETTING' && currentRound.status !== 'RUNNING')) {
          throw new GameError(ERROR_CODES.BETTING_CLOSED, '回合已关闭或不存在');
        }

        const balanceField = request.isPlayMode ? 'playBalance' : 'balance';

        // 获取当前余额（用于流水记录）
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { balance: true, playBalance: true },
        });

        if (!user) {
          throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '用户不存在');
        }

        const currentBalance = Number(balanceField === 'balance' ? user.balance : user.playBalance);

        // 原子条件更新
        const updateResult = await tx.user.updateMany({
          where: {
            id: userId,
            [balanceField]: { gte: request.amount },
          },
          data: {
            [balanceField]: { decrement: request.amount },
          },
        });

        if (updateResult.count === 0) {
          throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '余额不足');
        }

        // 创建投注记录（包含orderId）
        const newBet = await tx.bet.create({
          data: {
            userId,
            roundId: this.state!.roundId,
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

        // 记录流水（仅真实余额）
        if (!request.isPlayMode) {
          await tx.transaction.create({
            data: {
              userId,
              type: 'BET',
              amount: -request.amount,
              balanceBefore: currentBalance,
              balanceAfter: currentBalance - request.amount,
              relatedBetId: newBet.id,
              remark: `投注 ${this.config.asset} 回合 ${this.state!.roundId}`,
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });
        }

        return newBet;
      });

      // 9. 添加到活跃投注池
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

      // 10. 同步到 Redis（异步）
      setImmediate(() => {
        this.redis
          .zadd(
            `${REDIS_KEYS.ACTIVE_BETS}${this.state!.roundId}`,
            request.targetTime,
            JSON.stringify(serverBet)
          )
          .catch((err) => console.error('[GameEngine] Redis sync failed:', err));
      });

      // 11. 获取最新余额
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true, playBalance: true },
      });

      // 12. 广播投注确认（包含 userId 和余额信息用于定向发送）
      this.emit('bet:confirmed', {
        userId,
        orderId: request.orderId,
        betId: bet.id,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        amount: request.amount,
        newBalance: request.isPlayMode
          ? Number(user?.playBalance ?? 0)
          : Number(user?.balance ?? 0),
      });

      console.log(`[GameEngine] Bet ${bet.id} placed by ${userId}`);

      return {
        betId: bet.id,
        multiplier,
        targetTime: request.targetTime,
        targetRow: request.targetRow,
      };
    } catch (error) {
      // 失败时立即释放锁
      await this.redis.del(lockKey);
      throw error;
    }
    // 成功时让锁自然过期，避免重复请求
  }

  /**
   * 投注频率限制检查
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

  // ========== Tick 循环 ==========

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
   * 核心 Tick 循环 - 非阻塞设计
   */
  private tick(): void {
    if (!this.state || this.state.status === 'SETTLING' || this.state.status === 'COMPLETED') {
      return;
    }

    const now = Date.now();
    this.state.elapsed = (now - this.state.roundStartTime) / 1000;

    // 1. 获取最新价格
    if (this.priceCache) {
      this.state.currentPrice = this.priceCache.price;
      this.state.currentRow = calculateRowIndex(this.priceCache.price, this.state.startPrice);
    }

    // 2. 碰撞检测（使用 targetTime bucketing 优化）
    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: SettlementItem[] = [];

    // Bucketing: 只检查时间窗口内的投注
    const bucketWindow = parseFloat(process.env.BUCKET_WINDOW ?? '2');
    const minTargetTime = this.state.elapsed - bucketWindow;
    const maxTargetTime = this.state.elapsed + bucketWindow;

    for (const [, bet] of this.state.activeBets) {
      if (bet.status !== 'PENDING') continue;

      // 先过滤时间窗口
      if (bet.targetTime < minTargetTime || bet.targetTime > maxTargetTime) continue;

      const timeDiff = Math.abs(this.state.elapsed - bet.targetTime);
      const isInTimeWindow = timeDiff <= HIT_TIME_TOLERANCE;

      if (isInTimeWindow) {
        // 行交叉检测
        const minRow = Math.min(prevRow, this.state.currentRow) - this.config.hitTolerance;
        const maxRow = Math.max(prevRow, this.state.currentRow) + this.config.hitTolerance;

        if (bet.targetRow >= minRow && bet.targetRow <= maxRow) {
          toSettle.push({
            bet,
            isWin: true,
            hitDetails: {
              hitPrice: this.state.currentPrice,
              hitRow: this.state.currentRow,
              hitTime: this.state.elapsed,
            },
          });
          // 立即标记为SETTLING,防止重复入队
          bet.status = 'SETTLING';
        }
      } else if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        toSettle.push({ bet, isWin: false });
        // 立即标记为SETTLING,防止重复入队
        bet.status = 'SETTLING';
      }
    }

    // 3. 保存上一帧行索引
    this.state.prevRow = this.state.currentRow;

    // 4. 异步结算
    if (toSettle.length > 0) {
      this.settlementQueue.push(...toSettle);
      this.processSettlementQueue();
    }

    // 5. 缓冲价格快照
    this.bufferPriceSnapshot();

    // 6. 广播状态更新（节流）
    this.emitThrottled('state:update', {
      elapsed: this.state.elapsed,
      currentPrice: this.state.currentPrice,
      currentRow: this.state.currentRow,
    });

    // 7. 检查回合超时
    if (this.state.elapsed >= this.config.maxDuration) {
      setImmediate(() => {
        void this.endRound('timeout').catch((error) => {
          console.error('[GameEngine] endRound failed:', error);
        });
      });
    }
  }

  // ========== 结算处理 ==========

  /**
   * 结算所有待结算投注
   */
  private settleAllPendingBets(): void {
    const pendingBets = Array.from(this.state!.activeBets.values()).filter(
      (b) => b.status === 'PENDING'
    );

    for (const bet of pendingBets) {
      const timeDiff = Math.abs(this.state!.elapsed - bet.targetTime);
      const rowDiff = Math.abs(this.state!.currentRow - bet.targetRow);
      const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;

      // 立即标记为SETTLING,防止重复入队
      bet.status = 'SETTLING';

      this.settlementQueue.push({
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

    this.processSettlementQueue();
  }

  /**
   * 异步结算队列处理
   */
  private async processSettlementQueue(): Promise<void> {
    if (this.isSettling || this.settlementQueue.length === 0) return;

    this.isSettling = true;

    try {
      while (this.settlementQueue.length > 0) {
        const batch = this.settlementQueue.slice(0, 50);
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount <= maxRetries) {
          try {
            await this.prisma.$transaction(async (tx) => {
              for (const { bet, isWin, hitDetails } of batch) {
                const payout = isWin ? roundMoney(bet.amount * bet.multiplier) : 0;

                // 使用updateMany实现幂等性:只更新PENDING状态的注单
                const updated = await tx.bet.updateMany({
                  where: {
                    id: bet.id,
                    status: 'PENDING',
                  },
                  data: {
                    status: isWin ? 'WON' : 'LOST',
                    isWin,
                    payout,
                    hitPrice: hitDetails?.hitPrice,
                    hitRow: hitDetails?.hitRow,
                    hitTime: hitDetails?.hitTime,
                    settledAt: new Date(),
                  },
                });

                // 只有成功更新1条记录才执行加钱和统计
                if (updated.count === 1) {
                  if (isWin && payout > 0) {
                    const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';

                    // 获取当前余额（用于流水记录）
                    const user = await tx.user.findUnique({
                      where: { id: bet.userId },
                      select: { balance: true, playBalance: true },
                    });

                    const currentBalance = Number(balanceField === 'balance' ? user!.balance : user!.playBalance);

                    await tx.user.update({
                      where: { id: bet.userId },
                      data: { [balanceField]: { increment: payout } },
                    });

                    // 记录流水（仅真实余额）
                    if (!bet.isPlayMode) {
                      await tx.transaction.create({
                        data: {
                          userId: bet.userId,
                          type: 'WIN',
                          amount: payout,
                          balanceBefore: currentBalance,
                          balanceAfter: currentBalance + payout,
                          relatedBetId: bet.id,
                          remark: `赢得投注 ${bet.id}`,
                          status: 'COMPLETED',
                          completedAt: new Date(),
                        },
                      });
                    }
                  }

                  await tx.user.update({
                    where: { id: bet.userId },
                    data: {
                      totalBets: { increment: 1 },
                      totalWins: isWin ? { increment: 1 } : undefined,
                      totalLosses: !isWin ? { increment: 1 } : undefined,
                      totalProfit: { increment: isWin ? payout - bet.amount : -bet.amount },
                    },
                  });
                } else {
                  console.log(`[GameEngine] Bet ${bet.id} already settled, skipping`);
                }
              }
            });

            // DB成功后才修改内存状态
            for (const { bet, isWin } of batch) {
              bet.status = isWin ? 'WON' : 'LOST';
            }

            // 广播结算结果
            for (const { bet, isWin, hitDetails } of batch) {
              this.emit('bet:settled', {
                betId: bet.id,
                orderId: bet.orderId,
                userId: bet.userId,
                isWin,
                payout: isWin ? bet.amount * bet.multiplier : 0,
                hitDetails,
              });
            }

            // 成功后移除batch
            this.settlementQueue.splice(0, batch.length);
            break;
          } catch (error) {
            retryCount++;
            if (retryCount > maxRetries) {
              console.error('[GameEngine] Settlement batch failed after retries:', error);
              // 失败后不移除，下次循环会重试
              break;
            }
            // 指数退避
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retryCount) * 100));
          }
        }

        // 如果重试失败，跳出循环避免死循环
        if (retryCount > maxRetries) {
          break;
        }
      }
    } finally {
      this.isSettling = false;
    }
  }

  /**
   * 等待结算队列清空
   */
  private async flushSettlementQueue(): Promise<void> {
    const maxWaitTime = 30000; // 最多等待30秒
    const startTime = Date.now();

    while (this.settlementQueue.length > 0 || this.isSettling) {
      // 检查超时
      if (Date.now() - startTime > maxWaitTime) {
        console.error('[GameEngine] Settlement queue flush timeout, continuing anyway');
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ========== 辅助方法 ==========

  /**
   * 缓冲价格快照
   */
  private bufferPriceSnapshot(): void {
    if (!this.state) return;

    // 每 100ms 记录一次
    const snapshotIndex = Math.floor(this.state.elapsed * 10);
    if (this.priceSnapshotBuffer.length > 0) {
      const lastIndex = Math.floor(
        (this.priceSnapshotBuffer[this.priceSnapshotBuffer.length - 1].timestamp.getTime() -
          this.state.roundStartTime) /
          100
      );
      if (snapshotIndex === lastIndex) return;
    }

    // 队列限制：防止内存溢出
    const maxQueue = parseInt(process.env.MAX_SNAPSHOT_QUEUE ?? '10000', 10);
    if (this.priceSnapshotBuffer.length >= maxQueue) {
      this.priceSnapshotBuffer.shift();
    }

    this.priceSnapshotBuffer.push({
      roundId: this.state.roundId,
      timestamp: new Date(),
      price: this.state.currentPrice,
      rowIndex: this.state.currentRow,
    });

    // 每秒批量写入
    const now = Date.now();
    if (
      now - this.lastSnapshotFlush >= 1000 &&
      now >= this.snapshotFlushBackoffUntil &&
      this.priceSnapshotBuffer.length > 0
    ) {
      void this.flushPriceSnapshots().catch(console.error);
    }
  }

  /**
   * 刷新价格快照到数据库
   */
  private flushPriceSnapshots(): Promise<void> {
    if (this.snapshotFlushPromise) return this.snapshotFlushPromise;
    if (this.priceSnapshotBuffer.length === 0) return Promise.resolve();

    const now = Date.now();
    if (now < this.snapshotFlushBackoffUntil) return Promise.resolve();

    this.lastSnapshotFlush = now;

    this.snapshotFlushPromise = this.flushPriceSnapshotsInternal().finally(() => {
      this.snapshotFlushPromise = null;
    });

    return this.snapshotFlushPromise;
  }

  private async flushPriceSnapshotsInternal(): Promise<void> {
    const buffer = this.priceSnapshotBuffer.splice(0);
    if (buffer.length === 0) return;

    const rawBatchSize = parseInt(process.env.SNAPSHOT_FLUSH_BATCH_SIZE ?? '500', 10);
    const batchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 500;

    let index = 0;
    try {
      for (; index < buffer.length; index += batchSize) {
        const batch = buffer.slice(index, index + batchSize);
        await this.prisma.priceSnapshot.createMany({ data: batch });
      }

      this.snapshotFlushFailures = 0;
      this.snapshotFlushBackoffUntil = 0;
    } catch (error) {
      console.error('[GameEngine] Price snapshot flush failed:', error);

      // 失败时将未写入的数据放回缓冲区,避免丢失（已成功写入的批次不回滚）
      const remaining = buffer.slice(index);
      if (remaining.length > 0) {
        this.priceSnapshotBuffer = remaining.concat(this.priceSnapshotBuffer);
      }

      this.snapshotFlushFailures = Math.min(this.snapshotFlushFailures + 1, 10);
      const baseDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_BASE_MS ?? '1000', 10);
      const maxDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_MAX_MS ?? '30000', 10);
      const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 1000;
      const max = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : 30000;
      const delayMs = Math.min(max, base * 2 ** (this.snapshotFlushFailures - 1));
      this.snapshotFlushBackoffUntil = Date.now() + delayMs;
    }
  }

  /**
   * 节流发送事件
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
   * 同步状态到 Redis
   */
  private async syncStateToRedis(): Promise<void> {
    if (!this.state) return;

    await this.redis.hset(`${REDIS_KEYS.ROUND_STATE}${this.state.asset}`, {
      id: this.state.roundId,
      status: this.state.status,
      startPrice: this.state.startPrice.toString(),
      currentRow: this.state.currentRow.toString(),
      elapsed: this.state.elapsed.toString(),
      commitHash: this.state.commitHash,
    });
  }

  /**
   * 计算回合统计
   */
  private calculateRoundStats(): {
    totalBets: number;
    totalWins: number;
    totalVolume: number;
    totalPayout: number;
  } {
    const bets = Array.from(this.state!.activeBets.values());
    return {
      totalBets: bets.length,
      totalWins: bets.filter((b) => b.status === 'WON').length,
      totalVolume: bets.reduce((sum, b) => sum + b.amount, 0),
      totalPayout: bets
        .filter((b) => b.status === 'WON')
        .reduce((sum, b) => sum + b.amount * b.multiplier, 0),
    };
  }

  /**
   * 处理价格不可用
   */
  private handlePriceUnavailable(): void {
    if (this.state && (this.state.status === 'RUNNING' || this.state.status === 'BETTING')) {
      console.warn('[GameEngine] Price unavailable, cancelling round...');
      this.cancelRound('价格服务不可用').catch(console.error);
    }
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.state = null;
    this.serverSeed = null;
    this.priceSnapshotBuffer = [];
    this.settlementQueue = [];
  }

  /**
   * 停止引擎
   */
  async stop(): Promise<void> {
    this.stopTickLoop();
    this.stopAutoRound();

    if (this.state) {
      await this.cancelRound('引擎停止');
    }

    console.log('[GameEngine] Stopped');
  }

  // ========== 自动回合管理 ==========

  private autoRoundTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRoundEnabled = false;
  private boundScheduleNextRound: ((delayMs: number) => void) | null = null;

  /**
   * 启动自动回合循环
   * 回合结束后自动开始下一回合
   */
  startAutoRound(delayMs = 3000): void {
    if (this.autoRoundEnabled) return;

    this.autoRoundEnabled = true;
    console.log('[GameEngine] Auto-round enabled');

    // 创建绑定的函数引用,以便后续移除
    this.boundScheduleNextRound = () => this.scheduleNextRound(delayMs);

    // 监听回合结束事件
    this.on('round:end', this.boundScheduleNextRound);
    this.on('round:cancelled', this.boundScheduleNextRound);

    // 延迟启动第一回合，给价格服务时间准备
    this.scheduleNextRound(1000);
  }

  /**
   * 停止自动回合循环
   */
  stopAutoRound(): void {
    this.autoRoundEnabled = false;

    if (this.autoRoundTimer) {
      clearTimeout(this.autoRoundTimer);
      this.autoRoundTimer = null;
    }

    // 只移除自动回合相关的监听器
    if (this.boundScheduleNextRound) {
      this.off('round:end', this.boundScheduleNextRound);
      this.off('round:cancelled', this.boundScheduleNextRound);
      this.boundScheduleNextRound = null;
    }

    console.log('[GameEngine] Auto-round disabled');
  }

  /**
   * 安排下一回合
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
        // 重试
        this.scheduleNextRound(5000);
      }
    }, delayMs);
  }
}
