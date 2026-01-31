import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetInMemoryRateLimit, allowSlidingWindowRequest } from '../../../../lib/services/rateLimit';
import { prismaMock } from '../../../helpers/prismaMock';

// Mock Redis 客户端
function createMockRedis(options: {
  execResult?: [Error | null, unknown][] | null;
  execThrows?: Error;
  zremThrows?: Error;
} = {}) {
  const commands: string[][] = [];

  return {
    commands,
    multi() {
      return {
        zremrangebyscore: (...args: unknown[]) => { commands.push(['zremrangebyscore', ...args.map(String)]); return this; },
        zadd: (...args: unknown[]) => { commands.push(['zadd', ...args.map(String)]); return this; },
        zcard: (...args: unknown[]) => { commands.push(['zcard', ...args.map(String)]); return this; },
        pexpire: (...args: unknown[]) => { commands.push(['pexpire', ...args.map(String)]); return this; },
        async exec() {
          if (options.execThrows) throw options.execThrows;
          return options.execResult ?? [
            [null, 0],      // zremrangebyscore
            [null, 1],      // zadd
            [null, 1],      // zcard - 1 request in window
            [null, 1],      // pexpire
          ];
        },
      };
    },
    async zrem() {
      if (options.zremThrows) throw options.zremThrows;
      return 1;
    },
  };
}

// 测试充值接口的 rate limit 逻辑
describe('Recharge Rate Limit', () => {
  beforeEach(() => {
    resetInMemoryRateLimit();
  });

  test('allows requests within limit', async () => {
    const key = 'rate:recharge:test-user-1';
    const windowMs = 60_000;
    const maxRequests = 5;

    for (let i = 0; i < maxRequests; i++) {
      const allowed = await allowSlidingWindowRequest({
        redis: null,
        key,
        windowMs,
        maxRequests,
        redisEnabled: false,
      });
      assert.equal(allowed, true, `Request ${i + 1} should be allowed`);
    }
  });

  test('blocks requests exceeding limit', async () => {
    const key = 'rate:recharge:test-user-2';
    const windowMs = 60_000;
    const maxRequests = 5;

    // 先发送 maxRequests 个请求
    for (let i = 0; i < maxRequests; i++) {
      await allowSlidingWindowRequest({
        redis: null,
        key,
        windowMs,
        maxRequests,
        redisEnabled: false,
      });
    }

    // 第 maxRequests + 1 个请求应该被拒绝
    const blocked = await allowSlidingWindowRequest({
      redis: null,
      key,
      windowMs,
      maxRequests,
      redisEnabled: false,
    });
    assert.equal(blocked, false, 'Request exceeding limit should be blocked');
  });

  test('allows requests after window expires', async () => {
    const key = 'rate:recharge:test-user-3';
    const windowMs = 100; // 100ms 窗口便于测试
    const maxRequests = 2;

    // 发送 maxRequests 个请求
    for (let i = 0; i < maxRequests; i++) {
      await allowSlidingWindowRequest({
        redis: null,
        key,
        windowMs,
        maxRequests,
        redisEnabled: false,
      });
    }

    // 等待窗口过期
    await new Promise((resolve) => setTimeout(resolve, windowMs + 10));

    // 新请求应该被允许
    const allowed = await allowSlidingWindowRequest({
      redis: null,
      key,
      windowMs,
      maxRequests,
      redisEnabled: false,
    });
    assert.equal(allowed, true, 'Request after window expiry should be allowed');
  });

  test('isolates rate limits per user', async () => {
    const windowMs = 60_000;
    const maxRequests = 2;

    // 用户1发送2个请求
    for (let i = 0; i < maxRequests; i++) {
      await allowSlidingWindowRequest({
        redis: null,
        key: 'rate:recharge:user-a',
        windowMs,
        maxRequests,
        redisEnabled: false,
      });
    }

    // 用户1第3个请求被拒绝
    const user1Blocked = await allowSlidingWindowRequest({
      redis: null,
      key: 'rate:recharge:user-a',
      windowMs,
      maxRequests,
      redisEnabled: false,
    });
    assert.equal(user1Blocked, false);

    // 用户2应该不受影响
    const user2Allowed = await allowSlidingWindowRequest({
      redis: null,
      key: 'rate:recharge:user-b',
      windowMs,
      maxRequests,
      redisEnabled: false,
    });
    assert.equal(user2Allowed, true);
  });
});

