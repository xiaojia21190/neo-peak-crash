import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prismaMock } from '../../../helpers/prismaMock';

describe('User Balance Route', () => {
  const originalPrisma = (globalThis as any).prisma;
  (globalThis as any).prisma = prismaMock as any;

  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  const routeModule = import('../../../../app/api/user/balance/route');

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

  const defaultSnapshot = {
    balance: 100,
    playBalance: 500,
    totalWins: 0,
    totalLosses: 0,
    totalBets: 0,
    totalProfit: 0,
  };

  function buildSession(userId: string) {
    return { user: { id: userId, username: userId, name: null, image: null, trustLevel: 0 } };
  }

  function buildDeps(overrides: Record<string, unknown> = {}) {
    return {
      auth: async () => buildSession('user-1'),
      getOrCreateUser: async () => ({ ...defaultSnapshot }),
      prismaClient: prismaMock,
      setPlayBalance: async () => 10000,
      ...overrides,
    } as any;
  }

  function buildPostRequest(body: any, origin: string) {
    return {
      json: async () => body,
      headers: new Headers({ origin }),
    } as any;
  }

  test('GET rejects unauthenticated user', async () => {
    const { handleGetBalance } = await routeModule;
    const response = await handleGetBalance({} as any, buildDeps({ auth: async () => null }));

    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.error, '未登录');
  });

  test('GET rejects banned user', async () => {
    prismaMock.seedUser({
      id: 'user-1',
      username: 'user-1',
      active: false,
      silenced: false,
      balance: 100,
      playBalance: 0,
    });

    const { handleGetBalance } = await routeModule;
    const response = await handleGetBalance({} as any, buildDeps());

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '账号已被封禁');
  });

  test('GET returns balances for active user', async () => {
    prismaMock.seedUser({
      id: 'user-1',
      username: 'user-1',
      active: true,
      silenced: false,
      balance: 100,
      playBalance: 0,
    });

    const { handleGetBalance } = await routeModule;
    const response = await handleGetBalance(
      {} as any,
      buildDeps({
        getOrCreateUser: async () => ({ ...defaultSnapshot, balance: 250 }),
      })
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.balance, 250);
    assert.equal(payload.playBalance, defaultSnapshot.playBalance);
  });

  test('GET falls back to generated username when session username is missing', async () => {
    prismaMock.seedUser({
      id: 'user-1',
      username: 'user-1',
      active: true,
      silenced: false,
      balance: 100,
      playBalance: 0,
    });

    let receivedUsername: string | undefined;

    const { handleGetBalance } = await routeModule;
    const response = await handleGetBalance(
      {} as any,
      buildDeps({
        auth: async () => ({ user: { id: 'user-1', name: null, image: null } }),
        getOrCreateUser: async (args: any) => {
          receivedUsername = args.username;
          return { ...defaultSnapshot };
        },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(receivedUsername, 'user_user-1');
  });

  test('GET returns 500 when user service throws', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const { handleGetBalance } = await routeModule;
    const response = await handleGetBalance(
      {} as any,
      buildDeps({
        getOrCreateUser: async () => {
          throw new Error('boom');
        },
      })
    );

    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error, '获取余额失败');
  });

  test('POST rejects cross-origin request', async () => {
    const { handlePostBalance } = await routeModule;
    const response = await handlePostBalance(buildPostRequest({ action: 'reset_play_balance' }, 'http://evil.com'), buildDeps());

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, 'Forbidden: Cross-origin request');
  });

  test('POST rejects missing action', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const { handlePostBalance } = await routeModule;
    const response = await handlePostBalance(buildPostRequest({}, 'http://localhost:3000'), buildDeps());

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, '缺少 action 参数');
  });

  test('POST resets play balance', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const { handlePostBalance } = await routeModule;
    const response = await handlePostBalance(
      buildPostRequest({ action: 'reset_play_balance' }, 'http://localhost:3000'),
      buildDeps({ setPlayBalance: async () => 4321 })
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.playBalance, 4321);
  });

  test('POST rejects update action', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const { handlePostBalance } = await routeModule;
    const response = await handlePostBalance(buildPostRequest({ action: 'update' }, 'http://localhost:3000'), buildDeps());

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '此 API 已禁用。余额变更由服务端游戏引擎处理。');
  });
});
