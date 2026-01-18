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
} from './constants';
import {
  calculateRowIndex,
  calculateMultiplier,
  generateServerSeed,
  hashSeed,
} from './utils';
import { GameError } from './errors';
import { PriceService } from './PriceService';

export class GameEngine extends EventEmitter {
  private config: RoundConfig;
  private state: GameState | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private serverSeed: string | null = null;

  // 结算队列（异步批处理）
  private settlementQueue: SettlementItem[] = [];
  private isSettling = false;

  // 用户投注频率限制
  private userBetTimestamps: Map<string, number[]> = new Map();

  // 价格快照缓冲
  private priceSnapshotBuffer: Array<{
    roundId: string;
    timestamp: Date;
    price: number;
    rowIndex: number;
  }> = [];
  private lastSnapshotFlush = 0;

  // 节流控制
  private lastEmitTimes: Map<string, number> = new Map();

  // 价格缓存
  private priceCache: PriceUpdate | null = null;

  constructor(
    private redis: Redis,
    private prisma: PrismaClient,
    private priceService: PriceService,
    config?: Partial<RoundConfig>
  ) {
    super();
    this.config = { ...DEFAULT_ROUND_CONFIG, ...config };

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
    if (this.state?.status === 'RUNNING' || this.state?.status === 'BETTING') {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '已有回合进行中');
    }

    // 1. 检查价格可用性
    const startPrice = this.priceService.getLatestPrice();
    if (!startPrice) {
      throw new GameError(ERROR_CODES.PRICE_UNAVAILABLE, '价格服务不可用');
    }

    // 2. 生成 Provably Fair 种子（仅内存保存）
    this.serverSeed = generateServerSeed();
    const commitHash = hashSeed(this.serverSeed);

    const now = Date.now();

    // 3. 创建回合记录（不存储 serverSeed 明文）
    const round = await this.prisma.round.create({
      data: {
        asset: this.config.asset,
        status: 'BETTING',
        commitHash,
        startPrice: startPrice.price,
        startedAt: new Date(now),
      },
    });

    // 4. 初始化状态
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

    // 5. 同步到 Redis
    await this.syncStateToRedis();

    // 6. 启动 Tick 循环
    this.startTickLoop();

    // 7. 广播回合开始
    this.emit('round:start', {
      roundId: round.id,
      asset: this.config.asset,
      commitHash,
      startPrice: startPrice.price,
      startTime: now,
      bettingDuration: this.config.bettingDuration,
      maxDuration: this.config.maxDuration,
    });

    // 8. 投注阶段倒计时
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
    if (!this.state || this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    const roundId = this.state.roundId;
    console.log(`[GameEngine] Ending round ${roundId} (reason: ${reason})`);

    // 1. 停止 Tick
    this.stopTickLoop();

    // 2. 更新状态
    this.state.status = 'SETTLING';
    await this.syncStateToRedis();

    // 3. 结算所有未结算投注
    this.settleAllPendingBets();

    // 4. 等待结算队列处理完成
    await this.flushSettlementQueue();

    // 5. 刷新价格快照
    await this.flushPriceSnapshots();

    // 6. 计算统计
    const stats = this.calculateRoundStats();

    // 7. 更新数据库（此时才写入 serverSeed 明文）
    await this.prisma.round.update({
      where: { id: roundId },
      data: {
        status: 'COMPLETED',
        serverSeed: this.serverSeed,
        endPrice: this.state.currentPrice,
        endedAt: new Date(),
        totalBets: stats.totalBets,
        totalVolume: stats.totalVolume,
        totalPayout: stats.totalPayout,
      },
    });

    // 8. 广播回合结束
    this.emit('round:end', {
      roundId,
      serverSeed: this.serverSeed!,
      endPrice: this.state.currentPrice,
      reason,
      stats: {
        totalBets: stats.totalBets,
        totalWins: stats.totalWins,
        totalPayout: stats.totalPayout,
      },
    });

    // 9. 清理
    this.cleanup();

    console.log(`[GameEngine] Round ${roundId} completed`);
  }

  /**
   * 取消回合并退款
   */
  async cancelRound(reason: string): Promise<void> {
    if (!this.state || this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    const roundId = this.state.roundId;
    console.log(`[GameEngine] Cancelling round ${roundId} (reason: ${reason})`);

    // 1. 停止 Tick
    this.stopTickLoop();

    // 2. 更新状态
    this.state.status = 'SETTLING';

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

    // 6. 清理
    this.cleanup();

    console.log(`[GameEngine] Round ${roundId} cancelled, ${pendingBets.length} bets refunded`);
  }

  /**
   * 退款单个投注
   */
  private async refundBet(bet: ServerBet, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 更新投注状态
      await tx.bet.update({
        where: { id: bet.id },
        data: {
          status: 'REFUNDED',
          settledAt: new Date(),
        },
      });

      // 退还余额
      const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';
      await tx.user.update({
        where: { id: bet.userId },
        data: { [balanceField]: { increment: bet.amount } },
      });
    });

    // 更新内存状态
    bet.status = 'REFUNDED';

    // 通知用户
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

