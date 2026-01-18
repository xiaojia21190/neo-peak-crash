"use client";

/**
 * 游戏客户端 SDK - 连接 WebSocket Gateway
 */

import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { WS_EVENTS } from './constants';
import type {
  PlaceBetRequest,
  RoundStatus,
  BetStatus,
  HitDetails,
} from './types';

// 客户端状态
export interface ClientGameState {
  roundId: string | null;
  status: RoundStatus | null;
  asset: string;
  startPrice: number;
  currentPrice: number;
  currentRow: number;
  elapsed: number;
  startTime: number;
  commitHash: string;
  bettingDuration: number;
  maxDuration: number;
  activeBets: ClientBet[];
  serverSeed?: string;
}

export interface ClientBet {
  betId: string;
  orderId: string;
  amount: number;
  multiplier: number;
  targetRow: number;
  targetTime: number;
  status: BetStatus;
  isWin?: boolean;
  payout?: number;
  hitDetails?: HitDetails;
}

interface PendingBet {
  resolve: (result: ClientBet) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface GameClientConfig {
  url: string;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export class GameClient extends EventEmitter {
  private socket: Socket | null = null;
  private config: Required<GameClientConfig>;
  private state: ClientGameState;
  private pendingBets: Map<string, PendingBet> = new Map();
  private reconnectAttempts = 0;
  private isConnected = false;
  private userId: string | null = null;

  constructor(config: GameClientConfig) {
    super();
    this.config = {
      url: config.url,
      autoReconnect: config.autoReconnect ?? true,
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };

    this.state = this.createInitialState();
  }

  private createInitialState(): ClientGameState {
    return {
      roundId: null,
      status: null,
      asset: 'BTCUSDT',
      startPrice: 0,
      currentPrice: 0,
      currentRow: 6.5,
      elapsed: 0,
      startTime: 0,
      commitHash: '',
      bettingDuration: 5,
      maxDuration: 60,
      activeBets: [],
    };
  }

  /**
   * 连接到服务器
   */
  connect(token: string): void {
    if (this.socket?.connected) {
      return;
    }

    this.socket = io(this.config.url, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    this.setupEventHandlers(token);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    this.userId = null;
    this.state = this.createInitialState();
  }

  /**
   * 获取当前状态
   */
  getState(): ClientGameState {
    return { ...this.state };
  }

  /**
   * 是否已连接
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * 获取用户 ID
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * 下注
   */
  async placeBet(request: Omit<PlaceBetRequest, 'orderId'>): Promise<ClientBet> {
    if (!this.socket?.connected || !this.isConnected) {
      throw new Error('未连接到服务器');
    }

    const orderId = this.generateOrderId();
    const fullRequest: PlaceBetRequest = { ...request, orderId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingBets.delete(orderId);
        reject(new Error('投注确认超时'));
      }, 5000);

      this.pendingBets.set(orderId, { resolve, reject, timeout });
      this.socket!.emit(WS_EVENTS.PLACE_BET, fullRequest);
    });
  }

  /**
   * 发送心跳
   */
  ping(): void {
    this.socket?.emit(WS_EVENTS.PING);
  }

