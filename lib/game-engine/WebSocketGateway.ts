/**
 * WebSocket Gateway - 处理客户端连接和消息路由
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { WS_EVENTS, ERROR_CODES } from './constants';
import type { PlaceBetRequest, GameStateSnapshot, StateSnapshotMessage, UserStateSnapshot } from './types';
import { GameError } from './errors';

export interface WSGatewayConfig {
  cors?: {
    origin: string | string[];
    credentials?: boolean;
  };
  heartbeat?: {
    /**
     * 服务端主动推送 PONG 的间隔（ms），用于连接保活/延迟检测
     * 默认 25000ms
     */
    intervalMs?: number;
  };
  stateSync?: {
    /**
     * 连接后是否重放当前 Round 下注（用于旧客户端恢复）
     * 默认 true
     */
    replayCurrentRoundBets?: boolean;
    /**
     * 状态快照返回的历史下注数量（默认 20）
     */
    historyLimit?: number;
  };
  deps?: {
    gameEngine?: GameEnginePort;
    priceService?: PriceServicePort;
    verifyToken?: (token: string) => Promise<string | null>;
    verifyTokenFromCookie?: (socket: AuthenticatedSocket) => Promise<string | null>;
  };
}

export interface AuthenticatedSocket extends Socket {
  userId?: string;
  isAuthenticated?: boolean;
}

export interface GameEnginePort {
  getState: () => any;
  getConfig: () => any;
  placeBet: (userId: string, request: PlaceBetRequest) => Promise<unknown>;
  stop: () => Promise<void>;
  removeAllListeners: (event?: string) => unknown;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
}

export interface PriceServicePort {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  removeAllListeners: (event?: string) => unknown;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
}

export class WebSocketGateway {
  private io: SocketIOServer;
  private gameEngine: GameEnginePort | null;
  private priceService: PriceServicePort | null;
  private connectedUsers: Map<string, Set<string>> = new Map(); // userId -> socketIds
  private allowedOrigins: Set<string>;
  private readonly heartbeatIntervalMs: number;
  private readonly replayCurrentRoundBets: boolean;
  private readonly historyLimit: number;
  private readonly verifyToken: (token: string) => Promise<string | null>;
  private readonly verifyTokenFromCookie: (socket: AuthenticatedSocket) => Promise<string | null>;
  private readonly socketHeartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private gameEngineListenersReady = false;

