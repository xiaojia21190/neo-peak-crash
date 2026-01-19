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

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { WebSocketGateway } from '../lib/game-engine/WebSocketGateway';
import { getRedisClient, closeRedisClient } from '../lib/redis';

// 配置
const PORT = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.WS_CORS_ORIGIN || 'http://localhost:3000';

// 全局实例
let prisma: PrismaClient | null = null;
let pool: Pool | null = null;
let gateway: WebSocketGateway | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;

let shutdownPromise: Promise<void> | null = null;

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     Neon Peak Crash - Game Server          ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');

  // 1. 初始化 Prisma
  console.log('[Init] Connecting to database...');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 环境变量未设置');
  }
  const poolInstance = new Pool({ connectionString });
  pool = poolInstance;
  const adapter = new PrismaPg(poolInstance);
  const prismaInstance = new PrismaClient({
    adapter,
    log: ['warn', 'error'],
  });
  prisma = prismaInstance;
  await prismaInstance.$connect();
  console.log('[Init] ✓ Database connected');

  // 2. 初始化 Redis
  console.log('[Init] Connecting to Redis...');
  const redis = getRedisClient();
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis ping timeout')), 5000))
    ]);
    console.log('[Init] ✓ Redis connected');
  } catch (error) {
    await prismaInstance.$disconnect().catch(() => undefined);
    await poolInstance.end().catch(() => undefined);
    prisma = null;
    pool = null;
    throw error;
  }

  // 3. 创建 HTTP 服务器
  console.log('[Init] Creating HTTP server...');
  httpServer = createServer((req, res) => {
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
      const adminToken = process.env.ADMIN_TOKEN;
      const authHeaderValue = (req.headers as any).authorization as string | string[] | undefined;
      const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;

      if (!adminToken) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ADMIN_TOKEN is not configured' }));
        return;
      }

      const providedToken = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : authHeader?.trim();

      if (!providedToken || providedToken !== adminToken) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const stats = gateway?.getStats();
      if (!stats) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway not ready' }));
        return;
      }
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

  // 6. 等待价格服务就绪（最多 30 秒）
  const priceService = gateway.getPriceService();
  console.log('[Init] Waiting for price service...');
  const timeout = 30000;
  const startTime = Date.now();

  await new Promise<void>((resolve) => {
    if (priceService.isPriceAvailable()) {
      console.log('[Init] ✓ Price service ready');
      resolve();
    } else {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const checkReady = () => {
        if (priceService.isPriceAvailable()) {
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
          priceService.off('price', checkReady);
          console.log('[Init] ✓ Price service ready');
          resolve();
        } else if (Date.now() - startTime > timeout) {
          console.warn('[Init] Price service timeout, continuing anyway...');
          if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
          priceService.off('price', checkReady);
          resolve();
        }
      };
      priceService.on('price', checkReady);

      // 超时保护
      timeoutTimer = setTimeout(() => {
        priceService.off('price', checkReady);
        console.warn('[Init] Price service timeout, continuing anyway...');
        resolve();
      }, timeout);
    }
  });

  // 7. 处理启动时的孤儿回合
  console.log('[Init] Checking for orphaned rounds...');
  const orphanedRounds = await prisma.round.findMany({
    where: {
      status: {
        in: ['BETTING', 'RUNNING'],
      },
    },
    select: { id: true, status: true, startedAt: true },
  });

  if (orphanedRounds.length > 0) {
    console.log(`[Init] Found ${orphanedRounds.length} orphaned rounds, cancelling and refunding...`);
    for (const round of orphanedRounds) {
      try {
        // 1. 取消回合
        await prisma.round.update({
          where: { id: round.id },
          data: {
            status: 'CANCELLED',
            endedAt: new Date(),
          },
        });

        // 2. 查找该回合的所有 PENDING 投注
        const pendingBets = await prisma.bet.findMany({
          where: {
            roundId: round.id,
            status: 'PENDING',
          },
          select: {
            id: true,
            userId: true,
            amount: true,
            isPlayMode: true,
          },
        });

        // 3. 退款
        if (pendingBets.length > 0) {
          console.log(`[Init] Refunding ${pendingBets.length} pending bets for round ${round.id}`);

          for (const bet of pendingBets) {
            await prisma.$transaction(async (tx) => {
              // 幂等性检查：使用 updateMany 确保只更新 PENDING 状态的投注
              const updated = await tx.bet.updateMany({
                where: {
                  id: bet.id,
                  status: 'PENDING',
                },
                data: {
                  status: 'REFUNDED',
                  settledAt: new Date(),
                },
              });

              // 只有成功更新1条记录才执行退款
              if (updated.count === 1) {
                const balanceField = bet.isPlayMode ? 'playBalance' : 'balance';

                // 获取当前余额（用于流水记录）
                const user = await tx.user.findUnique({
                  where: { id: bet.userId },
                  select: { balance: true, playBalance: true },
                });

                if (!user) {
                  console.error(`[Init] User ${bet.userId} not found, skipping refund`);
                  return;
                }

                const currentBalance = Number(balanceField === 'balance' ? user.balance : user.playBalance);

                // 返还余额
                await tx.user.update({
                  where: { id: bet.userId },
                  data: {
                    [balanceField]: {
                      increment: bet.amount,
                    },
                  },
                });

                // 记录流水（仅真实余额）
                if (!bet.isPlayMode) {
                  await tx.transaction.create({
                    data: {
                      userId: bet.userId,
                      type: 'REFUND',
                      amount: Number(bet.amount),
                      balanceBefore: currentBalance,
                      balanceAfter: currentBalance + Number(bet.amount),
                      relatedBetId: bet.id,
                      remark: `退款投注 ${bet.id}（回合 ${round.id} 已取消）`,
                      status: 'COMPLETED',
                      completedAt: new Date(),
                    },
                  });
                }
              } else {
                console.log(`[Init] Bet ${bet.id} already refunded, skipping`);
              }
            });
          }

          console.log(`[Init] ✓ Refunded ${pendingBets.length} bets for round ${round.id}`);
        }

        console.log(`[Init] ✓ Cancelled orphaned round ${round.id} (status: ${round.status})`);
      } catch (error) {
        console.error(`[Init] Failed to cancel orphaned round ${round.id}:`, error);
      }
    }
  } else {
    console.log('[Init] No orphaned rounds found');
  }

  // 8. 启动游戏引擎自动回合
  const gameEngine = gateway.getGameEngine();
  console.log('[Init] Starting game engine auto-round...');

  // 检查是否有其他实例持有锁
  const lockKey = 'game:round:BTCUSDT:lock';
  const lockExists = await redis.exists(lockKey);
  if (lockExists) {
    const ttl = await redis.pttl(lockKey);
    console.warn('[Init] ⚠️  Detected existing round lock');

    if (ttl > 60000) {
      console.warn(`[Init] Lock TTL: ${Math.round(ttl/1000)}s - Force clearing stale lock`);
      await redis.del(lockKey);
    } else if (ttl > 0) {
      console.warn(`[Init] Lock TTL: ${Math.round(ttl/1000)}s - Waiting for expiration...`);
      await new Promise(resolve => setTimeout(resolve, ttl + 1000));
    } else {
      console.warn('[Init] Lock has no TTL - Force clearing');
      await redis.del(lockKey);
    }
  }

  gameEngine.startAutoRound();

  // 9. 启动 HTTP 服务器
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
  }).on('error', (error) => {
    console.error('[Server] Failed to start HTTP server:', error);
    void shutdown('server_error');
  });
}

