import test from 'node:test';
import assert from 'node:assert/strict';
import { allowSlidingWindowRequest, buildRateLimitKey, resetInMemoryRateLimit } from '../../../lib/services/rateLimit';

class FakeRedis {
  count = 0;
  failExec = false;

  multi() {
    const self = this;
    return {
      zremrangebyscore() {
        return this;
      },
      zadd() {
        self.count += 1;
        return this;
      },
      zcard() {
        return this;
      },
      pexpire() {
        return this;
      },
      exec: async () => {
        if (self.failExec) throw new Error('exec failed');
        return [
          [null, 1],
          [null, 1],
          [null, self.count],
          [null, 1],
        ];
      },
    };
  }

  async zrem() {
    if (this.count > 0) this.count -= 1;
  }
}

test('allowSlidingWindowRequest bypasses when limits are disabled', async () => {
  const okWindow = await allowSlidingWindowRequest({
    redis: null,
    key: 'rate:1',
    windowMs: 0,
    maxRequests: 1,
    redisEnabled: false,
  });
  const okMax = await allowSlidingWindowRequest({
    redis: null,
    key: 'rate:2',
    windowMs: 1000,
    maxRequests: 0,
    redisEnabled: false,
  });

  assert.equal(okWindow, true);
  assert.equal(okMax, true);
});

test('allowSlidingWindowRequest enforces in-memory limits', async () => {
  resetInMemoryRateLimit();

  const ok1 = await allowSlidingWindowRequest({
    redis: null,
    key: 'rate:mem',
    windowMs: 1000,
    maxRequests: 1,
    now: 100,
    redisEnabled: false,
  });
  const ok2 = await allowSlidingWindowRequest({
    redis: null,
    key: 'rate:mem',
    windowMs: 1000,
    maxRequests: 1,
    now: 200,
    redisEnabled: false,
  });

  assert.equal(ok1, true);
  assert.equal(ok2, false);
});

test('allowSlidingWindowRequest uses redis when available', async () => {
  const redis = new FakeRedis();

  const first = await allowSlidingWindowRequest({
    redis: redis as any,
    key: 'rate:redis',
    windowMs: 1000,
    maxRequests: 1,
    redisEnabled: true,
  });

  const second = await allowSlidingWindowRequest({
    redis: redis as any,
    key: 'rate:redis',
    windowMs: 1000,
    maxRequests: 1,
    redisEnabled: true,
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(redis.count, 1);
});

test('allowSlidingWindowRequest falls back on redis errors', async () => {
  resetInMemoryRateLimit();
  const redis = new FakeRedis();
  redis.failExec = true;

  const ok = await allowSlidingWindowRequest({
    redis: redis as any,
    key: 'rate:fail',
    windowMs: 1000,
    maxRequests: 1,
    now: 0,
    redisEnabled: true,
  });

  assert.equal(ok, true);
});

test('buildRateLimitKey respects prefix', () => {
  const original = process.env.RATE_LIMIT_REDIS_PREFIX;
  process.env.RATE_LIMIT_REDIS_PREFIX = 'test:';

  assert.equal(buildRateLimitKey('user-1'), 'test:user-1');

  if (original === undefined) delete process.env.RATE_LIMIT_REDIS_PREFIX;
  else process.env.RATE_LIMIT_REDIS_PREFIX = original;
});
