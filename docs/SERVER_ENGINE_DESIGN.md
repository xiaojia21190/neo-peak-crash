# Neon Peak Crash - 服务端游戏引擎详细设计

## 1. 设计目标

### 1.1 核心问题
当前架构中，游戏结果由客户端判定后发送到服务器，存在以下安全隐患：
- 用户可篡改投注结果（isWin）
- 余额操作可被绕过
- 无法验证游戏公平性

### 1.2 设计原则
- **服务端权威**：所有游戏逻辑、结果判定在服务端执行
- **可验证公平**：Provably Fair 机制，用户可独立验证结果
- **实时性**：< 100ms 延迟的投注确认和结果推送
- **原子性**：余额操作与投注/结算在同一事务内完成
- **可扩展**：支持多资产、多房间并行

---

## 2. 系统架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              客户端层                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Web App   │  │  Mobile App │  │   Desktop   │  │   Spectator │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
└─────────┼────────────────┼────────────────┼────────────────┼────────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                   │
                          WebSocket (Socket.io)
                                   │
┌─────────────────────────────────────────────────────────────────────────┐
│                              网关层                                      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     WebSocket Gateway                            │   │
│  │  • 连接管理  • 认证鉴权  • 消息路由  • 限流  • 心跳检测          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Game Engine   │    │  Price Service  │    │  User Service   │
│                 │    │                 │    │                 │
│ • 回合状态机    │◀───│ • Bybit WS 聚合 │    │ • 认证          │
│ • 投注池管理    │    │ • 价格广播      │    │ • 余额管理      │
│ • 碰撞检测      │    │ • 历史快照      │    │ • 统计          │
│ • 结算引擎      │    │                 │    │                 │
│ • Provably Fair │    │                 │    │                 │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┴──────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────────────┐
│                              数据层                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  PostgreSQL │  │    Redis    │  │   InfluxDB  │  │  S3/MinIO   │    │
│  │  (持久化)   │  │  (缓存/锁)  │  │  (时序数据) │  │  (证据存档) │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 模块 | 职责 | 技术选型 |
|------|------|----------|
| WebSocket Gateway | 连接管理、认证、消息路由 | Socket.io / ws |
| Game Engine | 游戏核心逻辑 | Node.js 单例服务 |
| Price Service | 价格聚合与分发 | 独立 Worker |
| User Service | 用户、余额、统计 | REST API + Prisma |
| Redis | 分布式锁、Pub/Sub、缓存 | Redis 7+ |
| PostgreSQL | 持久化存储 | PostgreSQL 15+ |

### 2.3 Price Service 容错设计

由于游戏依赖 Bybit 实时价格，Price Service 必须具备容错能力：

```typescript
// lib/price-service/PriceService.ts

export class PriceService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private lastPrice: PriceUpdate | null = null;
  private lastPriceTime = 0;
  private healthCheckInterval: NodeJS.Timer | null = null;

  // 价格过期阈值（毫秒）
  private readonly PRICE_STALE_THRESHOLD = 5000;  // 5 秒无更新视为过期
  private readonly PRICE_CRITICAL_THRESHOLD = 10000;  // 10 秒触发回合暂停

  constructor(
    private asset: string,
    private gameEngine: GameEngine,
    private redis: Redis
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.connect();
    this.startHealthCheck();
  }

  private async connect(): Promise<void> {
    const url = 'wss://stream.bybit.com/v5/public/linear';

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log(`[PriceService] Connected to Bybit for ${this.asset}`);
      this.reconnectAttempts = 0;

      // 订阅交易流
      this.ws!.send(JSON.stringify({
        op: 'subscribe',
        args: [`publicTrade.${this.asset}USDT`],
      }));

      // 心跳
      setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 'ping' }));
        }
      }, 20000);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.topic?.startsWith('publicTrade') && data.data?.length > 0) {
          const trade = data.data[data.data.length - 1];
          const price = parseFloat(trade.p);
          const timestamp = parseInt(trade.T);

          this.lastPrice = { asset: this.asset, price, timestamp, source: 'bybit' };
          this.lastPriceTime = Date.now();

          // 更新 GameEngine 缓存
          this.gameEngine.updatePriceCache(this.lastPrice);

          // 广播给客户端
          this.emit('price', this.lastPrice);

          // 缓存到 Redis
          this.redis.lpush(
            `game:prices:${this.asset}`,
            JSON.stringify(this.lastPrice)
          ).then(() => this.redis.ltrim(`game:prices:${this.asset}`, 0, 999));
        }
      } catch (err) {
        console.error('[PriceService] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.warn('[PriceService] Connection closed, attempting reconnect...');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[PriceService] WebSocket error:', err);
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
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

  // 健康检查
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const staleness = now - this.lastPriceTime;

      if (staleness > this.PRICE_CRITICAL_THRESHOLD) {
        // 价格严重过期，暂停游戏
        console.error(`[PriceService] Price critically stale (${staleness}ms), pausing game`);
        this.emit('price_critical', { staleness, lastPrice: this.lastPrice });

        // 通知 GameEngine 暂停并可能取消当前回合
        this.gameEngine.emit('price_unavailable');

      } else if (staleness > this.PRICE_STALE_THRESHOLD) {
        // 价格过期警告
        console.warn(`[PriceService] Price stale (${staleness}ms)`);
        this.emit('price_stale', { staleness });
      }
    }, 1000);
  }

  // 获取最新价格（带过期检查）
  getLatestPrice(): PriceUpdate | null {
    if (!this.lastPrice) return null;

    const staleness = Date.now() - this.lastPriceTime;
    if (staleness > this.PRICE_STALE_THRESHOLD) {
      return null;  // 过期价格不可用
    }

    return this.lastPrice;
  }

  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.ws?.close();
  }
}
```

**GameEngine 处理价格不可用：**

```typescript
// 在 GameEngine 中添加
this.priceService.on('price_unavailable', () => {
  if (this.state && this.state.status === 'RUNNING') {
    // 方案 1：暂停 tick，等待恢复
    this.pauseTickLoop();

    // 方案 2：超过阈值则取消回合
    setTimeout(() => {
      if (!this.priceService.getLatestPrice()) {
        this.cancelRound('价格服务不可用');
      }
    }, 15000);  // 15 秒后仍无价格则取消
  }
});
```

