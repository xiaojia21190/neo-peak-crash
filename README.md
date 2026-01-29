<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Neon Peak Crash - 加密货币倍率预测游戏

基于实时加密货币价格的高风险倍率预测游戏，支持 **Linux DO Connect** 登录和 **LDC 积分**支付。

## ✨ 特性

### 🎮 游戏功能
- 实时 Bitcoin (BTC) 价格数据（Bybit V5 WebSocket）
- 高性能 60 FPS 图表渲染（D3.js）
- 沉浸式音效和背景音乐

### 🔐 用户系统
- **Linux DO Connect** OAuth2 登录
- 用户信任等级显示
- 会话持久化

### 💰 LDC 积分系统
- 使用 **Linux DO Credit** 积分作为游戏货币
- 支持在线充值
- 实时余额显示

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env.local` 并填写配置：

```bash
cp .env.example .env.local
```

核心配置（必填）：

```env
# NextAuth 密钥 (生成: openssl rand -base64 32)
AUTH_SECRET="your-auth-secret"

# 网站 URL (OAuth 回调 & 支付回调)
NEXTAUTH_URL="http://localhost:3000"

# 数据库 (PostgreSQL / Prisma)
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"

# Redis (可选，默认 redis://localhost:6379)
# REDIS_URL="redis://localhost:6379"

# WebSocket 服务地址 (可选，默认 http://localhost:3001)
# NEXT_PUBLIC_WS_URL="http://localhost:3001"

# Linux DO OAuth2 (https://connect.linux.do)
LINUXDO_CLIENT_ID="your_client_id"
LINUXDO_CLIENT_SECRET="your_client_secret"

# Linux DO Credit 支付 (https://credit.linux.do)
LDC_CLIENT_ID="your_ldc_client_id"
LDC_CLIENT_SECRET="your_ldc_client_secret"
```

### 3. 启动开发服务器

```bash
pnpm dev
```

访问 http://localhost:3000

## 📝 Linux DO 配置指南

### OAuth2 登录配置

1. 访问 [Linux DO Connect](https://connect.linux.do)
2. 点击 **我的应用接入** → **申请新接入**
3. 填写应用信息
4. **回调地址**:
   - 开发环境: `http://localhost:3000/api/auth/callback/linux-do`
   - 生产环境: `https://your-domain.com/api/auth/callback/linux-do`
5. 获取 `Client ID` 和 `Client Secret`

> ⚠️ **注意**: OAuth 回调地址必须完全匹配，`localhost` 和 `127.0.0.1` 是不同的域名。

### LDC 支付配置

1. 访问 [Linux DO Credit](https://credit.linux.do)
2. 创建新应用
3. 配置回调地址：
   - **异步通知 URL**: `https://your-domain.com/api/payment/notify`
   - **同步跳转 URL**: `https://your-domain.com/?recharge=success`
4. 获取 `pid` (Client ID) 和 `key` (Secret)

> ⚠️ **重要**: 支付回调地址必须是**公网可访问**的 HTTPS 地址，不能使用 `127.0.0.1` 或 `localhost`。
>
> **本地开发测试支付功能**，请使用内网穿透工具：
> ```bash
> # 使用 ngrok
> ngrok http 3000
>
> # 使用 localtunnel
> npx localtunnel --port 3000
> ```
> 然后使用生成的公网地址配置回调。

## 🔧 环境变量说明

| 变量                    | 必填 | 说明                              |
| ----------------------- | ---- | --------------------------------- |
| `AUTH_SECRET`           | ✅    | NextAuth 加密密钥                 |
| `NEXTAUTH_URL`          | ✅    | 网站 URL                          |
| `DATABASE_URL`          | ✅    | PostgreSQL 连接字符串（Prisma）   |
| `LINUXDO_CLIENT_ID`     | ✅    | Linux DO OAuth Client ID          |
| `LINUXDO_CLIENT_SECRET` | ✅    | Linux DO OAuth Client Secret      |
| `LDC_CLIENT_ID`         | ✅    | Linux DO Credit Client ID         |
| `LDC_CLIENT_SECRET`     | ✅    | Linux DO Credit Client Secret     |
| `LDC_GATEWAY`           | ❌    | 支付网关地址（默认官方地址）      |
| `REDIS_URL`             | ❌    | Redis 连接字符串（默认本地 6379） |
| `NEXT_PUBLIC_WS_URL`    | ❌    | WebSocket 服务地址（前端使用）    |
| `ADMIN_TOKEN`           | ❌    | 游戏服 `/stats` Bearer Token      |

更多可选配置见 `.env.example`。

## 🔐 密钥管理最佳实践

- `.env.local` 仅用于本地开发，禁止提交到 Git（已在 `.gitignore` 中忽略 `.env.local` / `.env*.local`）
- `.env.example` 只保留变量名 + 占位符，不要写入任何真实密钥/凭据
- 生产环境使用平台的环境变量/Secrets 管理（Vercel/容器/CI），不同环境使用不同密钥
- 一旦泄露：立即吊销/轮换密钥，并检查日志、CI 输出和历史提交
- 避免在日志/报错中输出敏感值（如需排查，使用脱敏/掩码）

## 🛠️ 技术栈

- **框架**: Next.js 16 + React 19
- **图表**: D3.js
- **认证**: NextAuth v5 (Auth.js)
- **支付**: Linux DO Credit (EasyPay 协议)
- **样式**: Tailwind CSS
- **数据源**: Bybit V5 WebSocket

## 📁 项目结构

```
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/  # OAuth 回调
│   │   └── payment/             # 支付相关 API
│   ├── page.tsx                 # 主游戏页面
│   ├── types.ts                 # 类型定义
│   └── constants.ts             # 游戏常量
├── components/
│   ├── GameChart.tsx            # D3 图表组件
│   ├── UserMenu.tsx             # 用户菜单
│   ├── RechargeModal.tsx        # 充值弹窗
│   └── providers/               # Context Providers
├── lib/
│   ├── auth.ts                  # 认证配置
│   └── payment/ldc.ts           # LDC 支付服务
└── .env.example                 # 环境变量示例
```

## 📄 License

MIT
