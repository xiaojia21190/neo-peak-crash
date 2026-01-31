# 项目核心知识库
## 项目目标
构建一个基于 Next.js 和 WebSocket 的多人在线 Crash 游戏 "Neon Peak Crash"。

## 核心共识
- **技术栈**: Next.js 16 (App Router), TypeScript, Prisma (Postgres), Socket.io, TailwindCSS v4.
- **游戏逻辑**: 服务端权威计算 (Server Authoritative)，防止作弊。
- **UI/UX**: 
    - 风格: "UI/UX Pro Max" - 玻璃拟态 (Glassmorphism), 渐变 (Gradients), 霓虹辉光 (Neon Glow).
    - 适配: 移动端优先 (Mobile-First)，Touch-Ready (GameChart touch-action-none).
- **代码规范**:
    - **CSS**: 使用 `bg-linear-to-*` 标准语法 (Tailwind v4)，废弃 `bg-gradient-to-*`。
    - **并发保护**: Tick Loop 必须限制单帧结算量 (`MAX_SETTLEMENTS_PER_TICK = 500`) 以防止 Event Loop 阻塞。
