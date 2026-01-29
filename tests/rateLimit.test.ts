import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowSlidingWindowRequest,
  buildRateLimitKey,
  resetInMemoryRateLimit,
} from '../lib/services/rateLimit';

type ZSet = Map<string, number>;

class FakeRedisPipeline {
  private ops: Array<() => unknown> = [];

  constructor(private redis: FakeRedis) {}

  zremrangebyscore(key: string, min: number, max: number): this {
    this.ops.push(() => this.redis._zremrangebyscore(key, min, max));
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.ops.push(() => this.redis._zadd(key, score, member));
    return this;
  }

  zcard(key: string): this {
    this.ops.push(() => this.redis._zcard(key));
    return this;
  }

  pexpire(key: string, ms: number): this {
    this.ops.push(() => this.redis._pexpire(key, ms));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const results: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      try {
        results.push([null, op()]);
      } catch (err) {
        results.push([err as Error, null]);
      }
    }
    return results;
  }
}

class FakeRedis {
  private zsets: Map<string, ZSet> = new Map();

  multi(): FakeRedisPipeline {
    return new FakeRedisPipeline(this);
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    const existed = zset.delete(member);
    if (zset.size === 0) this.zsets.delete(key);
    return existed ? 1 : 0;
  }

  zcardSync(key: string): number {
    return this._zcard(key);
  }

  _zremrangebyscore(key: string, min: number, max: number): number {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const [member, score] of zset.entries()) {
      if (score >= min && score <= max) {
        zset.delete(member);
        removed++;
      }
    }
    if (zset.size === 0) this.zsets.delete(key);
    return removed;
  }

  _zadd(key: string, score: number, member: string): number {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    const existed = zset.has(member);
    zset.set(member, score);
    return existed ? 0 : 1;
  }

  _zcard(key: string): number {
    return this.zsets.get(key)?.size ?? 0;
  }

  _pexpire(_key: string, _ms: number): number {
    return 1;
  }
}

beforeEach(() => {
  resetInMemoryRateLimit();
});

test('redis: allows up to maxRequests per window and cleans rejected member', async () => {
  const redis = new FakeRedis();
  const key = 'rate:bet:user-1';

  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 1000 }),
    true
  );
  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 1001 }),
    true
  );
  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 1002 }),
    false
  );

  assert.equal(redis.zcardSync(key), 2);
});

test('redis: sliding window expires old entries', async () => {
  const redis = new FakeRedis();
  const key = 'rate:bet:user-2';

  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 1000 }),
    true
  );
  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 1500 }),
    true
  );

  // now=2501 => minScore=1501, both 1000 and 1500 are removed before counting
  assert.equal(
    await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 2, now: 2501 }),
    true
  );
});

test('fallback: uses in-memory when redis is missing', async () => {
  const key = 'rate:bet:user-3';

  assert.equal(await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 2, now: 1000 }), true);
  assert.equal(await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 2, now: 1001 }), true);
  assert.equal(await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 2, now: 1002 }), false);
});

test('fallback: in-memory window expires after TTL', async () => {
  const key = 'rate:mem:ttl';

  assert.equal(
    await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 1, now: 0, redisEnabled: false }),
    true
  );
  assert.equal(
    await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 1, now: 999, redisEnabled: false }),
    false
  );
  // Boundary: now=1000 => minTs=0, request at ts=0 expires.
  assert.equal(
    await allowSlidingWindowRequest({ key, windowMs: 1000, maxRequests: 1, now: 1000, redisEnabled: false }),
    true
  );
});