    // 2. 投注频率限制
    if (!this.checkRateLimit(userId)) {
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

    // 4. 金额检查
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `投注金额需在 ${this.config.minBetAmount}-${this.config.maxBetAmount} 之间`
      );
    }

    // 5. 用户投注数量限制
    const userBetCount = Array.from(this.state.activeBets.values()).filter(
      (b) => b.userId === userId && b.status === 'PENDING'
    ).length;
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '已达到最大投注数量');
    }

    // 6. 计算倍率
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    // 7. 幂等性检查 + 分布式锁
    const lockKey = `${REDIS_KEYS.BET_LOCK}${request.orderId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) {
      throw new GameError(ERROR_CODES.DUPLICATE_BET, '重复的投注请求');
    }

    try {
      // 8. 原子扣款 + 记录投注
      const bet = await this.prisma.$transaction(async (tx) => {
        const balanceField = request.isPlayMode ? 'playBalance' : 'balance';

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

        // 创建投注记录
        return tx.bet.create({
          data: {
            userId,
            roundId: this.state!.roundId,
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

      // 11. 广播投注确认（包含 userId 用于定向发送）
      this.emit('bet:confirmed', {
        userId,
        orderId: request.orderId,
        betId: bet.id,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        amount: request.amount,
      });

      console.log(`[GameEngine] Bet ${bet.id} placed by ${userId}`);

      return {
        betId: bet.id,
        multiplier,
        targetTime: request.targetTime,
        targetRow: request.targetRow,
      };
    } finally {
      // 释放锁
      setTimeout(() => this.redis.del(lockKey), 1000);
    }
  }

  /**
   * 投注频率限制检查
   */
  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const windowMs = 1000;
    const maxRequests = this.config.maxBetsPerSecond;

    let timestamps = this.userBetTimestamps.get(userId) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      return false;
    }

    timestamps.push(now);
    this.userBetTimestamps.set(userId, timestamps);
    return true;
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

    // 2. 碰撞检测
    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: SettlementItem[] = [];

    for (const [, bet] of this.state.activeBets) {
      if (bet.status !== 'PENDING') continue;

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
          bet.status = 'WON';
        }
      } else if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        toSettle.push({ bet, isWin: false });
        bet.status = 'LOST';
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
      setImmediate(() => this.endRound('timeout'));
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

      bet.status = isWin ? 'WON' : 'LOST';
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
        const batch = this.settlementQueue.splice(0, 50);

        await this.prisma.$transaction(async (tx) => {
          for (const { bet, isWin, hitDetails } of batch) {
            const payout = isWin ? bet.amount * bet.multiplier : 0;

            await tx.bet.update({
              where: { id: bet.id },
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

            if (isWin && payout > 0) {
              const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';
              await tx.user.update({
                where: { id: bet.userId },
                data: { [balanceField]: { increment: payout } },
              });
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
          }
        });

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
      }
    } catch (error) {
      console.error('[GameEngine] Settlement batch failed:', error);
    } finally {
      this.isSettling = false;
    }
  }

  /**
   * 等待结算队列清空
   */
  private async flushSettlementQueue(): Promise<void> {
    while (this.settlementQueue.length > 0 || this.isSettling) {
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

    this.priceSnapshotBuffer.push({
      roundId: this.state.roundId,
      timestamp: new Date(),
      price: this.state.currentPrice,
      rowIndex: this.state.currentRow,
    });

    // 每秒批量写入
    const now = Date.now();
    if (now - this.lastSnapshotFlush >= 1000 && this.priceSnapshotBuffer.length > 0) {
      this.flushPriceSnapshots().catch(console.error);
    }
  }

  /**
   * 刷新价格快照到数据库
   */
  private async flushPriceSnapshots(): Promise<void> {
    if (this.priceSnapshotBuffer.length === 0) return;

    const toFlush = this.priceSnapshotBuffer.splice(0);
    this.lastSnapshotFlush = Date.now();

    try {
      await this.prisma.priceSnapshot.createMany({ data: toFlush });
    } catch (error) {
      console.error('[GameEngine] Price snapshot flush failed:', error);
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

      // 等待一段时间后取消回合
      setTimeout(() => {
        if (!this.priceService.isPriceAvailable()) {
          this.cancelRound('价格服务不可用').catch(console.error);
        }
      }, 15000);
    }
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.state = null;
    this.serverSeed = null;
    this.userBetTimestamps.clear();
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

  /**
   * 启动自动回合循环
   * 回合结束后自动开始下一回合
   */
  startAutoRound(delayMs = 3000): void {
    if (this.autoRoundEnabled) return;

    this.autoRoundEnabled = true;
    console.log('[GameEngine] Auto-round enabled');

    // 监听回合结束事件
    this.on('round:end', () => this.scheduleNextRound(delayMs));
    this.on('round:cancelled', () => this.scheduleNextRound(delayMs));

    // 立即开始第一回合
    this.startRound().catch((err) => {
      console.error('[GameEngine] Failed to start initial round:', err);
      this.scheduleNextRound(delayMs);
    });
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

    this.removeAllListeners('round:end');
    this.removeAllListeners('round:cancelled');

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