  constructor(
    httpServer: HTTPServer,
    private redis: Redis,
    private prisma: PrismaClient,
    config?: WSGatewayConfig
  ) {
    // 验证 AUTH_SECRET (兼容 NEXTAUTH_SECRET)
    const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (!authSecret) {
      console.warn('[WSGateway] AUTH_SECRET not configured - authentication will fail');
    }

    // 初始化 Socket.IO
    const normalizeOrigin = (origin: string) => origin.trim().replace(/\/$/, '').toLowerCase();
    const rawCorsOrigin = config?.cors?.origin ?? process.env.WS_CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'];
    const corsOrigin = (Array.isArray(rawCorsOrigin) ? rawCorsOrigin : [rawCorsOrigin])
      .map(normalizeOrigin)
      .filter(Boolean);

    this.allowedOrigins = new Set(corsOrigin);

    const cors = config?.cors
      ? { ...config.cors, origin: corsOrigin }
      : {
        origin: corsOrigin,
        credentials: true,
      };
    this.io = new SocketIOServer(httpServer, {
      cors,
      transports: ['websocket', 'polling'],
    });

    this.heartbeatIntervalMs = Math.max(1000, config?.heartbeat?.intervalMs ?? 25_000);
    this.replayCurrentRoundBets = config?.stateSync?.replayCurrentRoundBets ?? true;
    this.historyLimit = Math.max(0, Math.min(200, config?.stateSync?.historyLimit ?? 20));

    this.gameEngine = config?.deps?.gameEngine ?? null;
    this.priceService = config?.deps?.priceService ?? null;

    this.verifyToken =
      config?.deps?.verifyToken ??
      (async (token: string) => {
        const { verifyNextAuthToken } = await import('./wsAuth');
        return verifyNextAuthToken({ token, prisma: this.prisma });
      });

    this.verifyTokenFromCookie =
      config?.deps?.verifyTokenFromCookie ??
      (async (socket: AuthenticatedSocket) => {
        const { verifyNextAuthCookie } = await import('./wsAuth');
        return verifyNextAuthCookie({ req: socket.request as any, prisma: this.prisma });
      });

    this.setupEventHandlers();
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    await this.ensureServicesReady();
    await this.priceService!.start();
    console.log('[WSGateway] Started');
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    for (const timer of this.socketHeartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.socketHeartbeatTimers.clear();

    if (this.gameEngine) {
      await this.gameEngine.stop();
      this.gameEngine.removeAllListeners();
    }
    if (this.priceService) {
      await this.priceService.stop();
      this.priceService.removeAllListeners();
    }
    this.io.close();
    console.log('[WSGateway] Stopped');
  }

  /**
   * 获取 GameEngine 实例
   */
  getGameEngine(): import('./GameEngine').GameEngine {
    if (!this.gameEngine) {
      throw new Error('GameEngine not initialized. Did you forget to call gateway.start()?');
    }
    return this.gameEngine as unknown as import('./GameEngine').GameEngine;
  }

  /**
   * 获取 PriceService 实例
   */
  getPriceService(): import('./PriceService').PriceService {
    if (!this.priceService) {
      throw new Error('PriceService not initialized. Did you forget to call gateway.start()?');
    }
    return this.priceService as unknown as import('./PriceService').PriceService;
  }

  private async ensureServicesReady(): Promise<void> {
    if (!this.priceService) {
      const { PriceService } = await import('./PriceService');
      this.priceService = new PriceService(
        {
          asset: 'BTC',
          allowStartWithoutConnection: true,
        },
        this.redis
      ) as unknown as PriceServicePort;
    }

    if (!this.gameEngine) {
      const { GameEngine } = await import('./GameEngine');
      this.gameEngine = new GameEngine(this.redis, this.prisma, this.priceService as any) as unknown as GameEnginePort;
    }

    if (!this.gameEngineListenersReady) {
      this.setupGameEngineListeners();
      this.gameEngineListenersReady = true;
    }
  }

  private isOriginAllowed(socket: AuthenticatedSocket): boolean {
    const originHeader = socket.handshake?.headers?.origin ?? socket.request?.headers?.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!origin || typeof origin !== 'string') return false;

    const normalizedOrigin = origin.trim().replace(/\/$/, '').toLowerCase();
    if (this.allowedOrigins.has('*')) return true;
    return this.allowedOrigins.has(normalizedOrigin);
  }

  /**
   * 设置 Socket 事件处理
   */
  private setupEventHandlers(): void {
    this.io.on('connection', async (socket: AuthenticatedSocket) => {
      if (!this.isOriginAllowed(socket)) {
        const originHeader = socket.handshake?.headers?.origin ?? socket.request?.headers?.origin;
        const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
        console.warn(`[WSGateway] Rejected connection from origin: ${origin ?? 'unknown'}`);
        socket.disconnect(true);
        return;
      }

      console.log(`[WSGateway] Client connected: ${socket.id}`);

      this.registerSocketHandlers(socket);

      // 自动从 Cookie 认证（允许匿名）
      await this.handleAutoAuth(socket);

      // 连接后进行完整状态同步（匿名也需要）
      void this.syncStateForSocket(socket, { reason: 'connect' }).catch((error) => {
        console.error('[WSGateway] Failed to sync state after connect:', error);
      });
    });
  }

