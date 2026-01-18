/**
 * 价格服务 - 带容错的 Bybit WebSocket 连接
 */

import { EventEmitter } from 'events';
import type { Redis } from 'ioredis';
import type { PriceUpdate } from './types';
import { PRICE_STALE_THRESHOLD, PRICE_CRITICAL_THRESHOLD, REDIS_KEYS } from './constants';

export interface PriceServiceConfig {
  asset: string;
  maxReconnectAttempts?: number;
}

export class PriceService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private lastPrice: PriceUpdate | null = null;
  private lastPriceTime = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private isStopped = false;

  constructor(
    private config: PriceServiceConfig,
    private redis: Redis
  ) {
    super();
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
  }

  async start(): Promise<void> {
    this.isStopped = false;
    await this.connect();
    this.startHealthCheck();
  }

  private async connect(): Promise<void> {
    if (this.isStopped) return;

    const url = 'wss://stream.bybit.com/v5/public/linear';

    console.log(`[PriceService] Connecting to Bybit for ${this.config.asset}...`);

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log(`[PriceService] Connected to Bybit for ${this.config.asset}`);
        this.reconnectAttempts = 0;

        // 订阅交易流
        this.ws!.send(JSON.stringify({
          op: 'subscribe',
          args: [`publicTrade.${this.config.asset}USDT`],
        }));

        // 心跳
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 'ping' }));
          }
        }, 20000);

        this.emit('connected');
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        console.warn(`[PriceService] Connection closed (code: ${event.code})`);
        this.cleanup();
        if (!this.isStopped) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('[PriceService] WebSocket error:', error);
        // onclose 会被触发，在那里处理重连
      };
    } catch (error) {
      console.error('[PriceService] Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: string): void {
    try {
      const parsed = JSON.parse(data);

      // 忽略 pong 响应
      if (parsed.op === 'pong') return;

      // 处理交易数据
      if (parsed.topic?.startsWith('publicTrade') && parsed.data?.length > 0) {
        const trade = parsed.data[parsed.data.length - 1];
        const price = parseFloat(trade.p);
        const timestamp = parseInt(trade.T);

        this.lastPrice = {
          asset: this.config.asset,
          price,
          timestamp,
          source: 'bybit',
        };
        this.lastPriceTime = Date.now();

        // 发送价格更新事件
        this.emit('price', this.lastPrice);

        // 异步缓存到 Redis
        this.cachePrice(this.lastPrice).catch(err =>
          console.error('[PriceService] Redis cache failed:', err)
        );
      }
    } catch (err) {
      console.error('[PriceService] Parse error:', err);
    }
  }

  private async cachePrice(price: PriceUpdate): Promise<void> {
    const key = `${REDIS_KEYS.PRICE_STREAM}${price.asset}`;
    await this.redis.lpush(key, JSON.stringify(price));
    await this.redis.ltrim(key, 0, 999); // 保留最近 1000 条
  }

  private scheduleReconnect(): void {
    if (this.isStopped) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[PriceService] Max reconnect attempts reached!');
      this.emit('critical_failure');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[PriceService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      if (this.isStopped) return;

      const now = Date.now();
      const staleness = now - this.lastPriceTime;

      if (this.lastPriceTime === 0) {
        // 还没收到过价格数据
        return;
      }

      if (staleness > PRICE_CRITICAL_THRESHOLD) {
        // 价格严重过期
        console.error(`[PriceService] Price critically stale (${staleness}ms)`);
        this.emit('price_critical', { staleness, lastPrice: this.lastPrice });
      } else if (staleness > PRICE_STALE_THRESHOLD) {
        // 价格过期警告
        console.warn(`[PriceService] Price stale (${staleness}ms)`);
        this.emit('price_stale', { staleness });
      }
    }, 1000);
  }

  /**
   * 获取最新价格（带过期检查）
   */
  getLatestPrice(): PriceUpdate | null {
    if (!this.lastPrice) return null;

    const staleness = Date.now() - this.lastPriceTime;
    if (staleness > PRICE_STALE_THRESHOLD) {
      return null; // 过期价格不可用
    }

    return this.lastPrice;
  }

  /**
   * 获取最新价格（不检查过期）
   */
  getLatestPriceRaw(): PriceUpdate | null {
    return this.lastPrice;
  }

  /**
   * 检查价格是否可用
   */
  isPriceAvailable(): boolean {
    return this.getLatestPrice() !== null;
  }

  /**
   * 获取价格过期时间
   */
  getPriceStaleness(): number {
    if (this.lastPriceTime === 0) return Infinity;
    return Date.now() - this.lastPriceTime;
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  stop(): void {
    this.isStopped = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.cleanup();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log('[PriceService] Stopped');
  }
}
