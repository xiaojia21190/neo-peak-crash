# Comprehensive Project Fixes - Development Plan

## Overview
修复项目中的安全漏洞、业务逻辑缺陷、性能瓶颈和用户体验不一致问题，确保系统稳定性和数据完整性。

## Task Breakdown

### Task 1: 移除敏感信息日志并加固 WebSocket 认证日志
- **ID**: task-1
- **type**: quick-fix
- **Description**: 从 WebSocketGateway 中移除 cookie 敏感信息的日志输出，收紧 WebSocket 认证相关的日志记录，避免泄露用户凭证和会话令牌
- **File Scope**: lib/game-engine/WebSocketGateway.ts
- **Dependencies**: None
- **Test Command**: `pnpm lint && pnpm build`
- **Test Focus**:
  - 验证日志输出不包含 cookie、token 等敏感字段
  - 确认认证流程日志仅记录必要的审计信息（用户 ID、时间戳、结果状态）
  - 检查错误日志不暴露内部实现细节

### Task 2: 修复多实例锁处理逻辑
- **ID**: task-2
- **type**: default
- **Description**: 修复 server/game-server.ts 中的分布式锁逻辑，停止删除有效锁，依赖基于 token 的分布式锁机制，确保单一活跃游戏引擎实例
- **File Scope**: server/game-server.ts, lib/game-engine/DistributedLock.ts
- **Dependencies**: None
- **Test Command**: `pnpm test tests/game-engine/distributed-lock.test.ts --coverage --coverage-reporter=text`
- **Test Focus**:
  - 多实例并发启动场景：验证只有一个实例获得锁
  - 锁持有者崩溃场景：验证 TTL 过期后其他实例可接管
  - 锁续期机制：验证活跃实例持续持有锁
  - 锁释放场景：验证优雅关闭时正确释放锁
  - 竞态条件：验证 token 机制防止误删其他实例的锁
  - 覆盖率要求：≥90%

### Task 3: 资金和账本正确性修复
- **ID**: task-3
- **type**: default
- **Description**: 修复 Prisma datasource URL 配置、Decimal 类型处理、派彩舍入一致性、审计字段完整性，确保资金流转的准确性和可追溯性
- **File Scope**: prisma/schema.prisma, lib/game-engine/GameEngine.ts, app/api/payment/recharge/route.ts, app/api/payment/notify/route.ts
- **Dependencies**: 建议在 task-2 完成后执行（先保证系统完整性）
- **Test Command**: `pnpm test tests/payment --coverage --coverage-reporter=text && pnpm test tests/game-engine/payout.test.ts --coverage --coverage-reporter=text`
- **Test Focus**:
  - Decimal 精度测试：验证金额计算无浮点误差
  - 派彩舍入测试：验证所有派彩场景使用一致的舍入规则（向下取整到分）
  - 充值流程测试：验证充值金额正确入账，审计字段完整
  - 支付回调测试：验证幂等性、金额校验、状态转换
  - 余额一致性测试：验证下注、派彩、充值后余额计算正确
  - 数据库约束测试：验证 Prisma schema 的 datasource URL 正确配置
  - 覆盖率要求：≥90%

### Task 4: 用户体验对齐修复
- **ID**: task-4
- **type**: ui
- **Description**: 修复游戏模式与登录门控的不一致、资产切换逻辑的混乱、登录页面的缺失，确保用户流程清晰流畅
- **File Scope**: app/page.tsx, hooks/useGameEngine.ts, components/Header.tsx, components/Footer.tsx, lib/auth.ts, app/login/page.tsx (新增)
- **Dependencies**: None
- **Test Command**: `pnpm dev` (手动测试流程)
- **Test Focus**:
  - 匿名游戏流程：验证未登录用户可以进入演示模式，无法下注真金
  - 登录流程：验证登录入口清晰，登录后正确跳转
  - 充值流程：验证登录用户可以充值，充值后余额更新
  - 下注流程：验证只有登录且有余额的用户可以下注
  - 资产切换：验证真金/演示模式切换逻辑清晰，状态一致
  - 页面完整性：验证登录页面 UI 完整，符合设计规范
  - 响应式测试：验证移动端和桌面端布局正常

## Acceptance Criteria
- [ ] 所有日志输出不包含敏感信息（cookie、token、密码）
- [ ] 多实例环境下只有一个游戏引擎实例处于活跃状态
- [ ] 分布式锁机制通过所有并发和故障恢复测试
- [ ] 所有资金计算使用 Decimal 类型，无浮点误差
- [ ] 派彩舍入规则统一且符合业务规范
- [ ] 充值和支付回调流程具备幂等性和完整审计
- [ ] 用户可以清晰区分演示模式和真金模式
- [ ] 登录流程完整且用户体验流畅
- [ ] 所有单元测试通过
- [ ] 代码覆盖率 ≥90%
- [ ] 构建无错误和警告

## Technical Notes
- **安全优先**: Task 1 是快速修复，应立即执行以消除日志泄露风险
- **完整性优先**: Task 2 的分布式锁修复是系统稳定性的基础，建议在 Task 3 之前完成
- **Decimal 处理**: 使用 Prisma 的 Decimal 类型和 decimal.js 库，避免 JavaScript Number 的精度问题
- **舍入规则**: 统一使用 `Decimal.floor()` 或 `toFixed(2, Decimal.ROUND_DOWN)` 进行向下取整
- **幂等性设计**: 支付回调需要基于外部订单号去重，防止重复入账
- **用户体验**: 演示模式应明确标识，避免用户混淆；登录页面应符合现有设计系统
- **测试策略**: Task 2 和 Task 3 需要完整的单元测试覆盖，Task 4 依赖手动测试验证用户流程
- **依赖管理**: Task 3 建议在 Task 2 完成后执行，但 Task 1 和 Task 4 可以并行进行
