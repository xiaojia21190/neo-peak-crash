/**
 * 价格服务 - 带容错的 Bybit WebSocket 连接
 */

import { EventEmitter } from 'events';
import WebSocket, { type RawData } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Redis } from 'ioredis';
import type { PriceUpdate } from './types';
import { PRICE_STALE_THRESHOLD, PRICE_CRITICAL_THRESHOLD, REDIS_KEYS } from './constants';

export interface PriceServiceConfig {
  asset: string;
  maxReconnectAttempts?: number;
  allowStartWithoutConnection?: boolean;
  /**
   * Throttle frequency for emitting `price` events (ms).
   * Defaults to `PRICE_SAMPLE_MS` env or 50ms.
   */
  priceSampleMs?: number;
  /**
   * Override WS url (mainly for tests).
   */
  wsUrl?: string;
  /**
   * Optional WebSocket factory (mainly for tests).
   */
  wsFactory?: (url: string, options: any) => WebSocket;
  /**
   * Connect timeout (ms). Defaults to 10_000.
   */
  connectTimeoutMs?: number;
  /**
   * Bybit ping interval (ms). Defaults to 20_000.
   */
  pingIntervalMs?: number;
}

export class PriceService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private lastPrice: PriceUpdate | null = null;
  private lastPriceTime = 0;
  private lastRedisWrite = 0;
  private lastPriceEmitTime = 0;
  private pendingPriceEmit = false;
  private priceEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isStopped = false;
  private reconnectScheduled = false;
  private readonly priceSampleMs: number;
  private readonly redisSampleMs: number;
  private readonly wsUrl: string;
  private readonly wsFactory: (url: string, options: any) => WebSocket;
  private readonly connectTimeoutMs: number;
  private readonly pingIntervalMs: number;

  constructor(
    private config: PriceServiceConfig,
    private redis: Redis
  ) {
    super();
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;

    const envSampleMs = parseInt(process.env.PRICE_SAMPLE_MS ?? '50', 10);
    const rawSampleMs = config.priceSampleMs ?? envSampleMs;
    this.priceSampleMs = Number.isFinite(rawSampleMs) ? Math.max(5, rawSampleMs) : 50;

    this.redisSampleMs = parseInt(process.env.REDIS_SAMPLE_MS ?? '50', 10);

    this.wsUrl = config.wsUrl ?? 'wss://stream.bybit.com/v5/public/linear';
    this.wsFactory = config.wsFactory ?? ((url, options) => new WebSocket(url, options));
    this.connectTimeoutMs = Math.max(10, config.connectTimeoutMs ?? 10_000);
    this.pingIntervalMs = Math.max(10, config.pingIntervalMs ?? 20_000);
  }

  async start(): Promise<void> {
    this.isStopped = false;

    try {
      await this.connect();
      console.log('[PriceService] Started successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (this.config.allowStartWithoutConnection) {
        console.warn(`[PriceService] Initial connection failed: ${errorMsg}`);
        console.warn('[PriceService] Starting in degraded mode, will retry in background');
        // 重连会由 'close' 事件或 try-catch 块触发
      } else {
        console.error(`[PriceService] Failed to start: ${errorMsg}`);
        throw error;
      }
    }

    this.startHealthCheck();
  }

  private async connect(): Promise<void> {
    if (this.isStopped) return;

    const url = this.wsUrl;

    console.log(`[PriceService] Connecting to Bybit for ${this.config.asset}...`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      try {
        const proxyUrl = process.env.PROXY_URL;
        const options: any = {};

        if (proxyUrl) {
          console.log(`[PriceService] Using proxy: ${proxyUrl}`);
          options.agent = new HttpsProxyAgent(proxyUrl);
        }

        this.ws = this.wsFactory(url, options);

        const connectTimeout = setTimeout(() => {
          if (!settled && this.ws?.readyState !== WebSocket.OPEN) {
            settled = true;
            console.error('[PriceService] Connection timeout');
            this.ws?.close();
            reject(new Error('Connection timeout'));
          }
        }, this.connectTimeoutMs);

        this.ws.on('open', () => {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimeout);
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
            }, this.pingIntervalMs);

            this.emit('connected');
            resolve();
          }
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          const closeReason = reason.toString();
          console.warn(
            `[PriceService] Connection closed (code: ${code}${closeReason ? `, reason: ${closeReason}` : ''})`
          );

          if (!settled) {
            settled = true;
            clearTimeout(connectTimeout);
            reject(new Error(`Connection closed before open: ${code} ${closeReason}`));
          }

          this.cleanup();
          if (!this.isStopped) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          console.error('[PriceService] WebSocket error:', error);
          // onclose 会被触发，在那里处理重连
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          console.error('[PriceService] Failed to create WebSocket:', error);
          reject(error);
        }
      }
    });
  }

  private handleMessage(data: RawData | string): void {
    try {
      const message = this.normalizeMessageData(data);
      const parsed = JSON.parse(message);

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

        const now = Date.now();

        if (this.lastPriceTime === 0) {
          this.emit('ready');
        }
        this.lastPriceTime = now;

        // 发送价格更新事件
        this.requestPriceEmit(now);

        // 采样写入 Redis（默认 50ms 间隔）
        if (now - this.lastRedisWrite >= this.redisSampleMs) {
          this.lastRedisWrite = now;
          this.cachePrice(this.lastPrice).catch(err =>
            console.error('[PriceService] Redis cache failed:', err)
          );
        }
      }
    } catch (err) {
      console.error('[PriceService] Parse error:', err);
    }
  }

  private requestPriceEmit(now: number): void {
    this.pendingPriceEmit = true;

    const elapsed = now - this.lastPriceEmitTime;
    if (this.lastPriceEmitTime === 0 || elapsed >= this.priceSampleMs) {
      if (this.priceEmitTimer) {
        clearTimeout(this.priceEmitTimer);
        this.priceEmitTimer = null;
      }
      this.flushPriceEmit(now);
      return;
    }

    if (this.priceEmitTimer) return;

    const delay = Math.max(0, this.priceSampleMs - elapsed);
    this.priceEmitTimer = setTimeout(() => {
      this.priceEmitTimer = null;
      if (this.isStopped) return;
      if (!this.pendingPriceEmit) return;
      this.flushPriceEmit(Date.now());
    }, delay);
  }

  private flushPriceEmit(now: number): void {
    if (!this.lastPrice) return;
    this.pendingPriceEmit = false;
    this.lastPriceEmitTime = now;
    this.emit('price', this.lastPrice);
  }

  private async cachePrice(price: PriceUpdate): Promise<void> {
    const key = `${REDIS_KEYS.PRICE_STREAM}${price.asset}`;
    // Use pipeline to batch lpush and ltrim into single network round-trip
    await this.redis.pipeline()
      .lpush(key, JSON.stringify(price))
      .ltrim(key, 0, 999)
      .exec();
  }

  private normalizeMessageData(data: RawData | string): string {
    if (typeof data === 'string') {
      return data;
    }

    if (Array.isArray(data)) {
      return Buffer.concat(data).toString('utf8');
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString('utf8');
    }

    return data.toString('utf8');
  }

  private scheduleReconnect(): void {
    if (this.isStopped || this.reconnectScheduled) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[PriceService] Max reconnect attempts reached!');
      this.emit('critical_failure');
      return;
    }

    this.reconnectScheduled = true;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[PriceService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectScheduled = false;
      this.connect().catch(() => {
        // 错误已记录，重连会由 'close' 事件或 try-catch 块处理
      });
    }, delay);
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
    if (this.priceEmitTimer) {
      clearTimeout(this.priceEmitTimer);
      this.priceEmitTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.isStopped = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.cleanup();

    if (this.ws) {
      return new Promise<void>((resolve) => {
        this.ws!.once('close', () => {
          this.ws = null;
          console.log('[PriceService] Stopped');
          resolve();
        });
        this.ws!.close();

        setTimeout(resolve, 2000);
      });
    }

    console.log('[PriceService] Stopped');
  }
}