## 3. 核心数据模型

### 3.1 数据库 Schema 扩展

```prisma
// prisma/schema.prisma 新增/修改

// 游戏回合
model Round {
  id          String      @id @default(cuid())
  asset       String      // 交易对 (BTCUSDT, ETHUSDT)
  status      RoundStatus @default(PENDING)

  // Provably Fair
  serverSeed  String      // 服务端种子（回合结束后公开）
  commitHash  String      // SHA256(serverSeed) - 回合开始时公开
  clientSeed  String?     // 可选客户端种子

  // 价格数据
  startPrice  Decimal     @db.Decimal(18, 8)
  endPrice    Decimal?    @db.Decimal(18, 8)

  // 时间
  startedAt   DateTime
  endedAt     DateTime?

  // 统计
  totalBets   Int         @default(0)
  totalVolume Decimal     @default(0) @db.Decimal(18, 2)
  totalPayout Decimal     @default(0) @db.Decimal(18, 2)

  // 关联
  bets        Bet[]
  snapshots   PriceSnapshot[]

  @@index([asset, status])
  @@index([startedAt])
  @@map("rounds")
}

// 价格快照（时序数据）
model PriceSnapshot {
  id        String   @id @default(cuid())
  roundId   String
  round     Round    @relation(fields: [roundId], references: [id])

  timestamp DateTime // 精确到毫秒
  price     Decimal  @db.Decimal(18, 8)
  rowIndex  Decimal  @db.Decimal(10, 4) // 计算后的行索引

  @@index([roundId, timestamp])
  @@map("price_snapshots")
}

// 投注记录（扩展）
model Bet {
  id        String    @id @default(cuid())

  // 关联
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  roundId   String
  round     Round     @relation(fields: [roundId], references: [id])

  // 投注信息
  amount    Decimal   @db.Decimal(18, 2)
  multiplier Decimal  @db.Decimal(10, 4)
  targetRow  Decimal  @db.Decimal(10, 4)   // 目标行（精确值）
  targetTime Decimal  @db.Decimal(10, 3)   // 目标时间（秒，相对回合开始）

  // 结果
  status     BetStatus @default(PENDING)
  isWin      Boolean   @default(false)
  payout     Decimal   @default(0) @db.Decimal(18, 2)

  // 命中详情
  hitPrice   Decimal?  @db.Decimal(18, 8)  // 命中时的价格
  hitRow     Decimal?  @db.Decimal(10, 4)  // 命中时的行
  hitTime    Decimal?  @db.Decimal(10, 3)  // 命中时的时间

  // 模式
  isPlayMode Boolean   @default(false)

  // 时间戳
  placedAt   DateTime  @default(now())
  settledAt  DateTime?

  @@index([userId, placedAt])
  @@index([roundId, status])
  @@map("bets")
}

enum RoundStatus {
  PENDING    // 准备中
  BETTING    // 投注阶段
  RUNNING    // 运行中（可投注未来时间点）
  SETTLING   // 结算中
  COMPLETED  // 已完成
  CANCELLED  // 已取消
}

enum BetStatus {
  PENDING    // 待结算
  WON        // 已赢
  LOST       // 已输
  CANCELLED  // 已取消（回合取消时）
  REFUNDED   // 已退款
}
```

### 3.2 Redis 数据结构

```typescript
// Redis Key 设计

// 1. 当前回合状态（每个资产一个）
// Key: game:round:{asset}
// Type: Hash
{
  id: "round_xxx",
  status: "RUNNING",
  startPrice: "3456.78",
  startTime: "1705570800000",
  commitHash: "abc123...",
  currentRow: "6.5",
  elapsed: "12.345"
}

// 2. 活跃投注池
// Key: game:bets:{roundId}
// Type: Sorted Set (score = targetTime)
// Member: JSON string of bet

// 3. 价格流（最近 N 条）
// Key: game:prices:{asset}
// Type: List (LPUSH, LTRIM)
// Value: { timestamp, price, rowIndex }

// 4. 用户连接映射
// Key: game:connections:{userId}
// Type: Set
// Member: socketId

// 5. 分布式锁
// Key: lock:bet:{orderId}
// Type: String with TTL
```

---

## 4. 游戏引擎核心设计

### 4.1 回合状态机

```
                    ┌─────────────┐
                    │   PENDING   │
                    └──────┬──────┘
                           │ startRound()
                           ▼
                    ┌─────────────┐
         ┌─────────│   BETTING   │◀────────┐
         │         └──────┬──────┘         │
         │                │ countdownEnd() │ extendBetting()
         │                ▼                │
         │         ┌─────────────┐         │
         │         │   RUNNING   │─────────┘
         │         └──────┬──────┘
         │                │ roundTimeout() / manualStop()
         │                ▼
         │         ┌─────────────┐
         │         │  SETTLING   │
         │         └──────┬──────┘
         │                │ allBetsSettled()
         │                ▼
         │         ┌─────────────┐
         └────────▶│  COMPLETED  │
    cancel()       └─────────────┘
```

### 4.2 核心类设计

