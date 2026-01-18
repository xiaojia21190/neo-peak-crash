/**
 * 独立游戏服务器入口
 *
 * 运行方式：pnpm game:server
 *
 * 环境变量：
 * - PORT: 服务器端口（默认 3001）
 * - REDIS_URL: Redis 连接字符串
 * - DATABASE_URL: PostgreSQL 连接字符串
 * - WS_CORS_ORIGIN: WebSocket CORS 允许的源
 */

import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import { WebSocketGateway } from '../lib/game-engine/WebSocketGateway';
import { getRedisClient } from '../lib/redis';

// 配置
const PORT = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.WS_CORS_ORIGIN || 'http://localhost:3000';

// 全局实例
let prisma: PrismaClient;
let gateway: WebSocketGateway;

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     Neon Peak Crash - Game Server          ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');

  // 1. 初始化 Prisma
  console.log('[Init] Connecting to database...');
  prisma = new PrismaClient({
    log: ['warn', 'error'],
  });
  await prisma.$connect();
  console.log('[Init] ✓ Database connected');

  // 2. 初始化 Redis
  console.log('[Init] Connecting to Redis...');
  const redis = getRedisClient();
  await redis.ping();
  console.log('[Init] ✓ Redis connected');

  // 3. 创建 HTTP 服务器
  console.log('[Init] Creating HTTP server...');
  const httpServer = createServer((req, res) => {
    // 健康检查端点
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      }));
      return;
    }

    // 统计端点
    if (req.url === '/stats') {
      const stats = gateway.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...stats,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  });

  // 4. 初始化 WebSocket Gateway
  console.log('[Init] Initializing WebSocket Gateway...');
  gateway = new WebSocketGateway(httpServer, redis, prisma, {
    cors: {
      origin: CORS_ORIGIN.split(','),
      credentials: true,
    },
  });

  // 5. 启动服务
  await gateway.start();

  // 6. 启动游戏引擎自动回合
  const gameEngine = gateway.getGameEngine();
  console.log('[Init] Starting game engine auto-round...');
  gameEngine.startAutoRound();

  // 7. 启动 HTTP 服务器
  httpServer.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log(`║  Game Server running on port ${PORT}          ║`);
    console.log('╠════════════════════════════════════════════╣');
    console.log(`║  WebSocket: ws://localhost:${PORT}            ║`);
    console.log(`║  Health:    http://localhost:${PORT}/health   ║`);
    console.log(`║  Stats:     http://localhost:${PORT}/stats    ║`);
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log('[Server] Waiting for connections...');
  });
}

// 优雅关闭
async function shutdown(signal: string) {
  console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

  try {
    // 停止 Gateway（会停止 GameEngine 和 PriceService）
    if (gateway) {
      console.log('[Shutdown] Stopping WebSocket Gateway...');
      await gateway.stop();
    }

    // 断开 Prisma
    if (prisma) {
      console.log('[Shutdown] Disconnecting database...');
      await prisma.$disconnect();
    }

    console.log('[Shutdown] ✓ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Shutdown] Error during shutdown:', error);
    process.exit(1);
  }
}

// 注册信号处理
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// 启动
main().catch((error) => {
  console.error('[Fatal] Failed to start server:', error);
  process.exit(1);
});
