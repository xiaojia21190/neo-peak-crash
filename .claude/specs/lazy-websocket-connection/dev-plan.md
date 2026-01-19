# 延迟 WebSocket 连接 - 开发计划

## 概述
将 WebSocket 连接从登录后立即建立改为点击"游戏开始"按钮时才建立，以节省服务器资源和客户端连接开销。

## 任务分解

### Task 1: 改为显式连接模式
- **ID**: task-1
- **type**: default
- **描述**: 修改 `useGameEngine` 和 `useServerGameAdapter` hooks，关闭自动连接（`autoConnect: false`），并向上暴露 `connect`/`disconnect` 方法。同时在会话失效或登出时主动断开连接，避免残留连接占用资源。
- **文件范围**:
  - `hooks/useGameEngine.ts`
  - `hooks/useServerGameAdapter.ts`
- **依赖**: None
- **测试命令**: `node --test --experimental-test-coverage --import tsx tests/hooks/useGameEngine.test.ts tests/hooks/useServerGameAdapter.test.ts`
- **测试重点**:
  - 验证 `autoConnect: false` 时不会自动建立连接
  - 验证 `connect()` 方法能正确触发连接
  - 验证 `disconnect()` 方法能正确断开连接
  - 验证会话失效时自动调用 `disconnect()`
  - 验证重连逻辑仅在已启动连接后生效
  - 验证连接状态变化的正确性（disconnected → connecting → connected）

### Task 2: UI 连接触发
- **ID**: task-2
- **type**: ui
- **描述**: 修改 `Footer.tsx` 的 Start 按钮逻辑，使其在未连接状态下触发 WebSocket 连接。调整按钮可用状态和文案逻辑：未连接时显示"开始游戏"并可点击，连接中显示"连接中..."并禁用，已连接后保持现有行为。同时更新 `page.tsx` 以传递连接控制方法。
- **文件范围**:
  - `app/page.tsx`
  - `components/Footer.tsx`
- **依赖**: task-1
- **测试命令**: `node --test --experimental-test-coverage --import tsx tests/components/Footer.test.ts tests/app/page.test.ts`
- **测试重点**:
  - 验证未连接时 Start 按钮可点击且显示正确文案
  - 验证点击 Start 按钮后触发 `connect()` 调用
  - 验证连接中状态下按钮禁用且显示"连接中..."
  - 验证连接成功后按钮恢复正常行为
  - 验证连接失败时的错误处理和用户反馈
  - 验证登出后连接状态正确重置

## 验收标准
- [ ] 登录后不再自动建立 WebSocket 连接
- [ ] 点击"游戏开始"按钮时才建立 WebSocket 连接
- [ ] 连接建立过程中按钮显示"连接中..."状态并禁用
- [ ] 连接成功后游戏正常运行，保持现有功能不变
- [ ] 会话失效或登出时主动断开 WebSocket 连接
- [ ] 自动重连逻辑仅在已启动连接后生效
- [ ] 所有单元测试通过
- [ ] 代码覆盖率 ≥90%

## 技术说明
- **连接时机变更**: 从 `sessionStatus === "authenticated"` 自动连接改为用户显式点击 Start 按钮触发
- **连接控制**: 通过 `useServerGameAdapter` 暴露的 `connect`/`disconnect` 方法实现显式控制
- **重连策略**: 保留 `GameClient` 的自动重连机制，但仅在用户已启动连接后生效，避免未授权的自动连接
- **生命周期管理**: 在组件卸载和会话失效时确保调用 `disconnect()`，防止资源泄漏
- **UI 状态同步**: Start 按钮需要根据 `isConnected` 和 `isConnecting` 状态动态调整可用性和文案
- **向后兼容**: 保持 `GameClient` 和 `GameEngine` 的现有 API 不变，仅调整 hooks 层的连接触发逻辑