```typescript
// lib/game-engine/constants.ts

export const CENTER_ROW_INDEX = 6.5;        // 中心行索引
export const PRICE_SENSITIVITY = 1000;      // 价格敏感度（1% 变动 = 10 行）
export const MIN_TARGET_TIME_OFFSET = 0.5;  // 最小目标时间偏移（秒）
export const HIT_TIME_TOLERANCE = 0.5;      // 命中时间容差（±秒）
export const MISS_TIME_BUFFER = 0.6;        // 未命中判定缓冲（秒）

// lib/game-engine/types.ts

export interface RoundConfig {
  asset: string;
  bettingDuration: number;    // 投注阶段时长（秒）
  maxDuration: number;        // 最大回合时长（秒）
  minBetAmount: number;
  maxBetAmount: number;
  maxBetsPerUser: number;
  maxBetsPerSecond: number;   // 每用户每秒最大投注次数（限流）
  hitTolerance: number;       // 碰撞容差
  tickInterval: number;       // 检测间隔（ms）
}

export interface GameState {
  roundId: string;
  status: RoundStatus;
  asset: string;
  startPrice: number;
  currentPrice: number;
  currentRow: number;
  prevRow?: number;           // 上一帧行索引（用于交叉检测）
  elapsed: number;            // 已过秒数
  roundStartTime: number;     // 回合开始时间戳（ms）
  commitHash: string;
  activeBets: Map<string, ServerBet>;
}

export interface ServerBet {
  id: string;
  orderId: string;            // 幂等性 key（修正 typo）
  userId: string;
  amount: number;
  multiplier: number;
  targetRow: number;
  targetTime: number;
  placedAt: number;
  status: BetStatus;
  isPlayMode: boolean;        // 模式标记
}

export interface PriceUpdate {
  asset: string;
  price: number;
  timestamp: number;
  source: 'bybit';
}

// lib/game-engine/GameEngine.ts

import { EventEmitter } from 'events';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  CENTER_ROW_INDEX,
  PRICE_SENSITIVITY,
  MIN_TARGET_TIME_OFFSET,
  HIT_TIME_TOLERANCE,
  MISS_TIME_BUFFER
} from './constants';

export class GameEngine extends EventEmitter {
  private redis: Redis;
  private prisma: PrismaClient;
  private config: RoundConfig;

  private state: GameState | null = null;
  private tickTimer: NodeJS.Timer | null = null;
  private serverSeed: string | null = null;  // 仅内存保存，不写入数据库

  // 结算队列（异步批处理）
  private settlementQueue: Array<{bet: ServerBet, isWin: boolean, hitDetails?: HitDetails}> = [];
  private isSettling = false;

  // 用户投注频率限制
  private userBetTimestamps: Map<string, number[]> = new Map();

  constructor(config: RoundConfig, redis: Redis, prisma: PrismaClient) {
    super();
    this.config = config;
    this.redis = redis;
    this.prisma = prisma;
  }

  // ========== 回合生命周期 ==========

  async startRound(): Promise<void> {
    if (this.state?.status === 'RUNNING') {
      throw new Error('Round already running');
    }

    // 1. 生成 Provably Fair 种子（仅内存保存）
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    const commitHash = this.hashSeed(this.serverSeed);

    // 2. 获取起始价格
    const startPrice = await this.getCurrentPrice();
    if (!startPrice) {
      throw new Error('Price not available');
    }

    const now = Date.now();

    // 3. 创建回合记录（注意：不存储 serverSeed 明文！）
    const round = await this.prisma.round.create({
      data: {
        asset: this.config.asset,
        status: 'BETTING',
        // serverSeed 不在此时存储，回合结束时才写入
        commitHash,
        startPrice,
        startedAt: new Date(now),
      }
    });

    // 4. 初始化状态
    this.state = {
      roundId: round.id,
      status: 'BETTING',
      asset: this.config.asset,
      startPrice,
      currentPrice: startPrice,
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
      startPrice,
      startTime: Date.now(),
      bettingDuration: this.config.bettingDuration,
    });

    // 8. 投注阶段倒计时
    setTimeout(() => this.transitionToRunning(), this.config.bettingDuration * 1000);
  }

  private transitionToRunning(): void {
    if (!this.state || this.state.status !== 'BETTING') return;

    this.state.status = 'RUNNING';
    this.syncStateToRedis();

    this.emit('round:running', { roundId: this.state.roundId });
  }

  async endRound(reason: 'timeout' | 'manual' | 'crash' = 'timeout'): Promise<void> {
    if (!this.state || this.state.status === 'COMPLETED') return;

    // 1. 停止 Tick
    this.stopTickLoop();

    // 2. 更新状态
    this.state.status = 'SETTLING';
    await this.syncStateToRedis();

    // 3. 结算所有未结算投注
    await this.settleAllPendingBets();

    // 4. 等待结算队列处理完成
    await this.flushSettlementQueue();

    // 5. 更新数据库（此时才写入 serverSeed 明文！）
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: {
        status: 'COMPLETED',
        serverSeed: this.serverSeed,  // 回合结束后才公开
        endPrice: this.state.currentPrice,
        endedAt: new Date(),
      }
    });

    // 6. 广播回合结束（公开 serverSeed）
    this.emit('round:end', {
      roundId: this.state.roundId,
      serverSeed: this.serverSeed,  // 现在公开
      endPrice: this.state.currentPrice,
      reason,
    });

    // 7. 清理
    this.state = null;
    this.serverSeed = null;
    this.userBetTimestamps.clear();
  }

  // ========== 回合取消与退款 ==========

  async cancelRound(reason: string): Promise<void> {
    if (!this.state || this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    // 1. 停止 Tick
    this.stopTickLoop();

    // 2. 更新状态
    this.state.status = 'SETTLING';

    // 3. 退款所有待结算投注
    const pendingBets = Array.from(this.state.activeBets.values())
      .filter(b => b.status === 'PENDING');

    for (const bet of pendingBets) {
      await this.refundBet(bet, reason);
    }

    // 4. 更新数据库
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: {
        status: 'CANCELLED',
        serverSeed: this.serverSeed,  // 取消时也公开种子
        endedAt: new Date(),
      }
    });

    // 5. 广播回合取消
    this.emit('round:cancelled', {
      roundId: this.state.roundId,
      serverSeed: this.serverSeed,
      reason,
      refundedBets: pendingBets.length,
    });

    // 6. 清理
    this.state = null;
    this.serverSeed = null;
    this.userBetTimestamps.clear();
  }

  private async refundBet(bet: ServerBet, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 更新投注状态为已退款
      await tx.bet.update({
        where: { id: bet.id },
        data: {
          status: 'REFUNDED',
          settledAt: new Date(),
        }
      });

      // 退还余额
      const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';
      await tx.user.update({
        where: { id: bet.userId },
        data: { [balanceField]: { increment: bet.amount } }
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

  async placeBet(userId: string, request: PlaceBetRequest): Promise<PlaceBetResponse> {
    // 1. 状态检查
    if (!this.state) {
      throw new GameError('NO_ACTIVE_ROUND', '当前没有进行中的回合');
    }

    if (this.state.status !== 'BETTING' && this.state.status !== 'RUNNING') {
      throw new GameError('BETTING_CLOSED', '当前不可投注');
    }

    // 2. 投注频率限制
    if (!this.checkRateLimit(userId)) {
      throw new GameError('RATE_LIMITED', `投注过于频繁，每秒最多 ${this.config.maxBetsPerSecond} 次`);
    }

    // 3. 时间检查（目标时间必须在未来）
    const minTargetTime = this.state.elapsed + MIN_TARGET_TIME_OFFSET;
    if (request.targetTime <= minTargetTime) {
      throw new GameError('TARGET_TIME_PASSED', '目标时间已过或太近');
    }

    // 4. 金额检查
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError('INVALID_AMOUNT', `投注金额需在 ${this.config.minBetAmount}-${this.config.maxBetAmount} 之间`);
    }

    // 5. 用户投注数量限制
    const userBetCount = Array.from(this.state.activeBets.values())
      .filter(b => b.userId === userId && b.status === 'PENDING').length;
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError('MAX_BETS_REACHED', '已达到最大投注数量');
    }

    // 6. 计算倍率（服务端计算，不信任客户端）
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    // 7. 幂等性检查 + 分布式锁
    const lockKey = `lock:bet:${request.orderId}`;
    const locked = await this.redis.set(lockKey, '1', 'NX', 'EX', 30);
    if (!locked) {
      throw new GameError('DUPLICATE_BET', '重复的投注请求');
    }

    try {
      // 8. 原子扣款 + 记录投注（使用条件更新保证原子性）
      const bet = await this.prisma.$transaction(async (tx) => {
        const balanceField = request.isPlayMode ? 'playBalance' : 'balance';

        // 原子条件更新：只有余额足够时才扣款
        const updateResult = await tx.user.updateMany({
          where: {
            id: userId,
            [balanceField]: { gte: request.amount }  // 条件：余额 >= 投注金额
          },
          data: {
            [balanceField]: { decrement: request.amount }
          }
        });

        // 检查是否成功扣款
        if (updateResult.count === 0) {
          throw new GameError('INSUFFICIENT_BALANCE', '余额不足');
        }

        // 创建投注记录
        return tx.bet.create({
          data: {
            userId,
            roundId: this.state!.roundId,
            amount: request.amount,
            multiplier,
            targetRow: request.targetRow,
            targetTime: request.targetTime,
            isPlayMode: request.isPlayMode ?? false,
            status: 'PENDING',
          }
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

      // 10. 同步到 Redis（异步，不阻塞响应）
      setImmediate(() => {
        this.redis.zadd(
          `game:bets:${this.state!.roundId}`,
          request.targetTime,
          JSON.stringify(serverBet)
        ).catch(err => console.error('Redis sync failed:', err));
      });

      // 11. 广播投注确认
      this.emit('bet:confirmed', {
        betId: bet.id,
        userId,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        multiplier,
        amount: request.amount,
      });

      return {
        betId: bet.id,
        multiplier,
        targetTime: request.targetTime,
        targetRow: request.targetRow,
      };

    } finally {
      // 释放锁（延迟释放以防止立即重试）
      setTimeout(() => this.redis.del(lockKey), 1000);
    }
  }

  // 投注频率限制检查
  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const windowMs = 1000;  // 1 秒窗口
    const maxRequests = this.config.maxBetsPerSecond;

    let timestamps = this.userBetTimestamps.get(userId) || [];

    // 清理过期时间戳
    timestamps = timestamps.filter(t => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      return false;
    }

    timestamps.push(now);
    this.userBetTimestamps.set(userId, timestamps);
    return true;
  }

  // ========== Tick 循环（碰撞检测） ==========

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
   * 碰撞检测为同步操作，结算为异步批处理
   */
  private tick(): void {
    if (!this.state || this.state.status === 'SETTLING' || this.state.status === 'COMPLETED') {
      return;
    }

    const now = Date.now();
    this.state.elapsed = (now - this.state.roundStartTime) / 1000;

    // 1. 获取最新价格（从内存缓存，不阻塞）
    const priceUpdate = this.getLatestPriceFromCache();
    if (priceUpdate) {
      this.state.currentPrice = priceUpdate.price;
      this.state.currentRow = this.calculateRowIndex(priceUpdate.price, this.state.startPrice);
    }

    // 2. 碰撞检测（同步，不阻塞）
    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: Array<{bet: ServerBet, isWin: boolean, hitDetails?: HitDetails}> = [];

    for (const [betId, bet] of this.state.activeBets) {
      if (bet.status !== 'PENDING') continue;

      // 时间窗口检测
      const timeDiff = Math.abs(this.state.elapsed - bet.targetTime);
      const isInTimeWindow = timeDiff <= HIT_TIME_TOLERANCE;

      if (isInTimeWindow) {
        // 行交叉检测（检测价格线是否穿过目标行）
        const minRow = Math.min(prevRow, this.state.currentRow) - this.config.hitTolerance;
        const maxRow = Math.max(prevRow, this.state.currentRow) + this.config.hitTolerance;

        if (bet.targetRow >= minRow && bet.targetRow <= maxRow) {
          // HIT - 加入结算队列
          toSettle.push({
            bet,
            isWin: true,
            hitDetails: {
              hitPrice: this.state.currentPrice,
              hitRow: this.state.currentRow,
              hitTime: this.state.elapsed,
            }
          });
          bet.status = 'WON';  // 立即标记，避免重复检测
        }
      } else if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        // MISS - 超时未命中
        toSettle.push({ bet, isWin: false });
        bet.status = 'LOST';  // 立即标记
      }
    }

    // 3. 保存上一帧行索引
    this.state.prevRow = this.state.currentRow;

    // 4. 异步结算（不阻塞 tick 循环）
    if (toSettle.length > 0) {
      this.settlementQueue.push(...toSettle);
      this.processSettlementQueue();  // 触发异步处理
    }

    // 5. 异步记录价格快照（每 100ms，不阻塞）
    if (Math.floor(this.state.elapsed * 10) % 1 === 0) {
      this.bufferPriceSnapshot();
    }

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

  // 异步结算队列处理
  private async processSettlementQueue(): Promise<void> {
    if (this.isSettling || this.settlementQueue.length === 0) return;

    this.isSettling = true;

    try {
      while (this.settlementQueue.length > 0) {
        // 批量处理，每批最多 50 个
        const batch = this.settlementQueue.splice(0, 50);

        await this.prisma.$transaction(async (tx) => {
          for (const { bet, isWin, hitDetails } of batch) {
            const payout = isWin ? bet.amount * bet.multiplier : 0;

            // 更新投注记录
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
              }
            });

            // 如果赢了，增加余额
            if (isWin && payout > 0) {
              const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';
              await tx.user.update({
                where: { id: bet.userId },
                data: { [balanceField]: { increment: payout } }
              });
            }

            // 更新用户统计
            await tx.user.update({
              where: { id: bet.userId },
              data: {
                totalBets: { increment: 1 },
                totalWins: isWin ? { increment: 1 } : undefined,
                totalLosses: !isWin ? { increment: 1 } : undefined,
                totalProfit: { increment: isWin ? payout - bet.amount : -bet.amount },
              }
            });
          }
        });

        // 批量广播结算结果
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
      console.error('Settlement batch failed:', error);
      // 失败的项目重新入队
    } finally {
      this.isSettling = false;
    }
  }

  // 等待结算队列清空
  private async flushSettlementQueue(): Promise<void> {
    while (this.settlementQueue.length > 0 || this.isSettling) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // 价格快照缓冲
  private priceSnapshotBuffer: PriceSnapshot[] = [];
  private lastSnapshotFlush = 0;

  private bufferPriceSnapshot(): void {
    if (!this.state) return;

    this.priceSnapshotBuffer.push({
      roundId: this.state.roundId,
      timestamp: new Date(),
      price: this.state.currentPrice,
      rowIndex: this.state.currentRow,
    });

    // 每秒批量写入一次
    const now = Date.now();
    if (now - this.lastSnapshotFlush >= 1000 && this.priceSnapshotBuffer.length > 0) {
      const toFlush = this.priceSnapshotBuffer.splice(0);
      this.lastSnapshotFlush = now;

      // 异步写入
      setImmediate(async () => {
        try {
          await this.prisma.priceSnapshot.createMany({ data: toFlush });
        } catch (error) {
          console.error('Price snapshot flush failed:', error);
        }
      });
    }
  }

  // 节流发送
  private lastEmitTimes: Map<string, number> = new Map();
  private emitThrottled(event: string, data: unknown, intervalMs = 50): void {
    const now = Date.now();
    const lastEmit = this.lastEmitTimes.get(event) || 0;

    if (now - lastEmit >= intervalMs) {
      this.emit(event, data);
      this.lastEmitTimes.set(event, now);
    }
  }

  // 从缓存获取最新价格
  private getLatestPriceFromCache(): PriceUpdate | null {
    // 由 PriceService 更新的内存缓存
    return this.priceCache;
  }
  private priceCache: PriceUpdate | null = null;

  // 供 PriceService 调用
  public updatePriceCache(price: PriceUpdate): void {
    this.priceCache = price;
  }

  // ========== 结算 ==========

  private settleAllPendingBets(): void {
    const pendingBets = Array.from(this.state!.activeBets.values())
      .filter(b => b.status === 'PENDING');

    for (const bet of pendingBets) {
      // 最终检查：如果目标时间已过但在容差内，算赢；否则算输
      const timeDiff = Math.abs(this.state!.elapsed - bet.targetTime);
      const rowDiff = Math.abs(this.state!.currentRow - bet.targetRow);

      const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;

      // 标记状态并加入结算队列
      bet.status = isWin ? 'WON' : 'LOST';
      this.settlementQueue.push({
        bet,
        isWin,
        hitDetails: isWin ? {
          hitPrice: this.state!.currentPrice,
          hitRow: this.state!.currentRow,
          hitTime: this.state!.elapsed,
        } : undefined
      });
    }

    // 触发异步处理
    this.processSettlementQueue();
  }

  // ========== 辅助方法 ==========

  private hashSeed(seed: string): string {
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  private calculateRowIndex(currentPrice: number, startPrice: number): number {
    const percentChange = (currentPrice - startPrice) / startPrice;
    const rowDelta = percentChange * PRICE_SENSITIVITY;
    return Math.max(-1000, Math.min(1000, CENTER_ROW_INDEX - rowDelta));
  }

  private async syncStateToRedis(): Promise<void> {
    if (!this.state) return;

    await this.redis.hset(`game:round:${this.state.asset}`, {
      id: this.state.roundId,
      status: this.state.status,
      startPrice: this.state.startPrice.toString(),
      currentRow: this.state.currentRow.toString(),
      elapsed: this.state.elapsed.toString(),
      commitHash: this.state.commitHash,
    });
  }

  // ... 其他辅助方法
}

// 自定义错误类
export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GameError';
  }
}
```