test('fallback: uses in-memory when redis throws', async () => {
  const key = 'rate:bet:user-4';
  const redis = {
    multi() {
      return {
        zremrangebyscore() { return this; },
        zadd() { return this; },
        zcard() { return this; },
        pexpire() { return this; },
        async exec() { throw new Error('redis down'); },
      };
    },
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 1, now: 1000 }),
      true
    );
    assert.equal(
      await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 1, now: 1001 }),
      false
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('redis: transaction aborted falls back to in-memory', async () => {
  const key = 'rate:bet:user-6';
  const redis = {
    multi() {
      return {
        zremrangebyscore() { return this; },
        zadd() { return this; },
        zcard() { return this; },
        pexpire() { return this; },
        async exec() { return null; },
      };
    },
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 1, now: 1000 }),
      true
    );
    assert.equal(
      await allowSlidingWindowRequest({ redis: redis as any, key, windowMs: 1000, maxRequests: 1, now: 1001 }),
      false
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('redis: ignore cleanup failure when rejecting', async () => {
  const redis = new FakeRedis() as any;
  redis.zrem = async () => {
    throw new Error('cleanup down');
  };

  const key = 'rate:bet:user-7';
  assert.equal(await allowSlidingWindowRequest({ redis, key, windowMs: 1000, maxRequests: 1, now: 1000 }), true);
  assert.equal(await allowSlidingWindowRequest({ redis, key, windowMs: 1000, maxRequests: 1, now: 1001 }), false);
  assert.equal(redis.zcardSync(key), 2);
});

test('options: redisEnabled=false forces in-memory (no redis calls)', async () => {
  const key = 'rate:bet:user-5';
  const redis = { multi: () => { throw new Error('should not be called'); } };

  assert.equal(
    await allowSlidingWindowRequest({
      redis: redis as any,
      redisEnabled: false,
      key,
      windowMs: 1000,
      maxRequests: 1,
      now: 1000,
    }),
    true
  );
  assert.equal(
    await allowSlidingWindowRequest({
      redis: redis as any,
      redisEnabled: false,
      key,
      windowMs: 1000,
      maxRequests: 1,
      now: 1001,
    }),
    false
  );
});

test('buildRateLimitKey: uses env prefix', () => {
  const prev = process.env.RATE_LIMIT_REDIS_PREFIX;
  process.env.RATE_LIMIT_REDIS_PREFIX = 'test:';
  try {
    assert.equal(buildRateLimitKey('u1'), 'test:u1');
  } finally {
    if (prev == null) delete process.env.RATE_LIMIT_REDIS_PREFIX;
    else process.env.RATE_LIMIT_REDIS_PREFIX = prev;
  }
});

test('options: windowMs<=0 or maxRequests<=0 disables limiting', async () => {
  assert.equal(await allowSlidingWindowRequest({ key: 'k1', windowMs: 0, maxRequests: 1, now: 1 }), true);
  assert.equal(await allowSlidingWindowRequest({ key: 'k2', windowMs: 1000, maxRequests: 0, now: 1 }), true);
});

test('fallback: in-memory evicts oldest keys when exceeding max key count', async () => {
  const windowMs = 1_000_000;
  const maxRequests = 1;

  for (let i = 0; i <= 10_000; i += 1) {
    assert.equal(
      await allowSlidingWindowRequest({
        key: `rate:mem:evict:${i}`,
        windowMs,
        maxRequests,
        now: i,
        redisEnabled: false,
      }),
      true
    );
  }

  assert.equal(
    await allowSlidingWindowRequest({
      key: 'rate:mem:evict:1',
      windowMs,
      maxRequests,
      now: 10_001,
      redisEnabled: false,
    }),
    false
  );

  assert.equal(
    await allowSlidingWindowRequest({
      key: 'rate:mem:evict:0',
      windowMs,
      maxRequests,
      now: 10_001,
      redisEnabled: false,
    }),
    true
  );
});

test('fallback: starts periodic cleanup timer and unrefs it', async () => {
  const originalSetInterval = globalThis.setInterval;

  let unrefCalled = false;
  let createdMs: number | undefined;
  let intervalFn: (() => void) | null = null;
  let intervalCalls = 0;

  globalThis.setInterval = (((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    intervalCalls += 1;
    createdMs = ms;
    intervalFn = () => fn(...args);

    const handle = originalSetInterval(fn, ms, ...args) as unknown as { unref?: () => void };
    if (handle && typeof handle.unref === 'function') {
      const originalUnref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefCalled = true;
        originalUnref();
      };
    } else {
      unrefCalled = true;
    }

    return handle as any;
  }) as unknown) as typeof setInterval;

  try {
    assert.equal(
      await allowSlidingWindowRequest({
        key: 'rate:mem:timer',
        windowMs: 1000,
        maxRequests: 1,
        now: 0,
        redisEnabled: false,
      }),
      true
    );

    // Second call should not create a second timer.
    await allowSlidingWindowRequest({
      key: 'rate:mem:timer',
      windowMs: 1000,
      maxRequests: 1,
      now: 1,
      redisEnabled: false,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
  }

  assert.equal(createdMs, 60000);
  assert.equal(unrefCalled, true);
  assert.equal(intervalCalls, 1);
  intervalFn?.();
  resetInMemoryRateLimit();

  // Ensure cleanup handles empty store (no throw).
  intervalFn?.();
});
