# 代码审查报告 - Neon Peak Crash

**审查日期**: 2026-01-19
**审查范围**: 全面深度审查（安全性、数据一致性、业务逻辑、性能、盈利模式、运行稳定性）
**审查深度**: 深度审查（覆盖所有代码和依赖）

---

## 执行摘要

本次审查发现 **14 个问题**，其中：
- **Critical（严重）**: 2 个 - 资金冻结风险
- **High（高危）**: 5 个 - 安全配置、数据一致性
- **Medium（中危）**: 6 个 - 日志安全、性能优化
- **Low（低危）**: 1 个 - 安全响应头

**关键风险**：
1. 崩溃恢复退款逻辑缺陷导致资金永久冻结
2. 回合取消退款非幂等且缺少审计流水
3. 资金计算未统一按分舍入，存在系统性漂移
4. 多实例部署缺少分布式锁，可能创建重复回合

---

## 项目概览

### 技术栈
- **前端**: Next.js 16 (App Router) + React 19
- **认证**: NextAuth v5 (JWT Session)
- **数据库**: Prisma 7 + PostgreSQL
- **缓存**: Redis (ioredis)
- **实时通信**: Socket.io + WebSocket
- **价格源**: Bybit V5 WebSocket

### 架构
- **Web 应用**: Next.js 提供 UI + HTTP API
- **游戏服务**: 独立 `server/game-server.ts` 提供 WebSocket 游戏引擎
- **数据流**: 资金与下注落库 Postgres，状态/限流/缓存走 Redis

---

## 安全性问题

### 🔴 Critical

#### 无

### 🟠 High

#### 1. Host Header/Origin 依赖导致支付回调地址可被污染

**严重程度**: High
**影响范围**: 充值下单的 `notify_url`/`return_url` 生成
**风险**: 回调打到错误域名，导致不到账、对账失败、被恶意引导

**代码位置**: `app/api/payment/recharge/route.ts:34`

```typescript
const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
```

**问题分析**:
- 当 `NEXTAUTH_URL` 未配置时，fallback 到 `request.nextUrl.origin`
- 攻击者可通过 Host Header 注入控制回调地址
- 资金链路不应依赖请求来源

**修复建议**:
```typescript
// 强制使用配置的可信基址
const baseUrl = process.env.NEXTAUTH_URL;
if (!baseUrl) {
  return NextResponse.json(
    { success: false, error: '服务配置错误' },
    { status: 500 }
  );
}
```

---

#### 2. NextAuth Secret 使用不一致导致 WebSocket 鉴权易失效

**严重程度**: High
**影响范围**: WebSocket 自动 cookie 鉴权
**风险**: 生产环境可能出现"网页已登录但 WS 全部认证失败"的系统性故障

**代码位置**: `lib/game-engine/WebSocketGateway.ts:456,506`

**问题分析**:
- NextAuth v5 使用 `AUTH_SECRET`
- WebSocket 鉴权仅使用 `NEXTAUTH_SECRET`
- 配置不一致导致 JWT 解码失败

**修复建议**:
```typescript
// 统一使用两个环境变量
const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
if (!secret) {
  throw new Error('AUTH_SECRET or NEXTAUTH_SECRET must be configured');
}
```

---

#### 3. WebSocket 连接缺少显式 Origin 校验

**严重程度**: High
**影响范围**: WebSocket 连接安全
**风险**: CORS 配置过宽时存在跨站 WebSocket 连接风险

**代码位置**: `lib/game-engine/WebSocketGateway.ts:46-55`

**修复建议**:
```typescript
// 在 connection 时显式校验 origin
io.on('connection', (socket) => {
  const origin = socket.handshake.headers.origin;
  const allowedOrigins = (process.env.WS_CORS_ORIGIN || '').split(',');

  if (!origin || !allowedOrigins.includes(origin)) {
    console.warn(`[WSGateway] Rejected connection from origin: ${origin}`);
    socket.disconnect(true);
    return;
  }
  // ... 继续处理
});
```

---

#### 4. NextAuth `trustHost: true` 需要配合可信反代

**严重程度**: High
**影响范围**: 认证与回调 URL 推导
**风险**: 放大 Host Header 类风险面

**代码位置**: `lib/auth.ts:120`

**修复建议**:
- 生产强制设置 `NEXTAUTH_URL`
- 仅在明确需要且反代可信时使用 `trustHost`
- 添加启动检查确保配置正确

---

#### 5. 余额更新 HTTP API 允许客户端触发余额变更且不走账本

