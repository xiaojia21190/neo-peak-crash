import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prismaMock } from '../../../helpers/prismaMock';

describe('User Bets Route', () => {
  const originalPrisma = (globalThis as any).prisma;
  (globalThis as any).prisma = prismaMock as any;

  const routeModule = import('../../../../app/api/user/bets/route');

  after(() => {
    if (originalPrisma === undefined) {
      delete (globalThis as any).prisma;
    } else {
      (globalThis as any).prisma = originalPrisma;
    }
  });

  beforeEach(() => {
    prismaMock.users.clear();
    prismaMock.bets.clear();
  });

  function buildSession(userId: string) {
    return { user: { id: userId, username: userId, name: null, image: null, trustLevel: 0 } };
  }

  function buildDeps(overrides: Record<string, unknown> = {}) {
    return {
      auth: async () => buildSession('user-1'),
      getUserBetHistory: async () => [],
      prismaClient: prismaMock,
      ...overrides,
    } as any;
  }

  test('handleGetBets rejects unauthenticated user', async () => {
    const { handleGetBets } = await routeModule;
    const response = await handleGetBets({} as any, buildDeps({ auth: async () => null }));

    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.error, '未登录');
  });

  test('handleGetBets rejects banned user', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: false, silenced: false });

    const { handleGetBets } = await routeModule;
    const response = await handleGetBets({} as any, buildDeps());

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '账号已被封禁');
  });

  test('handleGetBets rejects silenced user', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: true });

    const { handleGetBets } = await routeModule;
    const response = await handleGetBets({} as any, buildDeps());

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '账号已被禁言');
  });

  test('handleGetBets returns 404 for missing user', async () => {
    const { handleGetBets } = await routeModule;
    const response = await handleGetBets(
      {} as any,
      buildDeps({
        auth: async () => buildSession('user-missing'),
      })
    );

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error, '用户不存在');
  });

  test('handleGetBets returns bet history for active user', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const history = [
      { id: 'bet-1', amount: 10, multiplier: 2 },
      { id: 'bet-2', amount: 25, multiplier: 3.5 },
    ];

    const { handleGetBets } = await routeModule;
    const response = await handleGetBets(
      {} as any,
      buildDeps({
        getUserBetHistory: async () => history,
      })
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.bets, history);
  });

  test('handleGetBets returns 500 when bet history service throws', async () => {
    prismaMock.seedUser({ id: 'user-1', username: 'user-1', active: true, silenced: false });

    const { handleGetBets } = await routeModule;
    const response = await handleGetBets(
      {} as any,
      buildDeps({
        getUserBetHistory: async () => {
          throw new Error('boom');
        },
      })
    );

    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error, '获取投注历史失败');
  });

  test('POST returns 403 disabled message', async () => {
    const { POST } = await routeModule;
    const response = await POST();

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '此 API 已禁用，请使用 WebSocket GameEngine.placeBet()');
  });

  test('PUT returns 403 disabled message', async () => {
    const { PUT } = await routeModule;
    const response = await PUT();

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, '此 API 已禁用，请使用 WebSocket GameEngine.placeBet()');
  });
});

