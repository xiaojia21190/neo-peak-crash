# Neon Peak Crash 项目全面审查报告

生成时间：2026-01-22
审查范围：代码质量与架构、并发与性能、业务逻辑与盈利、安全与风险

---

## 项目概览

- **技术栈**：Next.js 16/React 19/TypeScript 为核心，服务端使用 Socket.IO、Prisma、PostgreSQL、Redis、ws(Bybit) 与 NextAuth，前端采用 Tailwind + D3
- **架构模式**：双进程架构
  - Web/UI/API 由 Next.js 承载
  - 独立游戏引擎/网关在 `server/game-server.ts` 运行并通过 WebSocket 对外服务
- **状态管理**：状态与资金流动由引擎主导，Redis 做锁与限流，PostgreSQL 持久化回合、投注与账本
- **核心模块**：
  - `lib/game-engine/GameEngine.ts` - 游戏引擎核心
  - `lib/game-engine/WebSocketGateway.ts` - WebSocket 网关
  - `lib/game-engine/PriceService.ts` - 价格服务
  - `lib/services/financial.ts` - 财务服务

---

## 代码库探索

### 服务端架构
- `server/game-server.ts`：负责启动网关、等待行情、清理孤儿回合、开启自动轮次与健康/统计端点
- `lib/game-engine/*`：事件驱动引擎与网关组合，包含分布式锁、bet heap、结算队列与价格快照缓冲

### 业务逻辑层
- `lib/services/financial.ts`：统一账本逻辑
- `lib/services/user.ts`：保留历史余额接口形成双轨
- `app/api/*`：提供余额、投注历史、支付回调、行情快照读取等 REST 入口

### 客户端架构
- `hooks/useServerGameAdapter.ts` + `lib/game-engine/GameClient.ts`：将 WebSocket 状态映射到 UI

---

## 问题分析

### 1. 代码质量与架构

#### 🔴 高严重程度
- **GameEngine 职责过重**（`lib/game-engine/GameEngine.ts`）
  - 既处理状态机又负责持久化/结算/账本/Redis
  - 类体过大、职责混杂
  - 测试与演进成本高

#### 🟡 中严重程度
- **余额服务双轨冲突**（`lib/services/user.ts` vs `lib/services/financial.ts`）
  - `user.ts` 保留余额/结算旧接口
  - 与 `financial.ts` 的"单一事实源"承诺冲突
  - 存在误用风险

- **客户端与服务端规则漂移**
  - `app/constants.ts` 的 `MAX_BET`/`COUNTDOWN_TIME` 与 `lib/game-engine/constants.ts` 不一致
  - `hooks/useGameEngine.ts` 允许 RUNNING 下注但服务端拒绝

- **资产命名不统一**
  - `PriceService` 使用 `asset: 'BTC'`
  - 引擎与快照默认 `BTCUSDT`
  - Redis key/分析维度容易产生歧义

#### 🟢 低/中严重程度
- **GameClient 耦合度高**（`lib/game-engine/GameClient.ts`）
  - 依赖网关兼容性事件
  - 未使用 `STATE_SNAPSHOT`
  - 耦合 `WebSocketGateway` 的兼容逻辑

---

### 2. 并发与性能

#### 🟡 中严重程度
- **tick 循环事件抖动风险**（`lib/game-engine/GameEngine.ts`）
  - 16ms 循环在高并发下注时可能一次性处理大量 `betHeap` 项
  - 触发 DB 结算时存在事件循环抖动风险

- **结算队列超时风险**
  - 高负载下可能触发 `flushSettlementQueue` 超时
  - 后续补偿逻辑会加重数据库压力

- **价格快照缓冲内存增长**（`lib/game-engine/GameEngine.ts`）
  - 通过 head 索引丢弃旧数据但只有 flush 时才释放数组
  - DB/Redis 异常导致 backoff 时内存增长风险

- **分布式锁 TTL 不延展**（`lib/game-engine/DistributedLock.ts`）
  - round 处理卡顿或节点暂停时锁过期
  - 可能导致多实例并行开局

#### 🟢 低/中严重程度
- **心跳定时器开销**（`lib/game-engine/WebSocketGateway.ts`）
  - 为每个 socket 建 heartbeat timer
  - 连接量上升时定时器开销增大

---

### 3. 业务逻辑与盈利

#### 🔴 高严重程度
- **赔率模型未校准**（`lib/shared/gameMath.ts`）
  - 基于静态高斯分布和时间惩罚
  - 未与实际行情分布校准
  - 6% house edge 可能无法保证长期盈利

#### 🟡 中严重程度
- **缺乏资金池/敞口控制**（`lib/game-engine/constants.ts`）
  - 最大赔率 100x 且单注最大 1000
  - 极端情况下造成高额兑付压力

- **下注窗口不一致**
  - 前端 `hooks/useGameEngine.ts` 允许 RUNNING 下注
  - 服务端 `lib/game-engine/GameEngine.ts` 只接受 BETTING
  - 导致拒单与体验差