---

## 5. WebSocket 通信协议

### 5.1 消息格式

```typescript
// 基础消息结构
interface WSMessage {
  type: string;
  payload: unknown;
  timestamp: number;
  seq?: number;        // 序列号（用于确认）
}

// 客户端 -> 服务端
interface ClientMessage extends WSMessage {
  type:
    | 'auth'           // 认证
    | 'subscribe'      // 订阅资产
    | 'unsubscribe'    // 取消订阅
    | 'place_bet'      // 下注
    | 'cancel_bet'     // 取消投注（如果支持）
    | 'ping'           // 心跳
    | 'verify_round';  // 验证回合公平性
}

// 服务端 -> 客户端
interface ServerMessage extends WSMessage {
  type:
    | 'auth_result'    // 认证结果
    | 'round_start'    // 回合开始
    | 'round_running'  // 投注阶段结束，游戏运行中
    | 'round_end'      // 回合结束
    | 'price_update'   // 价格更新
    | 'state_update'   // 状态更新（节流）
    | 'bet_confirmed'  // 投注确认
    | 'bet_settled'    // 投注结算
    | 'bet_rejected'   // 投注拒绝
    | 'error'          // 错误
    | 'pong';          // 心跳响应
}
```

### 5.2 详细消息定义

```typescript
// === 认证 ===
// Client -> Server
{
  type: 'auth',
  payload: {
    token: string;  // JWT token
  }
}

// Server -> Client
{
  type: 'auth_result',
  payload: {
    success: boolean;
    userId?: string;
    error?: string;
  }
}

// === 回合生命周期 ===
// Server -> Client: 回合开始
{
  type: 'round_start',
  payload: {
    roundId: string;
    asset: string;
    commitHash: string;      // Provably Fair 承诺
    startPrice: number;
    startTime: number;       // Unix timestamp (ms)
    bettingDuration: number; // 投注阶段时长（秒）
    maxDuration: number;     // 最大回合时长
  }
}

// Server -> Client: 回合结束
{
  type: 'round_end',
  payload: {
    roundId: string;
    serverSeed: string;      // 公开服务端种子
    endPrice: number;
    reason: 'timeout' | 'manual' | 'crash';
    stats: {
      totalBets: number;
      totalWins: number;
      totalPayout: number;
    };
  }
}

// === 价格更新 ===
// Server -> Client (高频，每 50-100ms)
{
  type: 'price_update',
  payload: {
    price: number;
    rowIndex: number;
    timestamp: number;
  }
}

// === 投注 ===
// Client -> Server
{
  type: 'place_bet',
  payload: {
    orderId: string;       // 客户端生成的唯一 ID（幂等性）
    targetRow: number;     // 目标行
    targetTime: number;    // 目标时间（相对回合开始的秒数）
    amount: number;
    isPlayMode: boolean;
  }
}

// Server -> Client: 投注确认
{
  type: 'bet_confirmed',
  payload: {
    orderId: string;
    betId: string;
    multiplier: number;    // 服务端计算的倍率
    targetRow: number;
    targetTime: number;
    amount: number;
  }
}

// Server -> Client: 投注拒绝
{
  type: 'bet_rejected',
  payload: {
    orderId: string;
    code: string;          // 错误码
    message: string;
  }
}

// Server -> Client: 投注结算
{
  type: 'bet_settled',
  payload: {
    betId: string;
    orderId: string;
    isWin: boolean;
    payout: number;
    hitDetails?: {
      hitPrice: number;
      hitRow: number;
      hitTime: number;
    };
    newBalance: number;    // 最新余额
  }
}
```