**严重程度**: High
**影响范围**: 真实余额可被用户自行扣减而无交易流水
**风险**: 影响审计/对账，play 模式可任意加款

**代码位置**: `app/api/user/balance/route.ts:99,127`

**修复建议**:
- 生产移除该 API 或仅允许 playBalance
- 真实余额变更只允许在服务端资金链路内发生
- 所有余额变更必须记录流水

---

### 🟡 Medium

#### 6. 支付回调打印全量参数（含敏感信息）

**严重程度**: Medium
**影响范围**: 日志泄露/日志注入风险
**代码位置**: `app/api/payment/notify/route.ts:35`

**修复建议**:
```typescript
// 仅记录必要字段，脱敏处理
console.log('收到支付回调:', {
  out_trade_no: params.out_trade_no,
  trade_status: params.trade_status,
  amount: params.money,
  // 不记录 sign 等敏感信息
});
```

---

#### 7. 订单查询接口把密钥放在 URL 查询参数

**严重程度**: Medium
**影响范围**: 密钥可能出现在代理/网关/访问日志
**代码位置**: `lib/payment/ldc.ts:171-179`

**修复建议**:
- 改用 POST body 或 header 传递密钥
- 确保所有日志链路彻底脱敏

---

### 🟢 Low

#### 8. 缺少安全响应头

**严重程度**: Low
**影响范围**: 整体抗 XSS/点击劫持能力偏弱
**代码位置**: `next.config.ts`

**修复建议**:
```typescript
// next.config.ts
async headers() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Content-Security-Policy', value: "default-src 'self'; ..." },
      ],
    },
  ];
}
```

---

## 数据一致性问题

### 🔴 Critical

#### 9. 孤儿回合恢复只退款"5 分钟前"的 PENDING 注单

**严重程度**: Critical
**影响范围**: 服务崩溃/重启后，部分注单永远卡在 PENDING
**风险**: 余额已扣但不退款、不结算，**资金永久冻结**

**代码位置**: `server/game-server.ts:171-178`

```typescript
const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
const pendingBets = await prisma.bet.findMany({
  where: {
    roundId: round.id,
    status: 'PENDING',
    createdAt: { lt: fiveMinutesAgo }, // ❌ 错误：不应按时间过滤
  },
});
```

**修复建议**:
```typescript
// 对孤儿回合应退款全部未结算注单
const pendingBets = await prisma.bet.findMany({
  where: {
    roundId: round.id,
    status: 'PENDING', // 移除时间过滤
  },
});
```

---

#### 10. 回合取消退款仅处理内存态 PENDING，且非幂等 + 缺少退款流水

**严重程度**: Critical
**影响范围**:
- 内存中已标记 `SETTLING` 但 DB 仍是 `PENDING` 的注单不被退款
- 退款函数可能在异常重入/多实例场景造成重复加款
- 真实余额退款无 `transactions(REFUND)` 记录

**代码位置**:
- `lib/game-engine/GameEngine.ts:336-337` (只筛 PENDING)
- `lib/game-engine/GameEngine.ts:378-397` (无状态条件、无退款流水)

**修复建议**:
```typescript
// 取消回合时以 DB 为准批量退款
await prisma.$transaction(async (tx) => {
  // 幂等更新：只更新 PENDING 状态的注单
  const updated = await tx.bet.updateMany({
    where: {
      roundId: this.state.roundId,
      status: 'PENDING',
    },
    data: {
      status: 'REFUNDED',
      settledAt: new Date(),
    },
  });

  // 只对成功更新的记录退款并记流水
  if (updated.count > 0) {
    const bets = await tx.bet.findMany({
      where: { roundId: this.state.roundId, status: 'REFUNDED' },
    });

    for (const bet of bets) {
      // 获取当前余额
      const user = await tx.user.findUnique({
        where: { id: bet.userId },
        select: { balance: true },
      });

      const balanceBefore = Number(user!.balance);

      // 退款
      await tx.user.update({
        where: { id: bet.userId },
        data: { balance: { increment: bet.amount } },
      });

      // 记录流水（仅真实余额）
      if (!bet.isPlayMode) {
        await tx.transaction.create({
          data: {
            userId: bet.userId,
            type: 'REFUND',
            amount: Number(bet.amount),
            balanceBefore,
            balanceAfter: balanceBefore + Number(bet.amount),
            relatedBetId: bet.id,
            remark: `退款投注 ${bet.id}（回合取消）`,
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
      }
    }
  }
});
```

---

### 🟠 High