// 优雅关闭
async function shutdown(signal: string) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

    try {
      // 停止 Gateway（会停止 GameEngine 和 PriceService）
      if (gateway) {
        console.log('[Shutdown] Stopping WebSocket Gateway...');
        await gateway.stop();
        gateway = null;
      }

      // 关闭 HTTP 服务器
      if (httpServer) {
        console.log('[Shutdown] Closing HTTP server...');
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(err);
            } else {
              resolve();
            }
          });
        });
        console.log('[Shutdown] ✓ HTTP server closed');
        httpServer = null;
      }

      // 断开 Prisma
      if (prisma) {
        console.log('[Shutdown] Disconnecting database...');
        await prisma.$disconnect();
        prisma = null;
      }

      // 关闭数据库连接池
      if (pool) {
        console.log('[Shutdown] Closing database connection pool...');
        await pool.end();
        console.log('[Shutdown] ✓ Database pool closed');
        pool = null;
      }

      // 断开 Redis
      console.log('[Shutdown] Disconnecting Redis...');
      await closeRedisClient();

      console.log('[Shutdown] ✓ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[Shutdown] Error during shutdown:', error);
      process.exit(1);
    }
  })();

  return shutdownPromise;
}

// 注册信号处理
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught exception:', error);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled rejection at:', promise, 'reason:', reason);
  void shutdown('unhandledRejection');
});

// 启动
main().catch((error) => {
  console.error('[Fatal] Failed to start server:', error);
  process.exit(1);
});