### 5.3 消息节流策略

```typescript
// 价格更新节流（避免客户端过载）
const THROTTLE_CONFIG = {
  price_update: 50,    // 最多每 50ms 发送一次
  state_update: 100,   // 最多每 100ms 发送一次
  bet_confirmed: 0,    // 不节流，立即发送
  bet_settled: 0,      // 不节流，立即发送
};
```

---

## 6. Provably Fair 实现

### 6.1 机制说明

```
时间线：
─────────────────────────────────────────────────────────────────▶

回合开始前                    回合进行中                    回合结束
    │                            │                            │
    ▼                            ▼                            ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ 生成 serverSeed │      │ 使用 commitHash │      │ 公开 serverSeed │
│ 计算 commitHash │      │ 接受投注        │      │ 用户可验证      │
│ 广播 commitHash │      │ 实时结算        │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

### 6.2 验证流程

```typescript
// 客户端验证代码
async function verifyRound(round: RoundResult): Promise<VerifyResult> {
  // 1. 验证 commitHash = SHA256(serverSeed)
  const calculatedHash = sha256(round.serverSeed);
  if (calculatedHash !== round.commitHash) {
    return { valid: false, error: 'Commit hash mismatch' };
  }

  // 2. 验证价格快照（可选：与 Bybit 历史对比）
  // ...

  // 3. 重新计算每个投注的结果
  for (const bet of round.bets) {
    const snapshot = round.priceSnapshots.find(s =>
      Math.abs(s.timestamp - bet.targetTime) < 0.5
    );

    if (snapshot) {
      const expectedRow = calculateRowIndex(snapshot.price, round.startPrice);
      const rowDiff = Math.abs(expectedRow - bet.targetRow);
      const expectedWin = rowDiff <= HIT_TOLERANCE;

      if (expectedWin !== bet.isWin) {
        return { valid: false, error: `Bet ${bet.id} result mismatch` };
      }
    }
  }

  return { valid: true };
}
```

### 6.3 增强方案：客户端种子

```typescript
// 可选：允许用户提供自己的种子
interface ClientSeedRequest {
  roundId: string;
  clientSeed: string;  // 用户提供
}