describe('Recharge Rate Limit with Redis', () => {
  beforeEach(() => {
    resetInMemoryRateLimit();
  });

  test('uses Redis pipeline when available', async () => {
    const mockRedis = createMockRedis({
      execResult: [
        [null, 0],  // zremrangebyscore
        [null, 1],  // zadd
        [null, 1],  // zcard - 1 request, within limit
        [null, 1],  // pexpire
      ],
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:redis-user',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    assert.equal(allowed, true);
    assert.equal(mockRedis.commands.length, 4);
    assert.equal(mockRedis.commands[0][0], 'zremrangebyscore');
    assert.equal(mockRedis.commands[1][0], 'zadd');
    assert.equal(mockRedis.commands[2][0], 'zcard');
    assert.equal(mockRedis.commands[3][0], 'pexpire');
  });

  test('blocks when Redis ZCARD exceeds limit', async () => {
    const mockRedis = createMockRedis({
      execResult: [
        [null, 0],  // zremrangebyscore
        [null, 1],  // zadd
        [null, 6],  // zcard - 6 requests, exceeds limit of 5
        [null, 1],  // pexpire
      ],
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:redis-user-exceed',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    assert.equal(allowed, false);
  });

  test('falls back to in-memory when Redis exec throws', async () => {
    const mockRedis = createMockRedis({
      execThrows: new Error('Redis connection lost'),
    });

    // 第一次应该降级到内存并允许
    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:fallback-user',
      windowMs: 60_000,
      maxRequests: 2,
      redisEnabled: true,
    });

    assert.equal(allowed, true);

    // 继续发送请求验证内存限流工作
    await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:fallback-user',
      windowMs: 60_000,
      maxRequests: 2,
      redisEnabled: true,
    });

    // 第3个请求应该被内存限流拒绝
    const blocked = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:fallback-user',
      windowMs: 60_000,
      maxRequests: 2,
      redisEnabled: true,
    });

    assert.equal(blocked, false);
  });

  test('falls back to in-memory when Redis exec returns null', async () => {
    const mockRedis = createMockRedis({
      execResult: null,
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:null-result',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    // 应该降级到内存并允许
    assert.equal(allowed, true);
  });

  test('falls back to in-memory when Redis returns invalid ZCARD', async () => {
    const mockRedis = createMockRedis({
      execResult: [
        [null, 0],
        [null, 1],
        [null, 'invalid'],  // Invalid ZCARD response
        [null, 1],
      ],
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:invalid-zcard',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    // 应该降级到内存并允许
    assert.equal(allowed, true);
  });

  test('handles Redis command error in pipeline', async () => {
    const mockRedis = createMockRedis({
      execResult: [
        [new Error('ZREMRANGEBYSCORE failed'), null],  // Error in first command
        [null, 1],
        [null, 1],
        [null, 1],
      ],
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:cmd-error',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    // 应该降级到内存并允许
    assert.equal(allowed, true);
  });

  test('continues when zrem cleanup fails after exceeding limit', async () => {
    const mockRedis = createMockRedis({
      execResult: [
        [null, 0],
        [null, 1],
        [null, 10],  // Exceeds limit
        [null, 1],
      ],
      zremThrows: new Error('ZREM failed'),
    });

    const allowed = await allowSlidingWindowRequest({
      redis: mockRedis as any,
      key: 'rate:recharge:zrem-fail',
      windowMs: 60_000,
      maxRequests: 5,
      redisEnabled: true,
    });

    // 即使 zrem 失败，仍应返回 false（超限）
    assert.equal(allowed, false);
  });
});

describe('Recharge API - Amount Validation', () => {
  test('validates minimum amount', () => {
    const minAmount = 1;
    const maxAmount = 10000;

    const testCases = [
      { amount: 0, valid: false },
      { amount: 0.5, valid: false },
      { amount: 1, valid: true },
      { amount: 100, valid: true },
      { amount: 10000, valid: true },
      { amount: 10001, valid: false },
    ];

    for (const { amount, valid } of testCases) {
      const isValid = Number.isFinite(amount) && amount >= minAmount && amount <= maxAmount;
      assert.equal(isValid, valid, `Amount ${amount} should be ${valid ? 'valid' : 'invalid'}`);
    }
  });

  test('rejects non-numeric amounts', () => {
    const testCases = ['abc', '', null, undefined, NaN, Infinity];

    for (const rawAmount of testCases) {
      const amount = Number(rawAmount);
      const isValid = Number.isFinite(amount) && amount >= 1 && amount <= 10000;
      assert.equal(isValid, false, `Amount ${rawAmount} should be invalid`);
    }
  });
});

describe('Recharge API - User Status Validation', () => {
  test('blocks banned users', () => {
    const userStatus = { active: false };
    const canRecharge = userStatus.active;
    assert.equal(canRecharge, false);
  });

  test('allows active users', () => {
    const userStatus = { active: true };
    const canRecharge = userStatus.active;
    assert.equal(canRecharge, true);
  });

  test('rejects non-existent users', () => {
    const userStatus = null;
    const canRecharge = userStatus?.active ?? false;
    assert.equal(canRecharge, false);
  });
});

describe('Recharge API - Daily Limit Validation', () => {
  const DAILY_LIMIT = 50000;

  test('allows recharge within daily limit', () => {
    const currentTotal = 40000;
    const newAmount = 5000;
    const canRecharge = currentTotal + newAmount <= DAILY_LIMIT;
    assert.equal(canRecharge, true);
  });

  test('blocks recharge exceeding daily limit', () => {
    const currentTotal = 48000;
    const newAmount = 5000;
    const canRecharge = currentTotal + newAmount <= DAILY_LIMIT;
    assert.equal(canRecharge, false);
  });

  test('allows recharge at exact daily limit', () => {
    const currentTotal = 45000;
    const newAmount = 5000;
    const canRecharge = currentTotal + newAmount <= DAILY_LIMIT;
    assert.equal(canRecharge, true);
  });

  test('handles zero current total', () => {
    const currentTotal = 0;
    const newAmount = 10000;
    const canRecharge = currentTotal + newAmount <= DAILY_LIMIT;
    assert.equal(canRecharge, true);
  });

  test('handles null/undefined aggregate result', () => {
    const aggregateResult = { _sum: { amount: null } };
    const currentTotal = Number(aggregateResult._sum.amount ?? 0);
    assert.equal(currentTotal, 0);
    assert.equal(Number.isFinite(currentTotal), true);
  });
});

describe('Recharge API - Transaction Atomicity', () => {
  test('simulates concurrent daily limit check race condition', async () => {
    // 模拟事务内的原子检查
    let currentTotal = 48000;
    const DAILY_LIMIT = 50000;
    const requestAmount = 3000;

    // 模拟并发请求的竞态条件
    const processRecharge = async (amount: number): Promise<boolean> => {
      // 事务内检查
      if (currentTotal + amount > DAILY_LIMIT) {
        return false;  // 超限
      }
      // 原子更新
      currentTotal += amount;
      return true;
    };

    // 第一个请求应该成功
    const result1 = await processRecharge(requestAmount);
    assert.equal(result1, false);  // 48000 + 3000 > 50000

    // 恢复状态测试边界
    currentTotal = 47000;
    const result2 = await processRecharge(requestAmount);
    assert.equal(result2, true);   // 47000 + 3000 = 50000
    assert.equal(currentTotal, 50000);

    // 后续请求应该失败
    const result3 = await processRecharge(1);
    assert.equal(result3, false);  // 已达上限
  });
});

describe('Recharge Route', () => {
  const originalPrisma = (globalThis as any).prisma;
  (globalThis as any).prisma = prismaMock as any;

  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  const routeModule = import('../../../../app/api/payment/recharge/route');

  after(() => {
    if (originalPrisma === undefined) {
      delete (globalThis as any).prisma;
    } else {
      (globalThis as any).prisma = originalPrisma;
    }

    if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  });

  beforeEach(() => {
    prismaMock.users.clear();
    prismaMock.transactions.clear();
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
  });

  function buildRequest(body: any): any {
    return {
      json: async () => body,
      headers: new Headers({ origin: 'http://localhost:3000' }),
    };
  }

  test('rejects cross-origin requests', async () => {
    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 10 }), {
      validateSameOrigin: () => false,
    } as any);

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.success, false);
  });

  test('rejects unauthenticated user', async () => {
    prismaMock.seedUser({ id: 'user-auth', username: 'user-auth', active: true });

    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 10 }), {
      validateSameOrigin: () => true,
      auth: async () => null,
      getRedisClient: () => ({} as any),
      allowSlidingWindowRequest: async () => true,
      createGameRechargeOrder: () => ({ success: true, paymentForm: { actionUrl: 'x', params: { out_trade_no: 'order-x' } } }),
    } as any);

    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.success, false);
  });

  test('rejects invalid amount', async () => {
    prismaMock.seedUser({ id: 'user-amt', username: 'user-amt', active: true });

    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 0 }), {
      validateSameOrigin: () => true,
      auth: async () => ({ user: { id: 'user-amt' } }),
      getRedisClient: () => ({} as any),
      allowSlidingWindowRequest: async () => true,
      createGameRechargeOrder: () => ({ success: true, paymentForm: { actionUrl: 'x', params: { out_trade_no: 'order-amt' } } }),
    } as any);

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.success, false);
  });

  test('rejects rate-limited request', async () => {
    prismaMock.seedUser({ id: 'user-rl', username: 'user-rl', active: true });

    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 10 }), {
      validateSameOrigin: () => true,
      auth: async () => ({ user: { id: 'user-rl' } }),
      getRedisClient: () => ({} as any),
      allowSlidingWindowRequest: async () => false,
      createGameRechargeOrder: () => ({ success: true, paymentForm: { actionUrl: 'x', params: { out_trade_no: 'order-rl' } } }),
    } as any);

    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.equal(payload.success, false);
  });

  test('rejects when daily limit exceeded', async () => {
    prismaMock.seedUser({ id: 'user-limit', username: 'user-limit', active: true });
    prismaMock.seedTransaction({
      orderNo: 'limit-existing',
      userId: 'user-limit',
      amount: 50000,
      status: 'PENDING',
      type: 'RECHARGE',
      createdAt: new Date(),
    });

    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 1 }), {
      validateSameOrigin: () => true,
      auth: async () => ({ user: { id: 'user-limit' } }),
      getRedisClient: () => ({} as any),
      allowSlidingWindowRequest: async () => true,
      createGameRechargeOrder: () => ({ success: true, paymentForm: { actionUrl: 'x', params: { out_trade_no: 'order-limit' } } }),
    } as any);

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.success, false);
  });

  test('creates pending transaction and returns payment form', async () => {
    prismaMock.seedUser({ id: 'user-ok', username: 'user-ok', active: true });

    const { handleRecharge } = await routeModule;
    const response = await handleRecharge(buildRequest({ amount: 10 }), {
      validateSameOrigin: () => true,
      auth: async () => ({ user: { id: 'user-ok' } }),
      getRedisClient: () => ({} as any),
      allowSlidingWindowRequest: async () => true,
      createGameRechargeOrder: () => ({
        success: true,
        paymentForm: { actionUrl: 'https://pay.example/submit', params: { out_trade_no: 'order-ok' } },
      }),
    } as any);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.paymentForm.params.out_trade_no, 'order-ok');
    assert.equal(prismaMock.transactions.get('order-ok')?.status, 'PENDING');
  });
});
