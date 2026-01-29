# Comprehensive Review - Development Plan (v2)

## Overview

对 neon-peak-crash 代码库进行全面审查后的修复计划，覆盖代码质量、安全性、测试覆盖、性能、业务流程与盈利逻辑。

---

## Audit Findings

### P0 - Critical
| ID | Dimension | File:Line | Description | Fix |
|---|---|---|---|---|
| P0-01 | Security | `GameEngine.ts:1-4` | 文件 BOM + 注释乱码（UTF-8 编码问题），影响可读性和维护 | 修复编码，重写中文注释 |
| P0-02 | Business Logic | `SettlementService.ts:214-225` | `compensateUnsettledBets` 和 `processSettlementQueue` 中 `totalProfit` 计算错误：赢的情况下 `profit = payout - amount` 丢失了投注扣款（下注时已扣，赢时 profit 应为 `payout` 而非 `payout - amount`） | 统一 profit 计算逻辑 |
| P0-03 | Business Logic | `user.ts:246` | `settleBetSecure` 计算 payout 未扣除庄家抽水 `payout = amount * multiplier`，但 multiplier 已含 HOUSE_EDGE，实际无误但缺乏注释说明 | 添加注释或移除此遗留方法 |

### P1 - High Priority
| ID | Dimension | File:Line | Description | Fix |
|---|---|---|---|---|
| P1-01 | Security | `notify/route.ts:76` | 支付回调金额仅用 `parseFloat` 解析，未与订单金额交叉验证 | 从 DB 查询订单金额并对比 |
| P1-02 | Security | `notify/route.ts:14-106` | 支付回调无 IP 白名单验证，仅依赖签名 | 添加可选 IP 白名单 |
| P1-03 | Performance | `GameEngine.ts:653-655` | `placeBet` 中每次下注遍历 `activeBets` 统计用户下注数，O(n) 复杂度 | 维护 per-user 计数器 |
| P1-04 | Business Logic | `SettlementService.ts:518` | `processSettlementQueue` 使用 `any` 类型的 `updateData`，跳过 TypeScript 类型检查 | 使用 Prisma 类型 |
| P1-05 | Concurrency | `SettlementService.ts:588` | `splice(0, batch.length)` 在并发场景下可能移除错误的元素（如果队列在处理期间被追加） | 使用更安全的队列操作 |
| P1-06 | Test Quality | `GameEngine.test.ts` | 并发下注测试回归，`activeBets.size === 0` 而非预期的 1 | 修复测试或引擎逻辑 |
| P1-07 | Security | `WebSocketGateway.ts:682` | price 事件中 `this.gameEngine.getState()?.currentRow` 可能在 gameEngine 为 null 时 NPE | 添加空值检查 |

### P2 - Medium Priority
| ID | Dimension | File:Line | Description | Fix |
|---|---|---|---|---|
| P2-01 | Code Quality | `user.ts:104-161` | `updateUserBalanceWithLedger` 和 `updateUserBalance` 标记为 @deprecated 但仍在使用 | 迁移调用方，移除废弃函数 |
| P2-02 | Code Quality | `user.ts:173-195` | `recordBet` 创建 Bet 时不设 roundId/orderId/targetRow/targetTime 等必填字段 | 此函数可能已废弃，应移除 |
| P2-03 | Performance | `PriceService.ts:222` | Redis 采样间隔每次从 `process.env` 解析，应缓存 | 构造函数中缓存 |
| P2-04 | Code Quality | `game-server.ts:96-97` | `authorization` header 的类型处理不规范（强转 `as any`） | 使用正确类型 |
| P2-05 | Test Coverage | 整体 | API 路由缺乏集成测试（payment/notify, payment/recharge, user/balance） | 补充 API 测试 |
| P2-06 | Code Quality | `balance/route.ts:58` | GET handler 签名不符合 Next.js App Router 规范（接收 deps 而非 request） | 修正签名 |

### P3 - Low Priority
| ID | Dimension | File:Line | Description | Fix |
|---|---|---|---|---|
| P3-01 | Code Quality | `GameEngine.ts:62-68` | 所有中文注释因编码问题变成乱码 | 重写注释 |
| P3-02 | Performance | `WebSocketGateway.ts:510` | `replayCurrentRoundBetEvents` 使用 `as any[]` 类型断言 | 定义正确类型 |

---

## Task Breakdown

### Task 1: Security & Business Logic Critical Fixes

- **ID**: task-1
- **type**: default
- **Description**:
  1. 修复 `GameEngine.ts` 文件编码问题（BOM + 乱码注释）
  2. 修复 `SettlementService.ts` 中 profit 计算逻辑
  3. 添加支付回调金额验证（与数据库订单金额交叉核对）
  4. 修复 `WebSocketGateway.ts` price 事件中的 NPE 风险
  5. 清理 `user.ts` 中的废弃函数（recordBet, settleBet 等旧接口）
  6. 为所有修改编写/修复对应的单元测试
- **File Scope**:
  - `lib/game-engine/GameEngine.ts`
  - `lib/game-engine/SettlementService.ts`
  - `lib/game-engine/WebSocketGateway.ts`
  - `app/api/payment/notify/route.ts`
  - `lib/services/user.ts`
  - `__tests__/lib/game-engine/GameEngine.test.ts`
  - `__tests__/lib/game-engine/SettlementService.test.ts`
  - `__tests__/lib/services/user.test.ts`
  - `__tests__/app/api/payment/notify.test.ts` (new)
