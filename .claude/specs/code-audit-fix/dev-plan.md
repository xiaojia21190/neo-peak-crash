# 代码审计修复 - 开发计划

## 概述
修复 P0-P3 级别的安全、数据一致性和业务逻辑问题，确保资金安全、服务稳定性和前后端一致性。

## 任务分解

### Task 1: 补齐 Prisma 迁移/对齐 schema
- **ID**: task-1
- **type**: default
- **描述**: 修复数据库 schema 与 migration 文件的严重漂移问题，确保数据库结构与代码定义一致，避免运行时错误和数据丢失风险
- **文件范围**:
  - prisma/schema.prisma
  - prisma/migrations/**
  - package.json (scripts 部分)
- **依赖**: None
- **测试命令**:
  ```bash
  pnpm db:generate && pnpm db:migrate && pnpm db:push --accept-data-loss
  ```
- **测试重点**:
  - schema.prisma 中所有模型字段与最新 migration 完全一致
  - 执行 db:generate 无警告或错误
  - 执行 db:migrate 能成功应用所有待处理迁移
  - 验证关键表（User, Bet, Transaction）的索引和约束完整性
  - 检查外键关系正确性

### Task 2: 修复 WS 鉴权与跨域策略
- **ID**: task-2
- **type**: quick-fix
- **描述**: 修复 WebSocket 鉴权变量名不匹配问题（userId vs user_id），收紧 CORS 策略，移除不安全的 credentials: true 配置
- **文件范围**:
  - lib/game-engine/WebSocketGateway.ts (鉴权逻辑)
  - server/game-server.ts (CORS 配置)
  - .env.example
  - .env.game-server.example
- **依赖**: None
- **测试命令**:
  ```bash
  pnpm game:server & sleep 3 && curl -H "Origin: http://malicious.com" http://localhost:3001/health
  ```
- **测试重点**:
  - WebSocket 连接时正确读取 userId 字段
  - 未授权连接被拒绝（401/403）
  - CORS 仅允许白名单域名（localhost:3000, 生产域名）
  - credentials: true 仅在必要时启用且配合严格 origin 检查
  - 验证 token 过期/伪造场景下的拒绝行为

### Task 3: 服务崩溃恢复与资金一致性
- **ID**: task-3
- **type**: default
- **描述**: 实现服务崩溃时的自动退款机制，确保进行中的投注在服务重启后能正确退款，避免资金卡死
- **文件范围**:
  - server/game-server.ts (启动恢复逻辑)
  - lib/game-engine/GameEngine.ts (状态恢复、退款逻辑)
  - prisma/schema.prisma (Bet 状态字段)
- **依赖**: task-1
- **测试命令**:
  ```bash
  pnpm game:server & sleep 5 && kill -9 $! && pnpm game:server && pnpm test:recovery
  ```
- **测试重点**:
  - 服务启动时扫描所有 status=PENDING 的投注
  - 对超过 5 分钟未结算的投注执行自动退款
  - 退款操作更新 User.balance 和 Bet.status=REFUNDED
  - 记录退款操作到 Transaction 表（如果存在）
  - 验证并发退款的幂等性（防止重复退款）
  - 覆盖率 ≥90%（包括边界场景：0 笔待退款、大量待退款）

### Task 4: 统一前后端行索引/赔率/抽水算法
- **ID**: task-4
- **type**: ui
- **描述**: 修复前后端坐标系不一致（前端 0-based vs 后端 1-based）和赔率计算差异，确保用户看到的赔率与实际结算一致
- **文件范围**:
  - app/constants.ts (前端常量)
  - components/GameChart.tsx (UI 渲染)
  - lib/game-engine/constants.ts (后端常量)
  - lib/game-engine/utils.ts (赔率计算)
  - lib/game-engine/types.ts (类型定义)
  - lib/game-engine/GameEngine.ts (结算逻辑)
  - lib/game-engine/WebSocketGateway.ts (消息序列化)
  - hooks/useServerGameAdapter.ts (前端适配层)
- **依赖**: task-2
- **测试命令**:
  ```bash
  pnpm dev:all && pnpm test:e2e -- --grep "payout consistency"
  ```
- **测试重点**:
  - 前后端使用统一的行索引基准（建议统一为 0-based）
  - 赔率计算公式完全一致（HOUSE_EDGE=0.06 正确应用）
  - 前端展示的预期赔率与后端结算赔率误差 <0.01
  - 验证边界行（第 1 行、最后一行）的赔率正确性
  - 时间奖励赔率调控逻辑前后端一致
  - UI 显示的坐标与实际投注位置匹配

### Task 5: 引入可审计资金流水
- **ID**: task-5
- **type**: default
- **描述**: 新增 Transaction 表记录所有资金变动（充值、下注、结算、退款），支持审计和对账，解决资金流向不透明问题
- **文件范围**:
  - prisma/schema.prisma (新增 Transaction 模型)
  - lib/game-engine/GameEngine.ts (结算时写流水)
  - app/api/user/bets/route.ts (下注时写流水)
  - app/api/payment/notify/route.ts (充值时写流水)
  - lib/services/user.ts (余额操作封装)
- **依赖**: task-1
- **测试命令**:
  ```bash
  pnpm db:migrate && pnpm test -- --grep "transaction audit" --coverage --coverageThreshold='{"global":{"lines":90}}'
  ```
- **测试重点**:
  - Transaction 表包含字段：id, userId, type(DEPOSIT/BET/WIN/REFUND), amount, balanceBefore, balanceAfter, relatedBetId, createdAt
  - 每次余额变动必须写入一条流水记录
  - 流水记录的 balanceBefore + amount = balanceAfter
  - 验证并发下注时流水记录的原子性和顺序性
  - 支持按用户、时间范围、类型查询流水
  - 覆盖率 ≥90%（包括充值、下注、赢钱、退款四种场景）

## 验收标准
- [ ] P0-1: 数据库 schema 与 migration 完全一致，无漂移警告
- [ ] P0-2: 服务崩溃后自动退款机制生效，无资金卡死
- [ ] P0-3: WebSocket 鉴权变量名统一，未授权连接被拒绝
- [ ] P0-4: 前后端赔率计算一致，误差 <0.01
- [ ] P1-1: CORS 策略收紧，仅允许白名单域名
- [ ] P1-2: 所有资金变动记录到 Transaction 表，支持审计
- [ ] P1-3: 回合状态正确写回数据库（如需要）
- [ ] 所有单元测试通过
- [ ] 代码覆盖率 ≥90%
- [ ] E2E 测试覆盖关键流程（下注-结算-退款）

## 技术要点

### 关键技术决策
1. **坐标系统一**：统一采用 0-based 索引，前端 UI 显示时 +1
2. **退款策略**：服务启动时扫描 PENDING 状态且 createdAt < now - 5min 的投注
3. **流水表设计**：使用 balanceBefore/balanceAfter 双字段确保可审计性
4. **鉴权变量**：统一使用 userId（camelCase），与 Prisma 模型一致
5. **CORS 配置**：使用环境变量 ALLOWED_ORIGINS，默认仅 localhost:3000

### 约束条件
1. **数据库迁移**：必须先备份生产数据，使用 --accept-data-loss 需人工确认
2. **向后兼容**：前端适配层（useServerGameAdapter）需兼容旧版 WebSocket 消息格式
3. **性能要求**：启动恢复扫描需在 10 秒内完成，避免阻塞服务启动
4. **幂等性**：退款操作必须幂等，防止重复退款导致余额异常

### 风险评估
- **高风险**：Task 1（数据库迁移）可能导致数据丢失，需在测试环境充分验证
- **中风险**：Task 4（坐标系统一）涉及大量文件修改，需完整回归测试
- **低风险**：Task 2（鉴权修复）改动范围小，影响可控

### 测试策略
1. **单元测试**：每个 task 独立测试，覆盖率 ≥90%
2. **集成测试**：Task 3/4/5 需测试完整流程（下注→崩溃→恢复→退款）
3. **E2E 测试**：验证前端 UI 显示与后端结算的一致性
4. **压力测试**：验证并发下注时流水记录的正确性（Task 5）

### 部署顺序
1. Task 1（数据库迁移）→ 先在测试环境验证
2. Task 2（鉴权修复）→ 可独立部署
3. Task 3（崩溃恢复）→ 依赖 Task 1
4. Task 5（流水表）→ 依赖 Task 1
5. Task 4（前后端统一）→ 最后部署，需完整回归测试
