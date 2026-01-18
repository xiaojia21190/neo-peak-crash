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

  constructor(
    httpServer: HTTPServer,
    private redis: Redis,
    private prisma: PrismaClient,
    config?: WSGatewayConfig
  ) {
    // 初始化 Socket.IO
    this.io = new SocketIOServer(httpServer, {
      cors: config?.cors || {
        origin: '*',
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    // 初始化 PriceService
    this.priceService = new PriceService({ asset: 'BTC' }, redis);

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
    this.priceService.stop();
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
   * 设置 Socket 事件处理
   */
  private setupEventHandlers(): void {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`[WSGateway] Client connected: ${socket.id}`);

      // 认证
      socket.on(WS_EVENTS.AUTH, (data) => this.handleAuth(socket, data));

      // 下注
      socket.on(WS_EVENTS.PLACE_BET, (data) => this.handlePlaceBet(socket, data));

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

    // 投注确认（仅发送给下注用户）
    this.gameEngine.on('bet:confirmed', (data) => {
      this.emitToUser(data.userId, WS_EVENTS.BET_CONFIRMED, {
        type: WS_EVENTS.BET_CONFIRMED,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 投注结算
    this.gameEngine.on('bet:settled', (data) => {
      this.emitToUser(data.userId, WS_EVENTS.BET_SETTLED, {
        type: WS_EVENTS.BET_SETTLED,
        payload: data,
        timestamp: Date.now(),
      });
    });

    // 投注退款
    this.gameEngine.on('bet:refunded', (data) => {
      this.emitToUser(data.userId, WS_EVENTS.BET_REFUNDED, {
        type: WS_EVENTS.BET_REFUNDED,
        payload: data,
        timestamp: Date.now(),
      });
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
   * 处理下注
   */
  private async handlePlaceBet(socket: AuthenticatedSocket, data: PlaceBetRequest): Promise<void> {
    if (!socket.isAuthenticated || !socket.userId) {
      socket.emit(WS_EVENTS.BET_REJECTED, {
        type: WS_EVENTS.BET_REJECTED,
        payload: {
          orderId: data.orderId,
          code: 'UNAUTHORIZED',
          message: '请先登录',
        },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      const result = await this.gameEngine.placeBet(socket.userId, data);

      // 获取最新余额
      const user = await this.prisma.user.findUnique({
        where: { id: socket.userId },
        select: { balance: true, playBalance: true },
      });

      socket.emit(WS_EVENTS.BET_CONFIRMED, {
        type: WS_EVENTS.BET_CONFIRMED,
        payload: {
          ...result,
          orderId: data.orderId,
          amount: data.amount,
          newBalance: data.isPlayMode
            ? Number(user?.playBalance ?? 0)
            : Number(user?.balance ?? 0),
        },
        timestamp: Date.now(),
      });
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
      // 注意：这需要 NEXTAUTH_SECRET 环境变量
      const { decode } = await import('next-auth/jwt');
      const secret = process.env.NEXTAUTH_SECRET;

      if (!secret) {
        console.error('[WSGateway] NEXTAUTH_SECRET not configured');
        return null;
      }

      const decoded = await decode({
        token,
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
      console.error('[WSGateway] Token verification failed:', error);
      return null;
    }
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
