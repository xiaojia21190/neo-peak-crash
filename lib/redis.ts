/**
 * Redis 客户端配置
 */

import Redis from 'ioredis';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 10) {
          console.error('[Redis] Max retries reached, giving up');
          return null;
        }
        const delay = Math.min(times * 100, 3000);
        console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      },
      reconnectOnError(err: Error) {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected');
    });

    redisClient.on('error', (err: Error) => {
      console.error('[Redis] Error:', err.message);
    });

    redisClient.on('close', () => {
      console.warn('[Redis] Connection closed');
    });
  }

  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// 用于 Pub/Sub 的独立客户端
let redisPubClient: Redis | null = null;
let redisSubClient: Redis | null = null;

export function getRedisPubClient(): Redis {
  if (!redisPubClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisPubClient = new Redis(redisUrl);
  }
  return redisPubClient;
}

export function getRedisSubClient(): Redis {
  if (!redisSubClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisSubClient = new Redis(redisUrl);
  }
  return redisSubClient;
}
