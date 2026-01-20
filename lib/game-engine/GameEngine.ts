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

  // 结算队列（异步批处理）
  private settlementQueue: SettlementItem[] = [];
  private isSettling = false;

  // 投注时间索引（最小堆：按 targetTime 排序）
  private betHeap: ServerBet[] = [];

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

    try {
      // 2. 检查价格可用性
      const startPrice = this.priceService.getLatestPrice();
      if (!startPrice) {
        throw new GameError(ERROR_CODES.PRICE_UNAVAILABLE, '价格服务不可用');
      }

      const now = Date.now();

      // 3. 创建回合记录
      const round = await this.prisma.round.create({
        data: {
          asset: this.config.asset,
          status: 'BETTING',
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
        startPrice: startPrice.price,
        startTime: now,
        bettingDuration: this.config.bettingDuration,
        maxDuration: this.config.maxDuration,
      });

      // 9. 投注阶段倒计时
      setTimeout(() => this.transitionToRunning(), this.config.bettingDuration * 1000);

      console.log(`[GameEngine] Round ${round.id} started`);
    } catch (error) {
      // 释放锁并重新抛出错误
      console.error(`[GameEngine] startRound failed, releasing lock:`, error);
      await this.distributedLock.release(lockKey, this.roundLockToken);
      this.roundLockToken = null;
      throw error;
    }
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

      // 8. 更新数据库
      await this.prisma.round
        .update({
          where: { id: roundId },
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
        });

      // 9. 广播回合结束（即使 DB 更新失败，也尽量通知客户端结束）
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
      // 防止未处理 Promise 拒绝导致进程退出
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

    try {
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
          endedAt: new Date(),
        },
      });

      // 5. 广播回合取消
      this.emit('round:cancelled', {
        roundId,
        reason,
        refundedBets: pendingBets.length,
      });

      // 6. 清理Redis ACTIVE_BETS键
      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      console.log(`[GameEngine] Round ${roundId} cancelled, ${pendingBets.length} bets refunded`);
    } finally {
      // 7. 释放分布式锁
      if (this.roundLockToken) {
        const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
        try {
          await this.distributedLock.release(lockKey, this.roundLockToken);
        } catch (error) {
          console.error(`[GameEngine] Failed to release round lock:`, error);
        } finally {
          this.roundLockToken = null;
        }
      }

      // 8. 清理
      this.cleanup();
    }
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

    // 8. 订单ID验证
    if (!request.orderId || typeof request.orderId !== 'string' || request.orderId.trim() === '') {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '订单ID不能为空');
    }

    // 9. 幂等性检查：先查询orderId是否已存在
    const existingBet = await this.prisma.bet.findUnique({
      where: { orderId: request.orderId },
    });

    if (existingBet) {
      // 验证用户所有权
      if (existingBet.userId !== userId) {
        console.warn(`[GameEngine] Order ID ${request.orderId} belongs to different user`);
        throw new GameError(ERROR_CODES.DUPLICATE_BET, '订单ID已被使用');
      }
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
      // 9. 原子扣款 + 记录投注（匿名用户游玩模式跳过数据库操作）
      const isAnonymous = userId.startsWith('anon-');
      const bet = await this.prisma.$transaction(async (tx) => {
        // 在事务内二次校验回合状态,防止与endRound并发
        const currentRound = await tx.round.findUnique({
          where: { id: this.state!.roundId },
          select: { status: true },
        });

        if (!currentRound || (currentRound.status !== 'BETTING' && currentRound.status !== 'RUNNING')) {
          throw new GameError(ERROR_CODES.BETTING_CLOSED, '回合已关闭或不存在');
        }

        // 匿名用户只能游玩模式，跳过余额检查
        if (isAnonymous && !request.isPlayMode) {
          throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '匿名用户只能使用游玩模式');
        }

        let currentBalance = 0;

        // 非匿名用户需要扣款
        if (!isAnonymous) {
          const balanceField = request.isPlayMode ? 'playBalance' : 'balance';

          // 获取当前余额（用于流水记录）
          const user = await tx.user.findUnique({
            where: { id: userId },
            select: { balance: true, playBalance: true },
          });

          if (!user) {
            throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '用户不存在');
          }

          currentBalance = Number(balanceField === 'balance' ? user.balance : user.playBalance);

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

        // 记录流水（仅真实余额且非匿名）
        if (!request.isPlayMode && !isAnonymous) {
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
      this.heapPush(serverBet);

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

      // 11. 获取最新余额（匿名用户返回 0）
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

      // 12. 广播投注确认（包含 userId 和余额信息用于定向发送）
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
   * 核心 Tick 循环 - 使用最小堆优化
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

    // 2. 碰撞检测（最小堆优化：只处理即将到期的投注）
    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: SettlementItem[] = [];

    // 从堆顶取出所有在检测窗口内的投注
    while (this.betHeap.length > 0) {
      const bet = this.betHeap[0];

      // 堆顶投注还未进入检测窗口，后续投注更晚，直接退出
      if (bet.targetTime > this.state.elapsed + HIT_TIME_TOLERANCE) break;

      // 已超过 MISS 窗口，标记为失败
      if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        this.heapPop();
        if (bet.status === 'PENDING') {
          toSettle.push({ bet, isWin: false });
          bet.status = 'SETTLING';
        }
        continue;
      }

      // 在检测窗口内，检查碰撞
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

      // 还在窗口内但未命中，保留在堆中等待下一帧
      break;
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
   * 结算所有待结算投注（回合结束时调用）
   */
  private settleAllPendingBets(): void {
    // 清空堆中所有剩余投注
    while (this.betHeap.length > 0) {
      const bet = this.heapPop()!;
      if (bet.status !== 'PENDING') continue;

      const timeDiff = Math.abs(this.state!.elapsed - bet.targetTime);
      const rowDiff = Math.abs(this.state!.currentRow - bet.targetRow);
      const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;

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
              // 按用户聚合投注，减少数据库查询次数
              const userAggregates = new Map<string, {
                bets: Array<{ bet: typeof batch[0]['bet'], isWin: boolean, hitDetails: typeof batch[0]['hitDetails'], payout: number }>,
                totalPayout: number,
                totalPayoutPlay: number,
                totalBets: number,
                totalWins: number,
                totalLosses: number,
                totalProfit: number,
                transactions: Array<{ amount: number, relatedBetId: string, remark: string }>,
              }>();

              // 第一阶段：更新投注状态并聚合用户数据
              for (const { bet, isWin, hitDetails } of batch) {
                // 确保 multiplier 舍入一致性
                const roundedMultiplier = Math.round(bet.multiplier * 10000) / 10000;
                const payout = isWin ? roundMoney(bet.amount * roundedMultiplier) : 0;

                const updated = await tx.bet.updateMany({
                  where: { id: bet.id, status: 'PENDING' },
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

                if (updated.count === 1) {
                  const agg = userAggregates.get(bet.userId) || {
                    bets: [],
                    totalPayout: 0,
                    totalPayoutPlay: 0,
                    totalBets: 0,
                    totalWins: 0,
                    totalLosses: 0,
                    totalProfit: 0,
                    transactions: [],
                  };

                  agg.bets.push({ bet, isWin, hitDetails, payout });
                  if (isWin && payout > 0) {
                    if (bet.isPlayMode) {
                      agg.totalPayoutPlay += payout;
                    } else {
                      agg.totalPayout += payout;
                      agg.transactions.push({ amount: payout, relatedBetId: bet.id, remark: `赢得投注 ${bet.id}` });
                    }
                  }
                  agg.totalBets++;
                  if (isWin) agg.totalWins++;
                  else agg.totalLosses++;
                  agg.totalProfit += isWin ? payout - bet.amount : -bet.amount;

                  userAggregates.set(bet.userId, agg);
                } else {
                  console.log(`[GameEngine] Bet ${bet.id} already settled, skipping`);
                }
              }

              // 第二阶段：批量更新用户余额和统计（每用户仅1次查询+1次更新）
              for (const [userId, agg] of userAggregates) {
                const user = await tx.user.findUnique({
                  where: { id: userId },
                  select: { balance: true, playBalance: true },
                });

                if (!user) continue;

                const updateData: any = {
                  totalBets: { increment: agg.totalBets },
                  totalWins: agg.totalWins > 0 ? { increment: agg.totalWins } : undefined,
                  totalLosses: agg.totalLosses > 0 ? { increment: agg.totalLosses } : undefined,
                  totalProfit: { increment: agg.totalProfit },
                };

                if (agg.totalPayout > 0) updateData.balance = { increment: agg.totalPayout };
                if (agg.totalPayoutPlay > 0) updateData.playBalance = { increment: agg.totalPayoutPlay };

                await tx.user.update({ where: { id: userId }, data: updateData });

                // 批量创建流水记录
                if (agg.transactions.length > 0) {
                  let currentBalance = Number(user.balance);
                  await tx.transaction.createMany({
                    data: agg.transactions.map(t => {
                      const balanceBefore = currentBalance;
                      currentBalance += t.amount;
                      return {
                        userId,
                        type: 'WIN' as const,
                        amount: t.amount,
                        balanceBefore,
                        balanceAfter: currentBalance,
                        relatedBetId: t.relatedBetId,
                        remark: t.remark,
                        status: 'COMPLETED' as const,
                        completedAt: new Date(),
                      };
                    }),
                  });
                }
              }
            });

            // DB成功后才修改内存状态
            for (const { bet, isWin } of batch) {
              bet.status = isWin ? 'WON' : 'LOST';
            }

            // 广播结算结果
            for (const { bet, isWin, hitDetails } of batch) {
              // 确保 multiplier 舍入一致性
              const roundedMultiplier = Math.round(bet.multiplier * 10000) / 10000;
              this.emit('bet:settled', {
                betId: bet.id,
                orderId: bet.orderId,
                userId: bet.userId,
                isWin,
                payout: isWin ? roundMoney(bet.amount * roundedMultiplier) : 0,
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
    this.priceSnapshotBuffer = [];
    this.settlementQueue = [];
    this.betHeap = [];
  }

  // ========== 最小堆操作 ==========

  /**
   * 插入投注到最小堆（按 targetTime 排序）
   */
  private heapPush(bet: ServerBet): void {
    this.betHeap.push(bet);
    this.heapifyUp(this.betHeap.length - 1);
  }

  /**
   * 弹出堆顶投注
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
   * 上浮操作
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
   * 下沉操作
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
