/**
 * WebSocket Gateway - 处理客户端连接和消息路由
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { GameEngine } from './GameEngine';
import { PriceService } from './PriceService';
import { WS_EVENTS, ERROR_CODES } from './constants';
import type { PlaceBetRequest } from './types';
import { GameError } from './errors';

export interface WSGatewayConfig {
  cors?: {
    origin: string | string[];
    credentials?: boolean;
  };
}

export interface AuthenticatedSocket extends Socket {
  userId?: string;
  isAuthenticated?: boolean;
}

export class WebSocketGateway {
  private io: SocketIOServer;
  private gameEngine: GameEngine;
  private priceService: PriceService;
  private connectedUsers: Map<string, Set<string>> = new Map(); // userId -> socketIds
  private allowedOrigins: Set<string>;

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

    // 初始化 PriceService
    this.priceService = new PriceService({
      asset: 'BTC',
      allowStartWithoutConnection: true
    }, redis);

    // 初始化 GameEngine
    this.gameEngine = new GameEngine(redis, prisma, this.priceService);

    this.setupEventHandlers();
    this.setupGameEngineListeners();
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    await this.priceService.start();
    console.log('[WSGateway] Started');
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    await this.gameEngine.stop();
    await this.priceService.stop();
    this.gameEngine.removeAllListeners();
    this.priceService.removeAllListeners();
    this.io.close();
    console.log('[WSGateway] Stopped');
  }

  /**
   * 获取 GameEngine 实例
   */
  getGameEngine(): GameEngine {
    return this.gameEngine;
  }

  /**
   * 获取 PriceService 实例
   */
  getPriceService(): PriceService {
    return this.priceService;
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

      // 自动从Cookie认证
      await this.handleAutoAuth(socket);
      if (!socket.isAuthenticated) {
        return;
      }

      // 发送当前游戏状态给新连接的用户
      const currentState = this.gameEngine.getState();
      if (currentState) {
        socket.emit(WS_EVENTS.STATE_UPDATE, {
          type: WS_EVENTS.STATE_UPDATE,
          payload: {
            roundId: currentState.roundId,
            status: currentState.status,
            asset: currentState.asset,
            startPrice: currentState.startPrice,
            currentPrice: currentState.currentPrice,
            currentRow: currentState.currentRow,
            elapsed: currentState.elapsed,
            bettingDuration: this.gameEngine.getConfig().bettingDuration,
            maxDuration: this.gameEngine.getConfig().maxDuration,
          },
          timestamp: Date.now(),
        });
      }

      // 下注 - 包装异常处理防止未处理的Promise拒绝
      socket.on(WS_EVENTS.PLACE_BET, (data) => {
        void this.handlePlaceBet(socket, data).catch((error) => {
          console.error('[WSGateway] Unhandled error in place_bet handler:', error);
          // 发送通用错误响应
          socket.emit(WS_EVENTS.BET_REJECTED, {
            type: WS_EVENTS.BET_REJECTED,
            payload: {
              orderId: data?.orderId ?? 'unknown',
              code: 'INTERNAL_ERROR',
              message: '服务器内部错误',
            },
            timestamp: Date.now(),
          });
        });
      });

      // 心跳
      socket.on(WS_EVENTS.PING, () => {
        socket.emit(WS_EVENTS.PONG, { timestamp: Date.now() });
      });

      // 断开连接
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });
  }

  /**
   * 设置 GameEngine 事件监听
   */
  private setupGameEngineListeners(): void {
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
      // TODO: 验证 JWT token 并获取用户信息
      // 这里简化为直接从 token 中获取 userId
      const userId = await this.verifyToken(data.token);

      if (!userId) {
        socket.emit(WS_EVENTS.AUTH_RESULT, {
          type: WS_EVENTS.AUTH_RESULT,
          payload: { success: false, error: '认证失败' },
          timestamp: Date.now(),
        });
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

      console.log(`[WSGateway] User ${userId} authenticated`);
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
      if (!this.isOriginAllowed(socket)) {
        socket.disconnect(true);
        return;
      }

      const userId = await this.verifyTokenFromCookie(socket);

      if (!userId) {
        // 允许匿名连接（游玩模式）
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

    // 真金模式必须登录，游玩模式允许匿名
    if (!data.isPlayMode && (!socket.isAuthenticated || !socket.userId)) {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: data.orderId,
          code: 'UNAUTHORIZED',
          message: '真金投注需要登录',
        },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      // 游玩模式允许匿名，使用临时 ID
      const effectiveUserId = socket.userId ?? `anon-${socket.id}`;
      await this.gameEngine.placeBet(effectiveUserId, data);
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
   * 验证 NextAuth JWT token
   */
  private async verifyToken(token: string): Promise<string | null> {
    try {
      if (!token) return null;

      // 使用 NextAuth 的 decode 方法验证 JWT
      // 注意：这需要 AUTH_SECRET 或 NEXTAUTH_SECRET 环境变量
      const { decode } = await import('next-auth/jwt');
      const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;

      if (!secret) {
        console.error('[WSGateway] AUTH_SECRET not configured');
        return null;
      }

      const decoded = await decode({
        token,
        secret,
        salt: '',
      });

      if (!decoded?.id) {
        return null;
      }

      // 验证用户是否存在
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.id as string },
        select: { id: true },
      });

      return user?.id ?? null;
    } catch (error) {
      console.error('[WSGateway] Token verification failed:', error);
      return null;
    }
  }

  /**
   * 从Cookie验证NextAuth session
   */
  private async verifyTokenFromCookie(socket: AuthenticatedSocket): Promise<string | null> {
    try {
      const cookieHeader = socket.request.headers.cookie;
      if (!cookieHeader) {
        return null;
      }

      // 解析Cookie获取NextAuth session token
      const cookies = this.parseCookies(cookieHeader);
      const sessionToken =
        cookies['authjs.session-token'] ||
        cookies['__Secure-authjs.session-token'] ||
        cookies['next-auth.session-token'] ||
        cookies['__Secure-next-auth.session-token'];

      if (!sessionToken) {
        return null;
      }

      // 使用NextAuth的getToken验证
      const { getToken } = await import('next-auth/jwt');
      const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;

      if (!secret) {
        console.error('[WSGateway] AUTH_SECRET not configured');
        return null;
      }

      const decoded = await getToken({
        req: socket.request as any,
        secret,
      });

      if (!decoded?.id) {
        return null;
      }

      // 验证用户是否存在
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.id as string },
        select: { id: true },
      });

      return user?.id ?? null;
    } catch (error) {
      console.error('[WSGateway] Cookie verification failed:', error);
      return null;
    }
  }

  /**
   * 解析Cookie字符串
   */
  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach((cookie) => {
      const [name, ...rest] = cookie.split('=');
      cookies[name.trim()] = rest.join('=').trim();
    });
    return cookies;
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