// 最终种子 = SHA256(serverSeed + clientSeed)
// 这样服务端也无法预测最终结果
```

---

## 7. API 设计

### 7.1 REST API

```typescript
// === 回合管理（管理员） ===
POST   /api/admin/rounds/start     // 开始新回合
POST   /api/admin/rounds/:id/stop  // 强制结束回合
GET    /api/admin/rounds           // 回合列表

// === 回合查询（用户） ===
GET    /api/rounds/current         // 当前回合状态
GET    /api/rounds/:id             // 回合详情
GET    /api/rounds/:id/verify      // 验证回合公平性
GET    /api/rounds/:id/bets        // 回合投注列表

// === 投注（用户） ===
GET    /api/bets                   // 我的投注历史
GET    /api/bets/:id               // 投注详情

// === 用户 ===
GET    /api/user/balance           // 余额
GET    /api/user/stats             // 统计

// === 充值 ===
POST   /api/payment/recharge       // 创建充值订单
POST   /api/payment/notify         // 支付回调
```

### 7.2 API 响应格式

```typescript
// 成功响应
{
  success: true,
  data: { ... }
}

// 错误响应
{
  success: false,
  error: {
    code: 'INSUFFICIENT_BALANCE',
    message: '余额不足',
    details?: { ... }
  }
}
```

---

## 8. 客户端集成

### 8.1 客户端 SDK

```typescript
// lib/game-client/GameClient.ts