  /**
   * 设置事件处理
   */
  private setupEventHandlers(token: string): void {
    if (!this.socket) return;

    // 连接成功
    this.socket.on('connect', () => {
      console.log('[GameClient] Connected, authenticating...');
      this.reconnectAttempts = 0;
      this.socket!.emit(WS_EVENTS.AUTH, { token });
    });

    // 认证结果
    this.socket.on(WS_EVENTS.AUTH_RESULT, (msg) => {
      if (msg.payload.success) {
        this.isConnected = true;
        this.userId = msg.payload.userId;
        this.emit('connected', { userId: msg.payload.userId });
        console.log('[GameClient] Authenticated as', msg.payload.userId);
      } else {
        this.emit('auth_error', msg.payload.error);
        console.error('[GameClient] Auth failed:', msg.payload.error);
      }
    });

    // 回合开始
    this.socket.on(WS_EVENTS.ROUND_START, (msg) => {
      this.state = {
        ...this.state,
        roundId: msg.payload.roundId,
        status: 'BETTING',
        asset: msg.payload.asset,
        startPrice: msg.payload.startPrice,
        currentPrice: msg.payload.startPrice,
        currentRow: 6.5,
        elapsed: 0,
        startTime: msg.payload.startTime,
        commitHash: msg.payload.commitHash,
        bettingDuration: msg.payload.bettingDuration,
        maxDuration: msg.payload.maxDuration,
        activeBets: [],
        serverSeed: undefined,
      };
      this.emit('round:start', this.state);
    });

    // 回合运行中
    this.socket.on(WS_EVENTS.ROUND_RUNNING, (msg) => {
      this.state.status = 'RUNNING';
      this.emit('round:running', { roundId: msg.payload.roundId });
    });

    // 状态更新
    this.socket.on(WS_EVENTS.STATE_UPDATE, (msg) => {
      this.state.elapsed = msg.payload.elapsed;
      this.state.currentPrice = msg.payload.currentPrice;
      this.state.currentRow = msg.payload.currentRow;
      this.emit('state:update', msg.payload);
    });

    // 价格更新
    this.socket.on(WS_EVENTS.PRICE_UPDATE, (msg) => {
      this.state.currentPrice = msg.payload.price;
      this.state.currentRow = msg.payload.rowIndex;
      this.emit('price', msg.payload);
    });

    // 投注确认
    this.socket.on(WS_EVENTS.BET_CONFIRMED, (msg) => {
      const pending = this.pendingBets.get(msg.payload.orderId);
      if (pending) {
        clearTimeout(pending.timeout);
        const bet: ClientBet = {
          betId: msg.payload.betId,
          orderId: msg.payload.orderId,
          amount: msg.payload.amount,
          multiplier: msg.payload.multiplier,
          targetRow: msg.payload.targetRow,
          targetTime: msg.payload.targetTime,
          status: 'PENDING',
        };
        this.state.activeBets.push(bet);
        pending.resolve(bet);
        this.pendingBets.delete(msg.payload.orderId);
      }
      this.emit('bet:confirmed', msg.payload);
    });

    // 投注拒绝
    this.socket.on(WS_EVENTS.BET_REJECTED, (msg) => {
      const pending = this.pendingBets.get(msg.payload.orderId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(msg.payload.message));
        this.pendingBets.delete(msg.payload.orderId);
      }
      this.emit('bet:rejected', msg.payload);
    });

    // 投注结算
    this.socket.on(WS_EVENTS.BET_SETTLED, (msg) => {
      const bet = this.state.activeBets.find((b) => b.betId === msg.payload.betId);
      if (bet) {
        bet.status = msg.payload.isWin ? 'WON' : 'LOST';
        bet.isWin = msg.payload.isWin;
        bet.payout = msg.payload.payout;
        bet.hitDetails = msg.payload.hitDetails;
      }
      this.emit('bet:settled', msg.payload);
    });

    // 投注退款
    this.socket.on(WS_EVENTS.BET_REFUNDED, (msg) => {
      const bet = this.state.activeBets.find((b) => b.betId === msg.payload.betId);
      if (bet) {
        bet.status = 'REFUNDED';
      }
      this.emit('bet:refunded', msg.payload);
    });

    // 回合结束
    this.socket.on(WS_EVENTS.ROUND_END, (msg) => {
      this.state.status = 'COMPLETED';
      this.state.serverSeed = msg.payload.serverSeed;
      this.emit('round:end', msg.payload);
    });

    // 回合取消
    this.socket.on(WS_EVENTS.ROUND_CANCELLED, (msg) => {
      this.state.status = 'CANCELLED';
      this.state.serverSeed = msg.payload.serverSeed;
      this.emit('round:cancelled', msg.payload);
    });

    // 心跳响应
    this.socket.on(WS_EVENTS.PONG, (msg) => {
      this.emit('pong', msg);
    });

    // 断开连接
    this.socket.on('disconnect', (reason) => {
      console.log('[GameClient] Disconnected:', reason);
      this.isConnected = false;
      this.emit('disconnected', { reason });

      if (this.config.autoReconnect && reason !== 'io client disconnect') {
        this.scheduleReconnect(token);
      }
    });

    // 连接错误
    this.socket.on('connect_error', (error) => {
      console.error('[GameClient] Connection error:', error.message);
      this.emit('error', error);
    });
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(token: string): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[GameClient] Max reconnect attempts reached');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `[GameClient] Reconnecting in ${this.config.reconnectInterval}ms (attempt ${this.reconnectAttempts})`
    );

    setTimeout(() => {
      if (!this.socket?.connected) {
        this.connect(token);
      }
    }, this.config.reconnectInterval);
  }

  /**
   * 生成订单 ID
   */
  private generateOrderId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
