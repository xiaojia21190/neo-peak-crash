# 代码审查问题修复 - Development Plan

## Overview
修复代码审查中发现的 P0 和 P1 级别问题，包括客户端与服务端规则不一致、用户状态校验缺失、幂等性降级逻辑不完善、GameEngine 职责过重以及赔率模型未校准等关键问题。

## Task Breakdown

### Task 1: 统一客户端与服务端配置和下注规则
- **ID**: task-1
- **type**: quick-fix
- **Description**: 修复客户端与服务端的下注规则不一致问题。将 `app/constants.ts` 中的 `MAX_BET` 从 2000 修改为 1000 以匹配服务端配置；修改 `hooks/useGameEngine.ts` 中的 `canBet` 逻辑，仅允许 BETTING 状态下注，禁止 RUNNING 状态下注；确保所有下注相关常量（MAX_BET、MIN_BET、COUNTDOWN_TIME）在客户端和服务端保持一致。
- **File Scope**:
  - `app/constants.ts`
  - `hooks/useGameEngine.ts`
  - `lib/game-engine/constants.ts` (验证配置)
- **Dependencies**: None
- **Test Command**: `pnpm test hooks/useGameEngine.test.ts --coverage --coveragePathIgnorePatterns=/node_modules/`
- **Test Focus**:
  - 验证 `canBet` 仅在 BETTING 状态返回 true
  - 验证 RUNNING/CRASHED 状态下 `canBet` 返回 false
  - 验证 MAX_BET 限制在客户端正确应用
  - 验证下注金额超过 1000 时被拒绝

### Task 2: 实现用户状态校验
- **ID**: task-2
- **type**: default
- **Description**: 在 `GameEngine.placeBet` 方法中添加用户状态校验逻辑。在处理下注请求前，查询用户的 `active` 和 `silenced` 字段；如果用户 `active=false`，拒绝下注并返回 "账号已被封禁" 错误；如果用户 `silenced=true`，拒绝下注并返回 "账号已被禁言" 错误；确保所有涉及用户操作的接口（余额查询、下注历史等）都进行状态校验。
- **File Scope**:
  - `lib/game-engine/GameEngine.ts` (placeBet 方法)
  - `app/api/balance/route.ts` (余额查询接口)
  - `app/api/bets/route.ts` (下注历史接口)
  - `prisma/schema.prisma` (验证字段定义)
- **Dependencies**: None
- **Test Command**: `pnpm test lib/game-engine/GameEngine.test.ts --coverage --testNamePattern="user status validation"`
- **Test Focus**:
  - 验证 active=false 的用户无法下注
  - 验证 silenced=true 的用户无法下注
  - 验证正常用户（active=true, silenced=false）可以下注
  - 验证错误消息正确返回
  - 验证余额查询和历史查询也进行状态校验

### Task 3: 强化幂等性和 Redis 降级逻辑
- **ID**: task-3
- **type**: default
- **Description**: 改进 `GameEngine.placeBet` 中的幂等性处理逻辑。将 DB 唯一约束作为最终闸门，而不是仅依赖 Redis 锁；在 Redis 不可用时，使用 try-catch 捕获 Prisma 的唯一约束冲突（P2002 错误码），并查询返回已存在的 bet 记录；确保 Redis 锁失败时不直接放行，而是继续尝试 DB 插入并处理冲突；添加详细的日志记录，区分 Redis 降级场景和正常场景。
- **File Scope**:
  - `lib/game-engine/GameEngine.ts` (placeBet 方法)
- **Dependencies**: depends on task-4
- **Test Command**: `pnpm test lib/game-engine/GameEngine.test.ts --coverage --testNamePattern="idempotency"`
- **Test Focus**:
  - 验证相同 orderId 的重复请求返回相同结果
  - 验证 Redis 不可用时幂等性仍然有效
  - 验证 DB 唯一约束冲突被正确捕获和处理
  - 验证降级场景下的日志记录
  - 验证并发请求的幂等性保证

### Task 4: 重构 GameEngine 并补充测试
- **ID**: task-4
- **type**: default
- **Description**: 将 `GameEngine.ts` 中的职责拆分为独立模块。创建 `SettlementService` 负责结算逻辑；创建 `SnapshotService` 负责快照持久化；创建 `LockManager` 负责分布式锁控制；保持 `GameEngine` 仅负责状态机转换和事件协调；为 `GameEngine`、`FinancialService`、`SettlementService` 添加单元测试，覆盖核心业务逻辑；确保测试覆盖率 ≥90%。
- **File Scope**:
  - `lib/game-engine/GameEngine.ts`
  - `lib/game-engine/SettlementService.ts` (新建)
  - `lib/game-engine/SnapshotService.ts` (新建)
  - `lib/game-engine/LockManager.ts` (新建)
  - `lib/services/financial.ts`
  - `__tests__/lib/game-engine/` (新建测试目录)
  - `__tests__/lib/services/` (新建测试目录)
