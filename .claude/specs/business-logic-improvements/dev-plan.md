# 业务逻辑改进 - 开发计划

## 概述
修复资金并发一致性、游戏流程完整性、WebSocket 连接策略和客户端状态初始化问题,确保系统在高并发场景下的数据一致性和用户体验。

## 任务分解

### Task 1: 修复资金并发一致性
- **ID**: FIN-001
- **type**: default
- **描述**: 修复读-改-写模式导致的 balanceBefore/After 不可信问题,实现原子性余额更新和可靠的资金流水记录
- **文件范围**:
  - lib/services/financial.ts
  - app/api/payment/notify/route.ts
  - server/game-server.ts
  - app/api/user/balance/route.ts
  - prisma/schema.prisma (如需添加审计字段)
- **依赖**: 无
- **测试命令**:
  ```bash
  pnpm test --coverage --coverageDirectory=coverage/financial
  pnpm test:rateLimit
  ```
- **测试重点**:
  - 并发余额更新的原子性(使用 Prisma 原子操作或数据库事务)
  - balanceBefore/After 字段的准确性验证
  - 资金流水与 betId 的正确关联
  - 高并发场景下的数据一致性(100+ 并发请求)
  - 充值回调的幂等性保证
  - 余额不足时的正确拒绝

### Task 2: 游戏流程/下注/结算一致性加固
- **ID**: GAME-002
- **type**: default
- **描述**: 完善 Round 状态机,确保 BETTING→RUNNING 状态转换落库,防止并发滑入风险,加固下注和结算逻辑
- **文件范围**:
  - lib/game-engine/GameEngine.ts
  - prisma/schema.prisma (Round 状态字段)
  - lib/game-engine/types.ts (状态定义)
- **依赖**: 可独立推进
- **测试命令**:
  ```bash
  pnpm test:payoutConsistency
  pnpm test:priceSnapshots
  npx tsx tests/gameEngine.test.ts --coverage
  ```
- **测试重点**:
  - Round 状态转换的完整性(所有状态变更必须落库)
  - BETTING→RUNNING 转换时的并发安全性
  - 下注时机验证(只能在 BETTING 阶段下注)
  - 结算金额计算的准确性(multiplier 应用)
  - 价格快照的正确记录和使用
  - 状态回滚机制(异常情况下的恢复)

### Task 3: WebSocket 网关行为与恢复
- **ID**: WS-003
- **type**: default
- **描述**: 统一 WebSocket 匿名连接策略,修复服务端拒绝未认证连接与客户端允许匿名下注的矛盾,完善重连和状态同步机制
- **文件范围**:
  - lib/game-engine/WebSocketGateway.ts
  - lib/game-engine/types.ts (事件定义)
  - server/game-server.ts (认证中间件)
- **依赖**: 与 UI-004 协议需对齐
- **测试命令**:
  ```bash
  pnpm game:server
  # 手工测试: 匿名连接、认证连接、重连场景
  ```
- **测试重点**:
  - 匿名用户连接策略(允许连接但限制操作)
  - 认证用户的权限验证
  - 重连后的状态完整同步(当前 Round、用户余额、历史下注)
  - 连接断开时的资源清理
  - 心跳机制的正确实现
  - 错误事件的正确广播

### Task 4: 客户端状态初始化与下注体验
- **ID**: UI-004
- **type**: ui
- **描述**: 修复中途刷新/重连时 state=null 问题,完善客户端状态初始化逻辑,优化下注交互体验
- **文件范围**:
  - lib/game-engine/GameClient.ts
  - hooks/useGameEngine.ts
  - hooks/useServerGameAdapter.ts
  - app/**/page.tsx (游戏页面组件)
  - components/game/** (游戏 UI 组件)
- **依赖**: WS-003 (需要服务端提供完整的状态同步)
- **测试命令**:
  ```bash
  pnpm dev
  # 手工验证: 刷新页面、断网重连、下注流程
  ```
- **测试重点**:
  - 页面刷新后的状态恢复(Round 信息、余额、历史)
  - 重连后的 UI 状态同步
  - 下注按钮的禁用/启用逻辑(根据 Round 状态)
  - 余额实时更新的准确性
  - 加载状态的友好提示
  - 错误提示的清晰展示

### Task 5: 快速风险收敛
- **ID**: QF-005
- **type**: quick-fix
- **描述**: 修复 app/api/user/balance/route.ts 中的即时风险点(如缺少认证检查、错误处理不完整等)
- **文件范围**:
  - app/api/user/balance/route.ts
- **依赖**: 无
- **测试命令**:
  ```bash
  pnpm dev
  # 手工测试: 未认证访问、异常输入
  ```
- **测试重点**:
  - 认证检查的完整性
  - 输入验证(参数类型、范围)
  - 错误响应的规范性
  - 日志记录的完整性

## 验收标准
- [ ] 资金并发一致性: balanceBefore/After 准确,资金流水完整关联 betId
- [ ] Round 状态机完整: 所有状态转换落库,无并发滑入风险
- [ ] WebSocket 策略统一: 匿名/认证连接策略明确,重连状态同步完整
- [ ] 客户端状态初始化: 刷新/重连后 state 正确恢复,下注体验流畅
- [ ] 快速风险点修复: balance API 认证和错误处理完整
- [ ] 所有单元测试通过
- [ ] 代码覆盖率 ≥90%
- [ ] 并发压力测试通过(100+ 并发请求无数据不一致)
- [ ] 手工验证完整用户流程: 登录 → 连接 → 下注 → 结算 → 刷新 → 重连

## 技术要点
- **并发控制**: 使用 Prisma 原子操作(`update` with `increment`/`decrement`)或数据库事务,避免读-改-写模式
- **状态机完整性**: 每次状态转换必须立即持久化到数据库,不能仅在内存中维护
- **WebSocket 策略**: 建议允许匿名连接但限制操作权限(只读),认证后解锁完整功能
- **客户端恢复**: 连接建立后立即请求完整状态快照(`game:state` 事件),不依赖增量更新
- **资金流水**: Transaction 表的 `metadata` 字段必须包含 `betId`,便于审计和对账
- **测试覆盖**: 重点覆盖并发场景、边界条件和异常恢复路径
- **向后兼容**: 修改 WebSocket 协议时保持客户端兼容性,使用版本协商或渐进式迁移