#### 11. 资金用 JS number 计算并直接写入 Decimal(18,2)

**严重程度**: High
**影响范围**: 结算 payout、用户 totalProfit 等可能出现系统性舍入偏差
**风险**: 长期资金漂移，可被边界下注利用

**代码位置**:
- `lib/shared/gameMath.ts:21` (roundMoney 定义但未使用)
- `lib/game-engine/GameEngine.ts:237,798,880,1022`

**修复建议**:
```typescript
// 资金全链路改为整数分或统一 roundMoney
import { roundMoney } from '@/lib/shared/gameMath';

// 在每次写 DB 前统一舍入
const payout = roundMoney(bet.amount * bet.multiplier);
```

---

#### 12. `updateUserBalanceWithLedger` 读-算-写方式会丢更新

**严重程度**: High
**影响范围**: 并发下余额可能被旧值覆盖
**代码位置**: `lib/services/user.ts:117-121`

**修复建议**:
```typescript
// 改为 increment 并通过同事务再次读取
await tx.user.update({
  where: { id: userId },
  data: { balance: { increment: amount } },
});

// 再次读取获取最新余额
const updatedUser = await tx.user.findUnique({
  where: { id: userId },
  select: { balance: true },
});

const balanceAfter = Number(updatedUser!.balance);
```

---

#### 13. 多实例/多进程缺少"单资产单活跃回合"约束

**严重程度**: High
**影响范围**: 水平扩容或重复启动会创建多个活跃回合
**风险**: 下注路由与结算归属混乱

**代码位置**: `lib/game-engine/GameEngine.ts:135`

**修复建议**:
- 使用 Postgres advisory lock 或 Redis 分布式锁
- DB 增加部分唯一索引（asset 在活跃状态集合上唯一）
- Redis 状态写入带 instance fencing token

---

### 🟡 Medium

#### 14. 结算队列 flush 超时后仍继续完成回合

**严重程度**: Medium
**影响范围**: 回合统计可能与真实结算不一致
**代码位置**: `lib/game-engine/GameEngine.ts:920`

**修复建议**:
- 回合结束应以 DB 结算完成为准
- 或进入"延迟完成态"等待结算完成

---

## 业务逻辑问题

### 🟠 High

#### 15. "Provably Fair"表述与实现不匹配

**严重程度**: High
**影响范围**: 合规/信任风险
**代码位置**: `lib/game-engine/GameEngine.ts:129-139,277-294`

**问题分析**:
- serverSeed/commitHash 未参与结果生成
- 实际输赢由市场价格驱动
- 用户看到 seed reveal 但无法验证

**修复建议**:
- 要么把 seed 真正纳入可验证的结果生成
- 要么调整 UI/文案为"透明披露/回合校验信息"
- 避免"可证公平"误导

---

### 🟡 Medium

#### 16. 下注参数校验缺少 `targetTime` 的有限性检查

**严重程度**: Medium
**影响范围**: 可构造 NaN/Infinity 类输入导致异常
**代码位置**: `lib/game-engine/GameEngine.ts:434-440`

**修复建议**:
```typescript
// 对所有数值参数做有限性检查
if (!Number.isFinite(request.amount) ||
    !Number.isFinite(request.targetRow) ||
    !Number.isFinite(request.targetTime)) {
  throw new GameError(ERROR_CODES.INVALID_AMOUNT, '参数必须为有限数值');
}
```

---

## 性能问题

### 🟠 High

#### 17. 60 FPS Tick 每帧遍历全部活跃注单

**严重程度**: High
**影响范围**: 高并发下注时 CPU 飙升
**代码位置**: `lib/game-engine/GameEngine.ts:659,690`

**修复建议**:
- 按 `targetTime` 分桶/最小堆调度
- 仅检查"即将命中窗口"的 bets
- 设置全局活跃注单上限与背压
- 必要时降低 tick 频率并在客户端插值渲染

---

### 🟡 Medium

#### 18. Bybit trade 流每条都写 Redis

**严重程度**: Medium
**影响范围**: 价格更新频繁时 Redis IOPS 偏高
**代码位置**: `lib/game-engine/PriceService.ts:190-193`

**修复建议**:
- 改为按时间采样（50-100ms 一条）
- 批量 pipeline
- 或只缓存"最新价+少量窗口"

---

#### 19. 价格快照 DB 写失败会把数据塞回内存队列

**严重程度**: Medium
**影响范围**: DB 故障期间内存不断增长，最终 OOM
**代码位置**: `lib/game-engine/GameEngine.ts:975`

