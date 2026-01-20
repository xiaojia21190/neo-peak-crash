# 业务逻辑改进 - 开发计划

## 概述
重新设计庄家优势策略（5-8%）、移除可证明公平方案改为市场价格透明展示、完整实现提现功能（API、审核流程、LDC退款集成）。

## 任务分解

### Task 1: 重新设计庄家优势算法
- **ID**: task-1
- **type**: default
- **Description**: 重新设计赔率和庄家优势算法，确保在所有游戏场景下庄家优势稳定在5-8%范围内，使用确定性边界计算并通过蒙特卡洛模拟验证
- **File Scope**:
  - lib/shared/gameMath.ts
  - lib/game-engine/utils.ts
  - app/constants.ts
  - tests/houseEdge.test.ts
- **Dependencies**: None
- **Test Command**: `node --test --experimental-test-coverage tests/houseEdge.test.ts`
- **Test Focus**:
  - 验证所有赔率场景下庄家优势在5-8%范围内
  - 边界测试（最小/最大倍数）
  - 蒙特卡洛模拟10000+轮次验证长期优势
  - 极端价格波动场景下的优势稳定性

### Task 2: 移除可证明公平并添加价格透明度
- **ID**: task-2
- **type**: default
- **Description**: 从游戏引擎、WebSocket、数据库模型中移除所有可证明公平相关字段和逻辑，实现市场价格快照API用于透明展示实时价格数据
- **File Scope**:
  - lib/game-engine/GameEngine.ts
  - lib/game-engine/types.ts
  - lib/game-engine/WebSocketGateway.ts
  - lib/game-engine/utils.ts
  - lib/game-engine/GameClient.ts
  - hooks/useGameEngine.ts
  - hooks/useServerGameAdapter.ts
  - prisma/schema.prisma
  - app/api/market/price-snapshots/route.ts
- **Dependencies**: task-1（依赖新的赔率算法）
- **Test Command**: `node --test --experimental-test-coverage tests/priceSnapshots.test.ts`
- **Test Focus**:
  - 验证所有可证明公平字段已从数据库和API响应中移除
  - 价格快照API返回正确的市场数据格式
  - WebSocket消息不包含seed/hash等字段
  - 价格数据时间戳和来源准确性验证

### Task 3: 实现完整提现功能
- **ID**: task-3
- **type**: default
- **Description**: 实现用户提现API、管理员审核流程、LDC退款集成，包括数据库模型扩展、余额验证、状态机管理和外部支付接口调用
- **File Scope**:
  - app/api/payment/withdraw/route.ts
  - app/api/admin/withdrawals/route.ts
  - lib/payment/ldc.ts
  - lib/services/user.ts
  - prisma/schema.prisma
  - tests/withdrawalFlow.test.ts
- **Dependencies**: task-2（依赖schema变更）, task-1（数学逻辑不变）
- **Test Command**: `node --test --experimental-test-coverage tests/withdrawalFlow.test.ts`
- **Test Focus**:
  - 用户提现请求创建（余额充足/不足场景）
  - 管理员审核流程（批准/拒绝）
  - LDC退款接口调用成功/失败处理
  - 并发提现请求的余额锁定机制
  - 提现状态机完整性（pending→approved→completed/failed）
  - 错误场景回滚和用户余额一致性

### Task 4: UI更新 - 移除可证明公平UI并添加透明度面板
- **ID**: task-4
- **type**: ui
- **Description**: 从所有前端组件中移除可证明公平相关UI元素，添加市场价格透明度展示面板，实现提现模态框组件
- **File Scope**:
  - app/page.tsx
  - components/GameStats.tsx
  - components/TutorialModal.tsx
  - components/UserMenu.tsx
  - components/RechargeModal.tsx
  - components/WithdrawModal.tsx
- **Dependencies**: task-2（依赖API变更）, task-3（依赖提现API）
- **Test Command**: `node --test --experimental-test-coverage tests/uiSmoke.test.ts`
- **Test Focus**:
  - 验证所有可证明公平UI元素已移除（种子输入、验证按钮等）
  - 市场价格面板正确渲染实时数据
  - 提现模态框表单验证（金额、最小/最大限制）
  - 提现流程用户反馈（loading、成功、错误状态）
  - 无障碍性检查（ARIA标签、键盘导航）

## 验收标准
- [ ] 庄家优势在所有游戏场景下稳定在5-8%范围内，通过10000+轮次模拟验证
- [ ] 所有可证明公平相关代码、数据库字段、API响应、UI元素已完全移除
- [ ] 市场价格透明度API正常工作，前端正确展示实时价格数据和数据来源
- [ ] 用户可成功发起提现请求，管理员可审核，LDC退款集成正常工作
- [ ] 提现流程包含完整的错误处理和余额一致性保障
- [ ] 所有单元测试通过
- [ ] 代码覆盖率 ≥90%

## 技术要点
- **庄家优势算法**: 使用确定性公式计算赔率，避免随机性导致的优势波动；在constants中配置目标优势范围（5-8%），算法自动调整赔率系数
- **价格透明度**: 从Bybit WebSocket获取的实时价格数据存储快照，API返回包含时间戳、来源、价格的结构化数据，前端以只读方式展示
- **提现安全**: 使用数据库事务确保余额扣减和提现记录创建的原子性；实现乐观锁或行级锁防止并发提现导致余额超支
- **LDC集成**: 封装LDC退款API调用，处理网络超时、API错误等异常场景，失败时回滚用户余额并记录详细日志
- **状态机管理**: 提现状态流转严格遵循 pending → approved → completed/failed 路径，禁止非法状态跳转
- **向后兼容**: 移除可证明公平时需考虑历史游戏记录的数据迁移，确保旧记录查询不报错
