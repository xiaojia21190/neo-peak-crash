# 代码审查问题修复计划

## 任务分解

### Task 1: 资金安全核心修复（P0）
- **ID**: task-1-fund-safety
- **type**: default
- **描述**: 修复崩溃恢复退款逻辑、回合取消退款幂等性、资金舍入问题
- **文件范围**:
  - server/game-server.ts (孤儿回合退款)
  - lib/game-engine/GameEngine.ts (回合取消退款、资金舍入)
  - lib/shared/gameMath.ts (确保 roundMoney 被使用)
  - lib/services/user.ts (余额并发更新修复)
- **依赖**: None
- **测试命令**: `pnpm test`
- **修复内容**:
  1. 移除孤儿回合退款的 5 分钟时间过滤
  2. 回合取消退款改为幂等操作并记录流水
  3. 所有资金计算统一使用 roundMoney
  4. 修复 updateUserBalanceWithLedger 并发问题

### Task 2: 安全配置修复（P1）
- **ID**: task-2-security-config
- **type**: quick-fix
- **描述**: 修复支付回调地址、WebSocket 鉴权、Origin 校验等安全配置问题
- **文件范围**:
  - app/api/payment/recharge/route.ts (强制使用配置基址)
  - lib/game-engine/WebSocketGateway.ts (鉴权 secret 统一、Origin 校验、鉴权失败断连)
  - lib/auth.ts (添加配置检查)
  - server/game-server.ts (管理接口鉴权)
- **依赖**: None
- **测试命令**: `pnpm test`
- **修复内容**:
  1. 支付回调地址强制使用 NEXTAUTH_URL
  2. WebSocket 鉴权统一使用 AUTH_SECRET || NEXTAUTH_SECRET
  3. 添加 Origin 严格校验
  4. 鉴权失败直接断开连接
  5. 管理接口添加鉴权

### Task 3: 日志安全与输入校验（P1-P2）
- **ID**: task-3-logging-validation
- **type**: quick-fix
- **描述**: 修复日志泄露、输入校验、业务逻辑问题
- **文件范围**:
  - app/api/payment/notify/route.ts (日志脱敏)
  - lib/payment/ldc.ts (密钥传递方式)
  - lib/game-engine/GameEngine.ts (参数有限性检查)
  - next.config.ts (安全响应头)
- **依赖**: None
- **测试命令**: `pnpm test`
- **修复内容**:
  1. 支付回调日志脱敏
  2. 下注参数添加 Number.isFinite 检查
  3. 添加安全响应头
  4. 调整 Provably Fair 文案

### Task 4: 性能优化（P2）
- **ID**: task-4-performance
- **type**: default
- **描述**: 优化 Tick 性能、Redis 写入频率、内存管理
- **文件范围**:
  - lib/game-engine/GameEngine.ts (Tick 优化、快照内存管理)
  - lib/game-engine/PriceService.ts (Redis 写入采样)
- **依赖**: task-1 (避免冲突)
- **测试命令**: `pnpm test`
- **修复内容**:
  1. Tick 按 targetTime 分桶优化
  2. Redis 价格写入改为采样
  3. 快照内存队列添加上限

### Task 5: 多实例一致性（P1）
- **ID**: task-5-distributed-lock
- **type**: default
- **描述**: 添加分布式锁确保单资产单活跃回合
- **文件范围**:
  - lib/game-engine/GameEngine.ts (分布式锁)
  - server/game-server.ts (启动检查)
  - prisma/schema.prisma (可选：DB 约束)
- **依赖**: task-1 (避免冲突)
- **测试命令**: `pnpm test`
- **修复内容**:
  1. 使用 Redis 分布式锁
  2. 确保同一资产只有一个活跃回合
  3. 添加 fencing token

## 执行顺序

### 第一批（并行执行）
- Task 1: 资金安全核心修复
- Task 2: 安全配置修复
- Task 3: 日志安全与输入校验

### 第二批（依赖第一批完成）
- Task 4: 性能优化
- Task 5: 多实例一致性

## 测试策略

每个任务完成后：
1. 运行单元测试
2. 检查 TypeScript 编译
3. 验证关键功能
4. 确保无回归问题

## 验收标准

- [ ] 所有 P0 问题已修复
- [ ] 所有 P1 问题已修复
- [ ] 所有 P2 问题已修复
- [ ] TypeScript 编译无错误
- [ ] 所有测试通过
- [ ] 代码审查通过