- **Dependencies**: None
- **Test Command**: `pnpm test lib/game-engine/ lib/services/financial.ts --coverage --coverageThreshold='{"global":{"branches":90,"functions":90,"lines":90,"statements":90}}'`
- **Test Focus**:
  - 验证状态机转换逻辑（IDLE → BETTING → RUNNING → CRASHED）
  - 验证结算队列处理逻辑
  - 验证快照持久化逻辑
  - 验证分布式锁获取和释放
  - 验证 FinancialService 的账本操作和余额计算
  - 验证并发场景下的数据一致性
  - 验证错误处理和降级逻辑

### Task 5: 校准赔率模型并建立风险控制
- **ID**: task-5
- **type**: default
- **Description**: 对 `gameMath.ts` 中的赔率模型进行历史行情回测校准。收集 BTC 历史价格数据，分析实际崩盘点分布；调整高斯分布参数和时间惩罚系数，确保 house edge ≥8%；在 `constants.ts` 中引入最大单轮兑付限制（MAX_ROUND_PAYOUT）；实现动态下注上限策略，根据当前资金池和敞口动态调整 MAX_BET；添加风险监控指标（单轮总下注、预期兑付、资金池余额）；为赔率计算和风险控制逻辑添加单元测试。
- **File Scope**:
  - `lib/shared/gameMath.ts`
  - `lib/game-engine/constants.ts`
  - `lib/game-engine/RiskManager.ts` (新建)
  - `scripts/backtest-payout-model.ts` (新建回测脚本)
  - `__tests__/lib/shared/gameMath.test.ts` (新建测试)
- **Dependencies**: None
- **Test Command**: `pnpm test lib/shared/gameMath.test.ts lib/game-engine/RiskManager.test.ts --coverage --coverageThreshold='{"global":{"branches":90,"functions":90,"lines":90,"statements":90}}'`
- **Test Focus**:
  - 验证赔率计算的正确性（不同崩盘点对应的赔率）
  - 验证 house edge ≥8% 在各种场景下成立
  - 验证最大单轮兑付限制生效
  - 验证动态下注上限根据资金池正确调整
  - 验证风险监控指标计算准确
  - 使用历史数据进行回测，验证长期盈利能力

## Acceptance Criteria
- [ ] 客户端与服务端的 MAX_BET、MIN_BET、COUNTDOWN_TIME 等常量完全一致
- [ ] 客户端仅允许 BETTING 状态下注，RUNNING/CRASHED 状态禁止下注
- [ ] 所有用户操作接口都进行 active/silenced 状态校验
- [ ] 封禁或禁言用户无法下注、查询余额或历史
- [ ] orderId 幂等性在 Redis 可用和不可用时都能保证
- [ ] DB 唯一约束作为幂等性的最终闸门
- [ ] GameEngine 职责拆分为独立模块（SettlementService、SnapshotService、LockManager）
- [ ] GameEngine、FinancialService、SettlementService 都有完整的单元测试
- [ ] 赔率模型经过历史数据回测校准，house edge ≥8%
- [ ] 实现最大单轮兑付限制和动态下注上限策略
- [ ] 所有修改的模块测试覆盖率 ≥90%
- [ ] 所有单元测试通过
- [ ] 集成测试验证端到端流程正常

## Technical Notes
- **配置同步策略**: 建议将服务端配置作为唯一真实来源，客户端通过 API 获取配置而非硬编码
- **用户状态缓存**: 考虑在 Redis 中缓存用户状态，避免每次下注都查询数据库
- **幂等性实现**: DB 唯一约束（userId + roundId + orderId）是最可靠的幂等性保证，Redis 仅作为性能优化
- **模块拆分原则**: 遵循单一职责原则，每个模块只负责一个明确的功能领域
- **测试策略**: 优先编写单元测试覆盖核心逻辑，再补充集成测试验证端到端流程
- **赔率校准方法**: 使用蒙特卡洛模拟和历史数据回测相结合的方式校准模型参数
- **风险控制阈值**: MAX_ROUND_PAYOUT 建议设置为资金池的 10-20%，动态下注上限根据当前敞口实时调整
- **向后兼容性**: 重构时保持 GameEngine 的公共接口不变，避免影响 WebSocketGateway 和其他调用方
- **性能考虑**: 用户状态校验和风险计算应该尽量轻量，避免影响下注响应时间
- **监控指标**: 建议添加 Prometheus 指标监控幂等性降级次数、风险控制触发次数等关键事件
