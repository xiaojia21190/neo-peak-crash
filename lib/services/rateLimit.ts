import type { Redis } from 'ioredis';

export interface SlidingWindowRateLimitOptions {
  redis?: Redis | null;
  key: string;
  windowMs: number;
  maxRequests: number;
  now?: number;
  redisEnabled?: boolean;
}

const inMemoryTimestampsByKey: Map<string, number[]> = new Map();
let memberSeq = 0;
const warned: Set<string> = new Set();

function warnOnce(key: string, message: string, error?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (error) console.warn(message, error);
  else console.warn(message);
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

function inMemoryAllow(key: string, now: number, windowMs: number, maxRequests: number): boolean {
  const minTs = now - windowMs;
  const previous = inMemoryTimestampsByKey.get(key) ?? [];
  const timestamps = previous.filter((t) => t > minTs);

  if (timestamps.length >= maxRequests) {
    if (timestamps.length === 0) inMemoryTimestampsByKey.delete(key);
    else inMemoryTimestampsByKey.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  inMemoryTimestampsByKey.set(key, timestamps);
  return true;
}

export function resetInMemoryRateLimit(): void {
  inMemoryTimestampsByKey.clear();
  warned.clear();
  memberSeq = 0;
}

/**
 * Sliding window rate limit (ZSET) with in-memory fallback.
 *
 * Redis algorithm:
 * - ZREMRANGEBYSCORE key 0 (now-windowMs)
 * - ZADD key now member
 * - ZCARD key
 * - PEXPIRE key (windowMs + 1000)
 */
export async function allowSlidingWindowRequest(
  options: SlidingWindowRateLimitOptions
): Promise<boolean> {
  const {
    redis,
    key,
    windowMs,
    maxRequests,
    now = Date.now(),
    redisEnabled = envBool('RATE_LIMIT_REDIS_ENABLED', true),
  } = options;

  if (!Number.isFinite(windowMs) || windowMs <= 0) return true;
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) return true;

  if (!redisEnabled || !redis) {
    return inMemoryAllow(key, now, windowMs, maxRequests);
  }

  const minScore = now - windowMs;
  const member = `${now}-${++memberSeq}`;

  try {
    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, minScore);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs + 1000);

    const results = await pipeline.exec();
    if (!results) throw new Error('Redis transaction aborted');

    for (const [err] of results) {
      if (err) throw err;
    }

    const zcardResult = results[2]?.[1];
    const count =
      typeof zcardResult === 'number'
        ? zcardResult
        : Number.parseInt(String(zcardResult), 10);

    if (!Number.isFinite(count)) throw new Error('Invalid Redis ZCARD response');

    if (count > maxRequests) {
      try {
        await redis.zrem(key, member);
      } catch {
        // Best-effort cleanup only.
      }
      return false;
    }

    return true;
  } catch (error) {
    warnOnce(
      'rateLimit:redis',
      '[rateLimit] Redis unavailable, falling back to in-memory rate limiting.',
      error
    );
    return inMemoryAllow(key, now, windowMs, maxRequests);
  }
}

export function buildRateLimitKey(userId: string): string {
  const prefix = process.env.RATE_LIMIT_REDIS_PREFIX || 'rate:bet:';
  return `${prefix}${userId}`;
}
