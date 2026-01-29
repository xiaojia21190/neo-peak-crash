import type { Redis } from 'ioredis';

export interface SlidingWindowRateLimitOptions {
  redis?: Redis | null;
  key: string;
  windowMs: number;
  maxRequests: number;
  now?: number;
  redisEnabled?: boolean;
}

const MAX_IN_MEMORY_KEYS = 10000;
const CLEANUP_INTERVAL_MS = 60000;
const CLEANUP_BATCH_SIZE = 1000;
const LAZY_CLEANUP_EVERY_CALLS = 200;

interface InMemoryEntry {
  timestamps: number[];
  lastAccess: number;
  windowMs: number;
}

const inMemoryStore: Map<string, InMemoryEntry> = new Map();
let memberSeq = 0;
const warned: Set<string> = new Set();
let cleanupTimer: NodeJS.Timeout | null = null;
let cleanupCursor = 0;
let lazyCleanupCalls = 0;
let lastLazyCleanupAt = 0;

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

function pruneTimestampsInPlace(timestamps: number[], minTs: number): void {
  if (timestamps.length === 0) return;

  let write = 0;
  for (let read = 0; read < timestamps.length; read += 1) {
    const ts = timestamps[read];
    if (ts > minTs) {
      timestamps[write] = ts;
      write += 1;
    }
  }

  timestamps.length = write;
}

function cleanupExpiredEntries(now: number, maxKeysToProcess: number): void {
  if (inMemoryStore.size === 0) {
    cleanupCursor = 0;
    return;
  }

  const keys = Array.from(inMemoryStore.keys());
  if (keys.length === 0) {
    cleanupCursor = 0;
    return;
  }

  cleanupCursor %= keys.length;
  const limit = Math.min(maxKeysToProcess, keys.length);

  for (let i = 0; i < limit; i += 1) {
    const key = keys[(cleanupCursor + i) % keys.length];
    if (!key) continue;

    const entry = inMemoryStore.get(key);
    if (!entry) continue;

    const minTs = now - entry.windowMs;
    pruneTimestampsInPlace(entry.timestamps, minTs);

    if (entry.timestamps.length === 0) inMemoryStore.delete(key);
  }

  cleanupCursor = (cleanupCursor + limit) % keys.length;
}

function evictOldestIfNeeded(): void {
  const overflow = inMemoryStore.size - MAX_IN_MEMORY_KEYS;
  if (overflow <= 0) return;

  if (overflow === 1) {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of inMemoryStore.entries()) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) inMemoryStore.delete(oldestKey);
    return;
  }

  const entries: Array<{ key: string; lastAccess: number }> = [];
  for (const [key, entry] of inMemoryStore.entries()) {
    entries.push({ key, lastAccess: entry.lastAccess });
  }
  entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (let i = 0; i < overflow && i < entries.length; i += 1) {
    inMemoryStore.delete(entries[i].key);
  }
}

function startPeriodicCleanup(): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    cleanupExpiredEntries(Date.now(), CLEANUP_BATCH_SIZE);
    evictOldestIfNeeded();
  }, CLEANUP_INTERVAL_MS);

  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function lazyCleanup(now: number): void {
  startPeriodicCleanup();

  lazyCleanupCalls += 1;
  const dueByCalls = lazyCleanupCalls >= LAZY_CLEANUP_EVERY_CALLS;
  const dueByTime = now - lastLazyCleanupAt >= CLEANUP_INTERVAL_MS;
  const dueBySize = inMemoryStore.size > MAX_IN_MEMORY_KEYS;

  if (!dueByCalls && !dueByTime && !dueBySize) return;

  lazyCleanupCalls = 0;
  lastLazyCleanupAt = now;

  cleanupExpiredEntries(now, CLEANUP_BATCH_SIZE);
  evictOldestIfNeeded();
}

function inMemoryAllow(key: string, now: number, windowMs: number, maxRequests: number): boolean {
  lazyCleanup(now);

  const minTs = now - windowMs;
  const entry = inMemoryStore.get(key);
  const timestamps = entry?.timestamps ?? [];
  pruneTimestampsInPlace(timestamps, minTs);
  const storedWindowMs = entry ? Math.max(entry.windowMs, windowMs) : windowMs;

  if (timestamps.length >= maxRequests) {
    if (timestamps.length === 0) {
      inMemoryStore.delete(key);
    } else {
      inMemoryStore.set(key, { timestamps, lastAccess: now, windowMs: storedWindowMs });
    }
    return false;
  }

  timestamps.push(now);
  inMemoryStore.set(key, { timestamps, lastAccess: now, windowMs: storedWindowMs });
  evictOldestIfNeeded();
  return true;
}

export function resetInMemoryRateLimit(): void {
  inMemoryStore.clear();
  warned.clear();
  memberSeq = 0;
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  cleanupCursor = 0;
  lazyCleanupCalls = 0;
  lastLazyCleanupAt = 0;
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