- **最大下注限制不一致**
  - 客户端 `app/constants.ts`(2000) 与服务端 `lib/game-engine/constants.ts`(1000) 不一致
  - 玩家看到可下注却被拒

#### 🟢 低/中严重程度
- **补偿结算判定风险**（`lib/game-engine/GameEngine.ts`）
  - `endRound` 的补偿结算使用回合结束快照判断输赢
  - 队列积压时可能出现非预期输赢判定

---

### 4. 安全与风险

#### 🟡 中严重程度
- **orderId 幂等性依赖 Redis**（`lib/game-engine/GameEngine.ts`）
  - Redis 不可用时退化到 DB 唯一性异常处理
  - 逻辑不对等，存在重复请求引发错误的风险

- **未校验用户状态**
  - 未校验用户 `active/silenced` 状态
  - 封禁账号仍可下注或查询余额
  - 相关字段在 `prisma/schema.prisma` 但未使用

- **统计端点安全性弱**（`server/game-server.ts`）
  - `/stats` 仅靠静态 token
  - 无速率限制或 IP 白名单
  - 暴露在公网时有被枚举风险

#### 🟢 低/中严重程度
- **支付回调安全性**（`app/api/payment/notify/route.ts`）
  - 使用 MD5 签名且接受 GET/POST
  - 未做时间戳/重放限制
  - 依赖密钥安全

- **WebSocket origin 校验可伪造**（`lib/game-engine/WebSocketGateway.ts`）
  - origin 校验可被非浏览器客户端伪造
  - 匿名连接虽只读但消耗资源

---

## 改进建议（按优先级排序）

### P0 - 关键问题（必须立即修复）

1. **统一下注规则与常量来源**
   - 以服务端配置为准同步到客户端
   - 收敛 `app/constants.ts` 与 `lib/game-engine/constants.ts`
   - 将 `hooks/useGameEngine.ts` 的 `canBet` 限制为 BETTING
   - 影响文件：
     - `app/constants.ts`
     - `lib/game-engine/constants.ts`
     - `hooks/useGameEngine.ts`

2. **服务端强制校验用户状态/模式**
   - 在 `lib/game-engine/GameEngine.ts` 引入 `active/silenced` 检查
   - 由服务端决定 `isPlayMode` 可用性
   - 避免客户端绕过
   - 影响文件：
     - `lib/game-engine/GameEngine.ts`
     - `prisma/schema.prisma`

### P1 - 重要问题（应尽快修复）

3. **强化幂等与 Redis 降级**
   - `placeBet` 以 DB 唯一约束为最终闸门
   - 捕获唯一冲突并返回旧 bet
   - Redis 锁失败时不要直接放行
   - 影响文件：
     - `lib/game-engine/GameEngine.ts`

4. **拆分引擎职责并补测试**
   - 将结算、快照持久化、锁控制拆为模块
   - 给 `GameEngine`/`FinancialService` 增加单测
   - 降低回归风险
   - 影响文件：
     - `lib/game-engine/GameEngine.ts`
     - `lib/services/financial.ts`

5. **建立盈利与风险控制**
   - 对赔率模型做历史行情回测校准
   - 引入最大单轮兑付/动态下注上限策略
   - 影响文件：
     - `lib/shared/gameMath.ts`
     - `lib/game-engine/constants.ts`

### P2 - 优化建议（可延后处理）

6. **性能与可观测性硬化**
   - 对快照缓冲做硬上限丢弃
   - 合并心跳机制
   - 增加结算队列长度/价格延迟指标
   - 影响文件：
     - `lib/game-engine/GameEngine.ts`
     - `lib/game-engine/WebSocketGateway.ts`

---

## 测试建议

### 现有测试
- 未在审查过程中运行测试
- 建议运行以下测试验证核心逻辑：
  - `pnpm test` - 运行所有测试
  - `pnpm test:rateLimit` - 速率限制测试
  - `pnpm test:priceSnapshots` - 价格快照测试
  - `pnpm test:payoutConsistency` - 赔付一致性测试

### 需要补充的测试
1. **GameEngine 单元测试**
   - 状态机转换测试
   - 并发下注处理测试
   - 结算队列测试

2. **FinancialService 单元测试**
   - 账本操作测试
   - 余额计算测试
   - 事务一致性测试

3. **集成测试**
   - 端到端游戏流程测试
   - 高并发压力测试
   - Redis/DB 故障恢复测试

---

## 下一步行动

1. **立即行动（P0）**
   - 统一客户端与服务端的下注规则和常量
   - 实现用户状态校验

2. **短期计划（P1）**
   - 强化幂等性和 Redis 降级逻辑
   - 拆分 GameEngine 职责
   - 校准赔率模型并建立风险控制

3. **长期优化（P2）**
   - 性能优化和可观测性提升
   - 补充完整的测试覆盖

---

**审查完成**
Session ID: 019be598-29a3-7ba0-a369-9122428f908f