- **Dependencies**: None
- **Test Command**: `pnpm test -- __tests__/lib/game-engine/ __tests__/lib/services/user.test.ts __tests__/app/ --coverage`

---

### Task 2: Concurrent Betting & Settlement Robustness

- **ID**: task-2
- **type**: default
- **Description**:
  1. 修复并发下注测试回归（P1-06）
  2. 优化 `placeBet` 中用户下注计数：维护 per-user counter Map 替代 O(n) 遍历
  3. 修复 `SettlementService.processSettlementQueue` 中 `splice` 并发安全问题
  4. 消除 `any` 类型使用（P1-04）
  5. 补充并发场景测试：多用户同时下注、风控预占竞态、结算队列并发追加
- **File Scope**:
  - `lib/game-engine/GameEngine.ts`
  - `lib/game-engine/SettlementService.ts`
  - `lib/game-engine/RiskManager.ts`
  - `__tests__/lib/game-engine/GameEngine.test.ts`
  - `__tests__/lib/game-engine/SettlementService.test.ts`
  - `__tests__/lib/game-engine/RiskManager.test.ts`
- **Dependencies**: task-1 (GameEngine.ts encoding fix first)
- **Test Command**: `pnpm test -- __tests__/lib/game-engine/ --coverage`

---

### Task 3: API Security Hardening & Test Coverage

- **ID**: task-3
- **type**: default
- **Description**:
  1. 支付回调添加可选 IP 白名单验证
  2. 修复 `balance/route.ts` GET handler 签名问题（Next.js App Router 兼容）
  3. 缓存 `PriceService` 中的 `REDIS_SAMPLE_MS` 环境变量
  4. 修复 `game-server.ts` 中 authorization header 类型处理
  5. 补充 API 路由集成测试（payment/notify, payment/recharge, user/balance）
  6. 补充 `gameMath.ts` 边界测试
- **File Scope**:
  - `app/api/payment/notify/route.ts`
  - `app/api/payment/recharge/route.ts`
  - `app/api/user/balance/route.ts`
  - `lib/game-engine/PriceService.ts`
  - `server/game-server.ts`
  - `__tests__/app/api/payment/notify.test.ts` (new or extend)
  - `__tests__/app/api/payment/recharge.test.ts` (new)
  - `__tests__/app/api/user/balance.test.ts` (new)
  - `__tests__/lib/utils/gameMath.test.ts` (new or extend)
- **Dependencies**: None
- **Test Command**: `pnpm test -- __tests__/app/ __tests__/lib/utils/ --coverage`

---

### Task 4: Rate Limiter & WebSocket Gateway Hardening

- **ID**: task-4
- **type**: quick-fix
- **Description**:
  1. 验证 `rateLimit.ts` 内存清理机制（已有 TTL/容量上限）
  2. 验证 `WebSocketGateway.ts` historyLimit clamp（已有 min(200,...)）
  3. 补充 rate limiter 边界测试（TTL 过期、容量上限、Redis 降级）
  4. 补充 WebSocket gateway 测试（origin 验证、historyLimit clamp）
- **File Scope**:
  - `lib/services/rateLimit.ts`
  - `lib/game-engine/WebSocketGateway.ts`
  - `tests/rateLimit.test.ts`
  - `tests/wsGateway.test.ts`
- **Dependencies**: None
- **Test Command**: `pnpm test -- tests/rateLimit.test.ts tests/wsGateway.test.ts --coverage`

---

## Acceptance Criteria

- [ ] **P0-01**: GameEngine.ts 编码修复，注释可读
- [ ] **P0-02**: Settlement profit 计算正确（有测试验证）
- [ ] **P1-01**: 支付回调验证订单金额
- [ ] **P1-03**: placeBet 用户下注计数 O(1)
- [ ] **P1-05**: Settlement queue 并发安全
- [ ] **P1-06**: 并发下注测试通过
- [ ] **P1-07**: WebSocket price 事件无 NPE
- [ ] All unit tests pass (`pnpm test`)
- [ ] Code coverage >= 90% for modified files

---

## Test Coverage Requirements

| Module | Minimum Coverage |
|--------|-----------------|
| `lib/game-engine/GameEngine.ts` | 90% lines, 85% branches |
| `lib/game-engine/SettlementService.ts` | 90% lines, 85% branches |
| `lib/game-engine/RiskManager.ts` | 90% lines, 85% branches |
| `lib/services/rateLimit.ts` | 90% lines, 90% functions |
| `lib/game-engine/WebSocketGateway.ts` | 85% lines, 80% branches |
| `app/api/**/*.ts` | 85% lines |
| Overall | >= 90% |

---

## Dependency Graph

```
task-1 (None) ─────> task-2 (depends on task-1)
task-3 (None) ────────────────────────────────>
task-4 (None) ────────────────────────────────>
```

## Parallel Execution Groups

- **Group A** (immediate parallel): task-1, task-3, task-4
- **Group B** (after task-1): task-2