**修复建议**:
- 设置上限与丢弃策略（drop oldest / drop newest）
- 把异常快照落盘或直接降级关闭快照功能

---

## 盈利模式分析

### 赔率/抽水实现

**抽水常量**: `HOUSE_EDGE = 0.06` (6%)

**核心公式**:
```typescript
// lib/shared/gameMath.ts:33-41
const probability = baseProbability * Math.exp(-(distance * distance) / (2 * sigma * sigma));
const fairPayout = 1 / probability;
const housePayout = fairPayout * (1 - HOUSE_EDGE);
const timeBonus = 1 + Math.max(0, timeDeltaSeconds) * 0.04;
const raw = housePayout * timeBonus;
```

### 关键风险

1. **timeBonus 未与真实命中概率联动**
   - 可能显著稀释 6% house edge
   - 需要用真实价格过程做蒙特卡洛校准

2. **资金入账与结算未统一按分舍入**
   - 可能出现"系统性向上舍入"被套利
   - 尤其大量小额高频下注时

### 资金流向（真实余额）

1. **充值**: `transactions(RECHARGE)` PENDING → COMPLETED + `users.balance increment`
2. **下注**: 事务内 `users.balance decrement` + 记 `transactions(BET)`
3. **赢钱**: 结算事务内 `users.balance increment` + 记 `transactions(WIN)`
4. **退款**: **路径不一致**（启动恢复有流水，回合取消缺流水）→ 审计风险

---

## 运行稳定性问题

### 🟠 High

#### 20. 游戏服务 `/stats`、`/health` 无鉴权对外暴露

**严重程度**: High
**影响范围**: 被探测/压测/信息收集
**代码位置**: `server/game-server.ts:72,83`

**修复建议**:
- 仅绑定内网
- 加鉴权/签名
- 或在网关层限制访问

---

#### 21. WebSocket 鉴权失败默认保持连接并持续广播状态

**严重程度**: High
**影响范围**: 连接数膨胀时资源占用上升
**代码位置**: `lib/game-engine/WebSocketGateway.ts:110,304`

**修复建议**:
- 鉴权失败直接断开连接
- 或将未认证连接加入低权限房间且限速

---

### 🟡 Medium

#### 22. 结算队列重试失败后依赖后续触发再次处理

**严重程度**: Medium
**影响范围**: 短期内用户看到长时间 PENDING/SETTLING
**代码位置**: `lib/game-engine/GameEngine.ts`

**修复建议**:
- 为结算队列增加 watchdog（定时强制 processSettlementQueue）
- 对单笔结算做可恢复状态机

---

## 修复优先级建议

### 🔥 P0 - 立即修复（资金安全）

1. **问题 #9**: 孤儿回合恢复退款逻辑（移除 5 分钟过滤）
2. **问题 #10**: 回合取消退款幂等性 + 流水记录
3. **问题 #11**: 资金统一按分舍入

### 🟠 P1 - 高优先级（安全配置）

4. **问题 #1**: 支付回调地址强制使用配置基址
5. **问题 #2**: WebSocket 鉴权 secret 统一
6. **问题 #3**: WebSocket Origin 严格校验
7. **问题 #12**: 余额并发更新修复

### 🟡 P2 - 中优先级（稳定性优化）

8. **问题 #13**: 多实例分布式锁
9. **问题 #17**: Tick 性能优化
10. **问题 #20**: 管理接口鉴权

### 🟢 P3 - 低优先级（改进建议）

11. 其他 Medium/Low 问题

---

## 总结

本次审查发现 **22 个问题**，其中：
- **Critical**: 2 个（资金冻结风险）
- **High**: 7 个（安全配置、数据一致性）
- **Medium**: 12 个（日志安全、性能优化）
- **Low**: 1 个（安全响应头）

**关键风险点**:
1. 崩溃恢复退款逻辑缺陷导致资金永久冻结
2. 回合取消退款非幂等且缺少审计流水
3. 资金计算未统一按分舍入，存在系统性漂移
4. 多实例部署缺少分布式锁，可能创建重复回合

**建议修复顺序**:
1. 先修复 P0 问题（资金安全止血）
2. 再修复 P1 问题（安全配置与鉴权）
3. 最后修复 P2/P3 问题（稳定性与性能优化）

---

**审查完成时间**: 2026-01-19 15:55:00
**审查工具**: Codex (codeagent-wrapper)
**会话ID**: 019bd513-6cd3-7a82-8873-a90bf5b08413