export class GameClient extends EventEmitter {
  private socket: Socket;
  private state: ClientGameState;
  private pendingBets: Map<string, PendingBet>;

  constructor(url: string, token: string) {
    super();
    this.socket = io(url, {
      auth: { token },
      transports: ['websocket'],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // 认证结果
    this.socket.on('auth_result', (msg) => {
      if (msg.payload.success) {
        this.emit('connected', msg.payload);
      } else {
        this.emit('auth_error', msg.payload.error);
      }
    });

    // 回合开始
    this.socket.on('round_start', (msg) => {
      this.state = {
        roundId: msg.payload.roundId,
        status: 'BETTING',
        startPrice: msg.payload.startPrice,
        commitHash: msg.payload.commitHash,
        startTime: msg.payload.startTime,
        activeBets: [],
      };
      this.emit('round:start', this.state);
    });

    // 价格更新
    this.socket.on('price_update', (msg) => {
      this.state.currentPrice = msg.payload.price;
      this.state.currentRow = msg.payload.rowIndex;
      this.emit('price', msg.payload);
    });

    // 投注确认
    this.socket.on('bet_confirmed', (msg) => {
      const pending = this.pendingBets.get(msg.payload.orderId);
      if (pending) {
        pending.resolve(msg.payload);
        this.pendingBets.delete(msg.payload.orderId);
        this.state.activeBets.push(msg.payload);
      }
      this.emit('bet:confirmed', msg.payload);
    });

    // 投注结算
    this.socket.on('bet_settled', (msg) => {
      this.emit('bet:settled', msg.payload);
    });

    // 回合结束
    this.socket.on('round_end', (msg) => {
      this.state.status = 'COMPLETED';
      this.state.serverSeed = msg.payload.serverSeed;
      this.emit('round:end', msg.payload);
    });
  }

  // 下注
  async placeBet(request: PlaceBetRequest): Promise<BetConfirmation> {
    const orderId = this.generateOrderId();

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingBets.delete(orderId);
        reject(new Error('Bet confirmation timeout'));
      }, 5000);

      this.pendingBets.set(orderId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.socket.emit('place_bet', {
        type: 'place_bet',
        payload: { ...request, orderId },
        timestamp: Date.now(),
      });
    });
  }

  // 验证回合公平性
  async verifyRound(roundId: string): Promise<VerifyResult> {
    const response = await fetch(`/api/rounds/${roundId}/verify`);
    return response.json();
  }

  private generateOrderId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

### 8.2 React Hook 封装

```typescript
// hooks/useGameEngine.ts

export function useGameEngine() {
  const [client, setClient] = useState<GameClient | null>(null);
  const [state, setState] = useState<ClientGameState | null>(null);
  const [connected, setConnected] = useState(false);

  const { data: session } = useSession();

  useEffect(() => {
    if (!session?.user) return;

    const gameClient = new GameClient(
      process.env.NEXT_PUBLIC_WS_URL!,
      session.accessToken
    );

    gameClient.on('connected', () => setConnected(true));
    gameClient.on('round:start', setState);
    gameClient.on('price', (update) => {
      setState(prev => prev ? { ...prev, ...update } : null);
    });
    gameClient.on('round:end', () => {
      setState(prev => prev ? { ...prev, status: 'COMPLETED' } : null);
    });

    setClient(gameClient);

    return () => {
      gameClient.disconnect();
    };
  }, [session]);

  const placeBet = useCallback(async (request: PlaceBetRequest) => {
    if (!client) throw new Error('Not connected');
    return client.placeBet(request);
  }, [client]);

  return {
    connected,
    state,
    placeBet,
    verifyRound: client?.verifyRound.bind(client),
  };
}
```

---

## 9. 部署架构

### 9.1 单机部署（开发/小规模）

```
┌─────────────────────────────────────────────────────────────┐
│                        单机服务器                            │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Next.js    │  │ Game Engine │  │ Price Aggregator    │ │
│  │  (Frontend) │  │ (Worker)    │  │ (Worker)            │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                     │            │
│         └────────────────┼─────────────────────┘            │
│                          │                                  │
│         ┌────────────────┼────────────────┐                 │
│         │                │                │                 │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐         │
│  │  PostgreSQL │  │    Redis    │  │   Socket.io │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 分布式部署（生产）

```
                         ┌─────────────┐
                         │   CDN       │
                         │ (静态资源)   │
                         └──────┬──────┘
                                │
                         ┌──────▼──────┐
                         │ Load Balancer│
                         │ (Nginx/ALB)  │
                         └──────┬──────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
 ┌──────▼──────┐         ┌──────▼──────┐         ┌──────▼──────┐
 │ Web Server 1│         │ Web Server 2│         │ Web Server N│
 │ (Next.js)   │         │ (Next.js)   │         │ (Next.js)   │
 └──────┬──────┘         └──────┬──────┘         └──────┬──────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    │                       │
             ┌──────▼──────┐         ┌──────▼──────┐
             │ WS Gateway 1│         │ WS Gateway 2│
             │ (Socket.io) │         │ (Socket.io) │
             └──────┬──────┘         └──────┬──────┘
                    │                       │
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │     Redis Cluster     │
                    │  (Pub/Sub + Session)  │
                    └───────────┬───────────┘
                                │
             ┌──────────────────┼──────────────────┐
             │                                     │
      ┌──────▼──────┐                       ┌──────▼──────┐
      │ Game Engine │                       │ Price       │
      │ (Primary)   │◀─── Leader Election ──│ Aggregator  │
      └─────────────┘                       └─────────────┘
             │
             ▼
      ┌─────────────┐
      │ PostgreSQL  │
      │ (Primary +  │
      │  Replicas)  │
      └─────────────┘
```

### 9.3 关键配置

```yaml
# docker-compose.yml (开发环境)
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/neon_peak
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis

  game-engine:
    build:
      context: .
      dockerfile: Dockerfile.worker
    command: node dist/workers/game-engine.js
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/neon_peak
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis

  price-aggregator:
    build:
      context: .
      dockerfile: Dockerfile.worker
    command: node dist/workers/price-aggregator.js
    environment:
      - REDIS_URL=redis://redis:6379

  db:
    image: postgres:15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=neon_peak

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

