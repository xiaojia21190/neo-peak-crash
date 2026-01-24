# Neon Peak Crash 项目问题清单

生成时间：2026-01-22

---

## P0 - 关键问题（必须立即修复）

### ❌ Issue #1: 客户端与服务端下注规则不一致
**严重程度**：🔴 高
**影响范围**：用户体验、业务逻辑
**问题描述**：
- 客户端 `app/constants.ts` 的 `MAX_BET`(2000) 与服务端 `lib/game-engine/constants.ts`(1000) 不一致
- 客户端 `hooks/useGameEngine.ts` 允许 RUNNING 状态下注，但服务端只接受 BETTING 状态
- 导致用户看到可以下注，但实际被服务端拒绝

**影响文件**：
- `app/constants.ts`
- `lib/game-engine/constants.ts`
- `hooks/useGameEngine.ts`

**修复建议**：
- 以服务端配置为准，同步到客户端
- 收敛常量定义到单一来源
- 将 `canBet` 逻辑限制为 BETTING 状态

**状态**：⏳ 待修复

---

### ❌ Issue #2: 缺少用户状态校验
**严重程度**：🔴 高
**影响范围**：安全、业务风险
**问题描述**：
- 服务端未校验用户 `active/silenced` 状态
- 封禁账号仍可下注或查询余额
- `prisma/schema.prisma` 中定义了相关字段但未使用

**影响文件**：
- `lib/game-engine/GameEngine.ts`
- `prisma/schema.prisma`

**修复建议**：
- 在 `GameEngine.placeBet` 中引入 `active/silenced` 检查
- 由服务端决定 `isPlayMode` 可用性
- 避免客户端绕过校验

**状态**：⏳ 待修复

---

## P1 - 重要问题（应尽快修复）

### ❌ Issue #3: 幂等性依赖 Redis，降级逻辑不完善
**严重程度**：🟡 中
**影响范围**：数据一致性、可靠性
**问题描述**：
- `orderId` 幂等性依赖 Redis 锁
- Redis 不可用时退化到 DB 唯一性异常处理
- 逻辑不对等，存在重复请求引发错误的风险

**影响文件**：
- `lib/game-engine/GameEngine.ts`

**修复建议**：
- `placeBet` 以 DB 唯一约束为最终闸门
- 捕获唯一冲突并返回旧 bet
- Redis 锁失败时不要直接放行

**状态**：⏳ 待修复

---

### ❌ Issue #4: GameEngine 职责过重，缺少测试
**严重程度**：🔴 高（技术债务）
**影响范围**：可维护性、测试覆盖率
**问题描述**：
- `GameEngine.ts` 既处理状态机又负责持久化/结算/账本/Redis
- 类体过大、职责混杂
- 测试与演进成本高
- 缺少单元测试

**影响文件**：
- `lib/game-engine/GameEngine.ts`
- `lib/services/financial.ts`

**修复建议**：
- 将结算、快照持久化、锁控制拆为独立模块
- 给 `GameEngine`/`FinancialService` 增加单元测试
- 降低回归风险

**状态**：⏳ 待修复

---

### ❌ Issue #5: 赔率模型未校准，缺少风险控制
**严重程度**：🔴 高（业务风险）
**影响范围**：盈利能力、财务风险
**问题描述**：
- 赔率模型基于静态高斯分布和时间惩罚
- 未与实际行情分布校准
- 6% house edge 可能无法保证长期盈利
- 最大赔率 100x 且单注最大 1000，极端情况下造成高额兑付压力
- 缺少资金池/敞口控制

**影响文件**：
- `lib/shared/gameMath.ts`
- `lib/game-engine/constants.ts`

**修复建议**：
- 对赔率模型做历史行情回测校准
- 引入最大单轮兑付限制
- 实现动态下注上限策略

**状态**：⏳ 待修复

---

## P2 - 优化建议（可延后处理）

### ⚠️ Issue #6: 并发性能优化
**严重程度**：🟡 中
**影响范围**：性能、可扩展性
**问题描述**：
- tick 16ms 循环在高并发下注时可能触发事件循环抖动
- 结算队列在高负载下可能超时
- 价格快照缓冲在 DB/Redis 异常时内存增长
- 分布式锁 TTL 不延展，可能导致多实例并行开局
- 心跳定时器在高连接量时开销增大

**影响文件**：
- `lib/game-engine/GameEngine.ts`
- `lib/game-engine/WebSocketGateway.ts`
- `lib/game-engine/DistributedLock.ts`

**修复建议**：
- 对快照缓冲做硬上限丢弃
- 合并心跳机制
- 增加结算队列长度/价格延迟指标
- 实现分布式锁 TTL 延展

**状态**：⏳ 待修复

---

### ⚠️ Issue #7: 代码质量改进
**严重程度**：🟡 中
**影响范围**：可维护性
**问题描述**：
- 余额服务双轨冲突（`user.ts` vs `financial.ts`）
- 资产命名不统一（`BTC` vs `BTCUSDT`）
- `GameClient` 耦合度高

**影响文件**：
- `lib/services/user.ts`
- `lib/services/financial.ts`
- `lib/game-engine/PriceService.ts`
- `lib/game-engine/GameClient.ts`

**修复建议**：
- 统一余额服务接口，移除旧接口
- 统一资产命名规范
- 解耦 `GameClient` 与 `WebSocketGateway`

**状态**：⏳ 待修复

---

### ⚠️ Issue #8: 安全加固
**严重程度**：🟡 中
**影响范围**：安全性
**问题描述**：
- `/stats` 端点仅靠静态 token，无速率限制
- 支付回调使用 MD5 签名，未做重放限制
- WebSocket origin 校验可被伪造

**影响文件**：
- `server/game-server.ts`
- `app/api/payment/notify/route.ts`
- `lib/game-engine/WebSocketGateway.ts`

**修复建议**：
- 为 `/stats` 添加速率限制和 IP 白名单
- 支付回调增加时间戳和重放检测
- 强化 WebSocket 连接验证

**状态**：⏳ 待修复

---

## 统计摘要

- **总问题数**：8 个
- **P0（关键）**：2 个
- **P1（重要）**：3 个
- **P2（优化）**：3 个

### 按严重程度分类
- 🔴 高严重程度：4 个
- 🟡 中严重程度：4 个

### 按影响范围分类
- 代码质量与架构：3 个
- 并发与性能：1 个
- 业务逻辑与盈利：2 个
- 安全与风险：2 个

---

**下一步行动**：
1. 优先修复 P0 问题（Issue #1, #2）
2. 规划 P1 问题的修复计划（Issue #3, #4, #5）
3. 将 P2 问题纳入技术债务清单（Issue #6, #7, #8）