  private registerSocketHandlers(socket: AuthenticatedSocket): void {
    // 服务端主动心跳：定期发送 PONG（不依赖客户端 ping）
    const timer = setInterval(() => {
      if (socket.connected) {
        socket.emit(WS_EVENTS.PONG, { timestamp: Date.now() });
      }
    }, this.heartbeatIntervalMs);
    this.socketHeartbeatTimers.set(socket.id, timer);

    // 客户端心跳：ping -> pong
    socket.on(WS_EVENTS.PING, () => {
      socket.emit(WS_EVENTS.PONG, { timestamp: Date.now() });
    });

    // 显式认证（兼容非 Cookie 场景）
    socket.on(WS_EVENTS.AUTH, (data: { token: string }) => {
      void this.handleAuth(socket, data).catch((error) => {
        console.error('[WSGateway] Unhandled error in auth handler:', error);
      });
    });

    // 客户端请求状态快照（用于重连/主动同步）
    socket.on(
      WS_EVENTS.STATE_REQUEST,
      (payload?: { includeHistory?: boolean; historyLimit?: number }) => {
        void this.syncStateForSocket(socket, {
          reason: 'state_request',
          includeHistory: payload?.includeHistory,
          historyLimit: payload?.historyLimit,
        }).catch((error) => {
          console.error('[WSGateway] Failed to sync state after state_request:', error);
        });
      }
    );

    // 下注 - 包装异常处理防止未处理的 Promise 拒绝
    socket.on(WS_EVENTS.PLACE_BET, (data) => {
      void this.handlePlaceBet(socket, data as PlaceBetRequest).catch((error) => {
        console.error('[WSGateway] Unhandled error in place_bet handler:', error);
        socket.emit(WS_EVENTS.BET_REJECTED, {
          type: WS_EVENTS.BET_REJECTED,
          payload: {
            orderId: (data as any)?.orderId ?? 'unknown',
            code: 'INTERNAL_ERROR',
            message: '服务器内部错误',
          },
          timestamp: Date.now(),
        });
      });
    });

    // 断开连接
    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  private async syncStateForSocket(
    socket: AuthenticatedSocket,
    options: { reason: 'connect' | 'auth' | 'state_request'; includeHistory?: boolean; historyLimit?: number }
  ): Promise<void> {
    const game = this.buildGameStateSnapshot();
    const includeHistory = options.includeHistory ?? true;
    const historyLimit = options.historyLimit ?? this.historyLimit;

    const user =
      socket.isAuthenticated && socket.userId
        ? await this.buildUserStateSnapshot(socket.userId, { includeHistory, historyLimit })
        : null;

    const message: StateSnapshotMessage = {
      type: WS_EVENTS.STATE_SNAPSHOT,
      payload: {
        serverTime: Date.now(),
        connectionId: socket.id,
        isAuthenticated: Boolean(socket.isAuthenticated && socket.userId),
        userId: socket.userId ?? null,
        game,
        user,
      },
      timestamp: Date.now(),
    };

    socket.emit(WS_EVENTS.STATE_SNAPSHOT, message);

    // 旧客户端兼容：通过既有事件初始化/恢复 Round 状态
    this.emitLegacyGameSnapshot(socket, game);

    // 旧客户端兼容：重放当前 Round 的下注（用于重连恢复 activeBets）
    if (this.replayCurrentRoundBets && socket.isAuthenticated && socket.userId && game.roundId) {
      await this.replayCurrentRoundBetEvents(socket, socket.userId, game.roundId);
    }
  }

  private buildGameStateSnapshot(): GameStateSnapshot {
    const config = this.gameEngine?.getConfig?.() ?? { asset: 'BTCUSDT', bettingDuration: 5, maxDuration: 60 };
    const state = this.gameEngine?.getState?.() ?? null;

    if (!state) {
      return {
        roundId: null,
        status: null,
        asset: config.asset ?? 'BTCUSDT',
        startPrice: 0,
        currentPrice: 0,
        currentRow: 6.5,
        elapsed: 0,
        startTime: 0,
        bettingDuration: this.toNumber(config.bettingDuration, 5),
        maxDuration: this.toNumber(config.maxDuration, 60),
      };
    }

    return {
      roundId: state.roundId ?? null,
      status: state.status ?? null,
      asset: state.asset ?? config.asset ?? 'BTCUSDT',
      startPrice: this.toNumber(state.startPrice, 0),
      currentPrice: this.toNumber(state.currentPrice, 0),
      currentRow: this.toNumber(state.currentRow, 6.5),
      elapsed: this.toNumber(state.elapsed, 0),
      startTime: this.toNumber(state.roundStartTime, 0),
      bettingDuration: this.toNumber(config.bettingDuration, 5),
      maxDuration: this.toNumber(config.maxDuration, 60),
    };
  }

  private async buildUserStateSnapshot(
    userId: string,
    options: { includeHistory: boolean; historyLimit: number }
  ): Promise<UserStateSnapshot> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true, playBalance: true },
    });

    const snapshot: UserStateSnapshot = {
      balance: this.toNumber(user?.balance, 0),
      playBalance: this.toNumber(user?.playBalance, 0),
      recentBets: [],
    };

    if (!options.includeHistory || options.historyLimit <= 0) {
      return snapshot;
    }

    const bets = await this.prisma.bet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: options.historyLimit,
      select: {
        id: true,
        orderId: true,
        roundId: true,
        amount: true,
        multiplier: true,
        targetRow: true,
        targetTime: true,
        rowIndex: true,
        colIndex: true,
        status: true,
        isWin: true,
        payout: true,
        isPlayMode: true,
        hitPrice: true,
        hitRow: true,
        hitTime: true,
        createdAt: true,
        settledAt: true,
      },
    });

    snapshot.recentBets = bets.map((bet: any) => {
      const targetRow = bet.targetRow ?? bet.rowIndex;
      const targetTime = bet.targetTime ?? bet.colIndex;
      const hasHitDetails = bet.hitPrice != null && bet.hitRow != null && bet.hitTime != null;

      return {
        betId: bet.id,
        orderId: bet.orderId ?? null,
        roundId: bet.roundId ?? null,
        amount: this.toNumber(bet.amount, 0),
        multiplier: this.toNumber(bet.multiplier, 0),
        targetRow: targetRow != null ? this.toNumber(targetRow, 0) : null,
        targetTime: targetTime != null ? this.toNumber(targetTime, 0) : null,
        status: bet.status,
        isWin: Boolean(bet.isWin),
        payout: this.toNumber(bet.payout, 0),
        isPlayMode: Boolean(bet.isPlayMode),
        hitDetails: hasHitDetails
          ? {
              hitPrice: this.toNumber(bet.hitPrice, 0),
              hitRow: this.toNumber(bet.hitRow, 0),
              hitTime: this.toNumber(bet.hitTime, 0),
            }
          : undefined,
        createdAt: bet.createdAt instanceof Date ? bet.createdAt.getTime() : this.toNumber(bet.createdAt, 0),
        settledAt: bet.settledAt instanceof Date ? bet.settledAt.getTime() : bet.settledAt == null ? null : this.toNumber(bet.settledAt, 0),
      };
    });

    return snapshot;
  }

  private emitLegacyGameSnapshot(socket: AuthenticatedSocket, game: GameStateSnapshot): void {
    if (!game.roundId || !game.status) {
      return;
    }

    socket.emit(WS_EVENTS.ROUND_START, {
      type: WS_EVENTS.ROUND_START,
      payload: {
        roundId: game.roundId,
        asset: game.asset,
        startPrice: game.startPrice,
        startTime: game.startTime,
        bettingDuration: game.bettingDuration,
        maxDuration: game.maxDuration,
      },
      timestamp: Date.now(),
    });

    if (game.status !== 'BETTING') {
      socket.emit(WS_EVENTS.ROUND_RUNNING, {
        type: WS_EVENTS.ROUND_RUNNING,
        payload: { roundId: game.roundId },
        timestamp: Date.now(),
      });
    }

    socket.emit(WS_EVENTS.STATE_UPDATE, {
      type: WS_EVENTS.STATE_UPDATE,
      payload: {
        elapsed: game.elapsed,
        currentPrice: game.currentPrice,
        currentRow: game.currentRow,
      },
      timestamp: Date.now(),
    });
  }

  private async replayCurrentRoundBetEvents(socket: AuthenticatedSocket, userId: string, roundId: string): Promise<void> {
    const bets = await this.prisma.bet.findMany({
      where: { userId, roundId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        orderId: true,
        amount: true,
        multiplier: true,
        targetRow: true,
        targetTime: true,
        rowIndex: true,
        colIndex: true,
        status: true,
        payout: true,
        hitPrice: true,
        hitRow: true,
        hitTime: true,
      },
    });

    for (const bet of bets as any[]) {
      if (!bet.orderId) continue;

      const targetRow = bet.targetRow ?? bet.rowIndex;
      const targetTime = bet.targetTime ?? bet.colIndex;

      socket.emit(WS_EVENTS.BET_CONFIRMED, {
        type: WS_EVENTS.BET_CONFIRMED,
        payload: {
          orderId: bet.orderId,
          betId: bet.id,
          multiplier: this.toNumber(bet.multiplier, 0),
          targetRow: this.toNumber(targetRow, 0),
          targetTime: this.toNumber(targetTime, 0),
          amount: this.toNumber(bet.amount, 0),
        },
        timestamp: Date.now(),
      });

      if (bet.status === 'WON' || bet.status === 'LOST') {
        const hasHitDetails = bet.hitPrice != null && bet.hitRow != null && bet.hitTime != null;
        socket.emit(WS_EVENTS.BET_SETTLED, {
          type: WS_EVENTS.BET_SETTLED,
          payload: {
            betId: bet.id,
            orderId: bet.orderId,
            isWin: bet.status === 'WON',
            payout: this.toNumber(bet.payout, 0),
            hitDetails: hasHitDetails
              ? {
                  hitPrice: this.toNumber(bet.hitPrice, 0),
                  hitRow: this.toNumber(bet.hitRow, 0),
                  hitTime: this.toNumber(bet.hitTime, 0),
                }
              : undefined,
          },
          timestamp: Date.now(),
        });
      }

      if (bet.status === 'REFUNDED') {
        socket.emit(WS_EVENTS.BET_REFUNDED, {
          type: WS_EVENTS.BET_REFUNDED,
          payload: {
            betId: bet.id,
            orderId: bet.orderId,
            userId,
            amount: this.toNumber(bet.amount, 0),
            reason: 'reconnect_sync',
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    if (value == null) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    const maybeToNumber = (value as any)?.toNumber;
    if (typeof maybeToNumber === 'function') {
      try {
        const num = maybeToNumber.call(value);
        return Number.isFinite(num) ? num : fallback;
      } catch {
        return fallback;
      }
    }
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : fallback;
  }

  /**
   * 设置 GameEngine 事件监听
   */
  private setupGameEngineListeners(): void {
    if (!this.gameEngine || !this.priceService) {
      return;
    }

    // 回合开始
    this.gameEngine.on('round:start', (data) => {
      this.io.emit(WS_EVENTS.ROUND_START, {
        type: WS_EVENTS.ROUND_START,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 回合运行中
    this.gameEngine.on('round:running', (data) => {
      this.io.emit(WS_EVENTS.ROUND_RUNNING, {
        type: WS_EVENTS.ROUND_RUNNING,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 回合结束
    this.gameEngine.on('round:end', (data) => {
      this.io.emit(WS_EVENTS.ROUND_END, {
        type: WS_EVENTS.ROUND_END,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 回合取消
    this.gameEngine.on('round:cancelled', (data) => {
      this.io.emit(WS_EVENTS.ROUND_CANCELLED, {
        type: WS_EVENTS.ROUND_CANCELLED,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 状态更新
    this.gameEngine.on('state:update', (data) => {
      this.io.emit(WS_EVENTS.STATE_UPDATE, {
        type: WS_EVENTS.STATE_UPDATE,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 投注确认（发送给下注用户，包括匿名用户）
    this.gameEngine.on('bet:confirmed', (data) => {
      if (data.userId.startsWith('anon-')) {
        // 匿名用户：直接通过 socket.id 发送
        const socketId = data.userId.replace('anon-', '');
        this.io.to(socketId).emit(WS_EVENTS.BET_CONFIRMED, {
          type: WS_EVENTS.BET_CONFIRMED,
          payload: data,
          timestamp: Date.now(),
        });
      } else {
        // 已登录用户：通过用户房间发送
        this.emitToUser(data.userId, WS_EVENTS.BET_CONFIRMED, {
          type: WS_EVENTS.BET_CONFIRMED,
          payload: data,
          timestamp: Date.now(),
        });
      }
    });

    // 投注结算
    this.gameEngine.on('bet:settled', (data) => {
      if (data.userId.startsWith('anon-')) {
        const socketId = data.userId.replace('anon-', '');
        this.io.to(socketId).emit(WS_EVENTS.BET_SETTLED, {
          type: WS_EVENTS.BET_SETTLED,
          payload: data,
          timestamp: Date.now(),
        });
      } else {
        this.emitToUser(data.userId, WS_EVENTS.BET_SETTLED, {
          type: WS_EVENTS.BET_SETTLED,
          payload: data,
          timestamp: Date.now(),
        });
      }
    });

    // 投注退款
    this.gameEngine.on('bet:refunded', (data) => {
      if (data.userId.startsWith('anon-')) {
        const socketId = data.userId.replace('anon-', '');
        this.io.to(socketId).emit(WS_EVENTS.BET_REFUNDED, {
          type: WS_EVENTS.BET_REFUNDED,
          payload: data,
          timestamp: Date.now(),
        });
      } else {
        this.emitToUser(data.userId, WS_EVENTS.BET_REFUNDED, {
          type: WS_EVENTS.BET_REFUNDED,
          payload: data,
          timestamp: Date.now(),
        });
      }
    });

    // 价格更新
    this.priceService.on('price', (data) => {
      this.io.emit(WS_EVENTS.PRICE_UPDATE, {
        type: WS_EVENTS.PRICE_UPDATE,
        payload: {
          price: data.price,
          rowIndex: this.gameEngine.getState()?.currentRow ?? 6.5,
          timestamp: data.timestamp,
        },
        timestamp: Date.now(),
      });
    });

    // 价格服务严重故障
    this.priceService.on('critical_failure', () => {
      console.error('[WSGateway] PriceService critical failure detected');
    });
  }

  /**
   * 处理认证
   */
  private async handleAuth(socket: AuthenticatedSocket, data: { token: string }): Promise<void> {
    try {
      const token = data?.token;
      if (!token || typeof token !== 'string') {
        socket.emit(WS_EVENTS.AUTH_RESULT, {
          type: WS_EVENTS.AUTH_RESULT,
          payload: { success: false, error: '无效的 token' },
          timestamp: Date.now(),
        });
        return;
      }

      const userId = await this.verifyToken(token);

      if (!userId) {
        socket.emit(WS_EVENTS.AUTH_RESULT, {
          type: WS_EVENTS.AUTH_RESULT,
          payload: { success: false, error: '认证失败' },
          timestamp: Date.now(),
        });
        return;
      }

      // 如果之前已绑定其他 userId，先清理
      if (socket.userId && socket.userId !== userId) {
        const oldSockets = this.connectedUsers.get(socket.userId);
        if (oldSockets) {
          oldSockets.delete(socket.id);
          if (oldSockets.size === 0) {
            this.connectedUsers.delete(socket.userId);
          }
        }
        socket.leave(`user:${socket.userId}`);
      }

      socket.userId = userId;
      socket.isAuthenticated = true;

      // 记录连接
      if (!this.connectedUsers.has(userId)) {
        this.connectedUsers.set(userId, new Set());
      }
      this.connectedUsers.get(userId)!.add(socket.id);

      // 加入用户房间
      socket.join(`user:${userId}`);

      socket.emit(WS_EVENTS.AUTH_RESULT, {
        type: WS_EVENTS.AUTH_RESULT,
        payload: { success: true, userId },
        timestamp: Date.now(),
      });

      console.log(`[WSGateway] User ${userId} authenticated`);

      void this.syncStateForSocket(socket, { reason: 'auth' }).catch((error) => {
        console.error('[WSGateway] Failed to sync state after auth:', error);
      });
    } catch (error) {
      socket.emit(WS_EVENTS.AUTH_RESULT, {
        type: WS_EVENTS.AUTH_RESULT,
        payload: { success: false, error: '认证失败' },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 自动从Cookie认证
   * 允许匿名连接观看游戏，但真金投注需要登录
   */
  private async handleAutoAuth(socket: AuthenticatedSocket): Promise<void> {
    try {
      const userId = await this.verifyTokenFromCookie(socket);

      if (!userId) {
        // 允许匿名连接（只读）
        socket.userId = undefined;
        socket.isAuthenticated = false;
        socket.emit(WS_EVENTS.AUTH_RESULT, {
          type: WS_EVENTS.AUTH_RESULT,
          payload: { success: true, userId: null, isAnonymous: true },
          timestamp: Date.now(),
        });
        console.log(`[WSGateway] Anonymous user connected: ${socket.id}`);
        return;
      }

      socket.userId = userId;
      socket.isAuthenticated = true;

      // 记录连接
      if (!this.connectedUsers.has(userId)) {
        this.connectedUsers.set(userId, new Set());
      }
      this.connectedUsers.get(userId)!.add(socket.id);

      // 加入用户房间
      socket.join(`user:${userId}`);

      socket.emit(WS_EVENTS.AUTH_RESULT, {
        type: WS_EVENTS.AUTH_RESULT,
        payload: { success: true, userId },
        timestamp: Date.now(),
      });

      console.log(`[WSGateway] User ${userId} authenticated via cookie`);
    } catch (error) {
      console.error('[WSGateway] Auto auth failed:', error);
      // 降级为匿名连接
      socket.userId = undefined;
      socket.isAuthenticated = false;
      socket.emit(WS_EVENTS.AUTH_RESULT, {
        type: WS_EVENTS.AUTH_RESULT,
        payload: { success: true, userId: null, isAnonymous: true },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 处理下注
   */
  private async handlePlaceBet(socket: AuthenticatedSocket, data: PlaceBetRequest): Promise<void> {
    // 输入验证:确保data存在且包含必需字段
    if (!data || typeof data !== 'object') {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: 'unknown',
          code: 'INVALID_REQUEST',
          message: '无效的请求数据',
        },
        timestamp: Date.now(),
      });
      return;
    }

    // 验证必需字段
    if (!data.orderId || typeof data.orderId !== 'string') {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: 'unknown',
          code: 'INVALID_REQUEST',
          message: '缺少orderId字段',
        },
        timestamp: Date.now(),
      });
      return;
    }

    if (typeof data.amount !== 'number' || typeof data.targetRow !== 'number' || typeof data.targetTime !== 'number') {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: data.orderId,
          code: 'INVALID_REQUEST',
          message: '投注参数类型错误',
        },
        timestamp: Date.now(),
      });
      return;
    }

    // 匿名连接只读：所有下注都需要登录
    if (!socket.isAuthenticated || !socket.userId) {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: data.orderId,
          code: 'UNAUTHORIZED',
          message: '下注需要登录',
        },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      if (!this.gameEngine) {
        throw new Error('GameEngine not ready');
      }
      await this.gameEngine.placeBet(socket.userId, data);
      // 注意: bet_confirmed 事件会由 GameEngine 通过 emit('bet:confirmed') 触发
      // setupGameEngineListeners() 会监听该事件并发送给用户,无需在此处重复发送
    } catch (error) {
      const gameError = error instanceof GameError ? error : new GameError(ERROR_CODES.INTERNAL_ERROR, '服务器错误');

      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: data.orderId,
          code: gameError.code,
          message: gameError.message,
        },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(socket: AuthenticatedSocket): void {
    const timer = this.socketHeartbeatTimers.get(socket.id);
    if (timer) {
      clearInterval(timer);
      this.socketHeartbeatTimers.delete(socket.id);
    }

    if (socket.userId) {
      const userSockets = this.connectedUsers.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          this.connectedUsers.delete(socket.userId);
        }
      }
    }
    console.log(`[WSGateway] Client disconnected: ${socket.id}`);
  }

  /**
   * 发送消息给特定用户
   */
  private emitToUser(userId: string, event: string, data: unknown): void {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /**
   * 广播消息
   */
  broadcast(event: string, data: unknown): void {
    this.io.emit(event, data);
  }

  /**
   * 获取连接统计
   */
  getStats(): { totalConnections: number; authenticatedUsers: number } {
    return {
      totalConnections: this.io.sockets.sockets.size,
      authenticatedUsers: this.connectedUsers.size,
    };
  }
}