---

## 10. 性能优化

### 10.1 关键指标目标

| 指标 | 目标 | 实现方案 |
|------|------|----------|
| 投注确认延迟 | < 100ms | 内存状态 + 异步持久化 |
| 价格推送延迟 | < 50ms | 本地价格缓存 + 节流 |
| 并发投注 | > 1000/s | Redis 队列 + 批处理 |
| WebSocket 连接 | > 10000 | 水平扩展 + Redis Pub/Sub |

### 10.2 优化策略

```typescript
// 1. 投注批处理
class BetProcessor {
  private queue: PlaceBetRequest[] = [];
  private processing = false;

  async add(bet: PlaceBetRequest): Promise<void> {
    this.queue.push(bet);
    if (!this.processing) {
      this.processBatch();
    }
  }

  private async processBatch(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, 100);  // 批量处理
      await this.prisma.$transaction(
        batch.map(bet => this.createBetOperation(bet))
      );
    }

    this.processing = false;
  }
}

// 2. 价格推送节流
const throttledBroadcast = throttle((data) => {
  io.emit('price_update', data);
}, 50);

// 3. 状态快照（减少 Redis 访问）
class StateCache {
  private cache: Map<string, GameState> = new Map();
  private syncInterval: NodeJS.Timer;

  constructor() {
    this.syncInterval = setInterval(() => this.syncToRedis(), 1000);
  }

  get(key: string): GameState | undefined {
    return this.cache.get(key);
  }

  set(key: string, state: GameState): void {
    this.cache.set(key, state);
  }

  private async syncToRedis(): Promise<void> {
    const pipeline = redis.pipeline();
    for (const [key, state] of this.cache) {
      pipeline.hset(`game:state:${key}`, state);
    }
    await pipeline.exec();
  }
}
```

---

## 11. 监控与告警

### 11.1 监控指标

```typescript
// Prometheus metrics
const metrics = {
  // 游戏指标
  roundsTotal: new Counter('game_rounds_total', 'Total rounds'),
  betsTotal: new Counter('game_bets_total', 'Total bets'),
  payoutTotal: new Counter('game_payout_total', 'Total payout'),

  // 延迟指标
  betConfirmLatency: new Histogram('game_bet_confirm_latency_ms', 'Bet confirmation latency'),
  priceUpdateLatency: new Histogram('game_price_update_latency_ms', 'Price update latency'),

  // 连接指标
  wsConnections: new Gauge('game_ws_connections', 'Active WebSocket connections'),

  // 错误指标
  errors: new Counter('game_errors_total', 'Total errors', ['type']),
};
```

### 11.2 告警规则

```yaml
# alertmanager rules
groups:
  - name: game-engine
    rules:
      - alert: HighBetLatency
        expr: histogram_quantile(0.99, game_bet_confirm_latency_ms) > 200
        for: 5m
        annotations:
          summary: "投注确认延迟过高"

      - alert: PriceUpdateStale
        expr: time() - game_last_price_update_timestamp > 5
        for: 1m
        annotations:
          summary: "价格更新停滞"

      - alert: HighErrorRate
        expr: rate(game_errors_total[5m]) > 10
        for: 2m
        annotations:
          summary: "错误率过高"
```

---

## 12. 迁移计划

### Phase 1: 基础设施（1 周）
- [ ] 添加 Redis 依赖
- [ ] 扩展 Prisma Schema
- [ ] 创建 WebSocket Gateway 基础框架
- [ ] 价格聚合服务（服务端连接 Bybit）

### Phase 2: 游戏引擎核心（2 周）
- [ ] 实现 GameEngine 类
- [ ] 回合状态机
- [ ] 投注处理（服务端验证）
- [ ] 碰撞检测算法
- [ ] 结算逻辑

### Phase 3: 通信层（1 周）
- [ ] WebSocket 消息协议实现
- [ ] 客户端 SDK
- [ ] React Hooks 封装

### Phase 4: 客户端适配（1 周）
- [ ] 修改 page.tsx 使用新 SDK
- [ ] 移除客户端结果判定逻辑
- [ ] 更新 GameChart 渲染逻辑

### Phase 5: Provably Fair（1 周）
- [ ] Commit-Reveal 实现
- [ ] 验证 API
- [ ] 前端验证 UI

### Phase 6: 测试与优化（1 周）
- [ ] 压力测试
- [ ] 延迟优化
- [ ] 监控部署

---

## 附录

### A. 错误码定义

| Code | Message | HTTP Status |
|------|---------|-------------|
| NO_ACTIVE_ROUND | 没有进行中的回合 | 400 |
| BETTING_CLOSED | 当前不可投注 | 400 |
| TARGET_TIME_PASSED | 目标时间已过 | 400 |
| INVALID_AMOUNT | 无效的金额 | 400 |
| MAX_BETS_REACHED | 已达最大投注数 | 400 |
| RATE_LIMITED | 投注过于频繁 | 429 |
| INSUFFICIENT_BALANCE | 余额不足 | 400 |
| DUPLICATE_BET | 重复的投注 | 409 |
| USER_NOT_FOUND | 用户不存在 | 404 |
| ROUND_NOT_FOUND | 回合不存在 | 404 |
| PRICE_UNAVAILABLE | 价格服务不可用 | 503 |
| INTERNAL_ERROR | 服务器错误 | 500 |

### B. 配置参数

```typescript
const DEFAULT_CONFIG: RoundConfig = {
  asset: 'BTCUSDT',
  bettingDuration: 5,      // 投注阶段 5 秒
  maxDuration: 60,         // 最大回合时长 60 秒
  minBetAmount: 1,
  maxBetAmount: 1000,
  maxBetsPerUser: 10,
  maxBetsPerSecond: 5,     // 每用户每秒最多 5 次投注
  hitTolerance: 0.4,       // 碰撞容差 ±0.4 行
  tickInterval: 16,        // 约 60fps
};
```
