import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GameEngine } from './GameEngine';
import type { PlaceBetRequest } from './types';
import { CENTER_ROW_INDEX, MAX_ROW_INDEX, MIN_TARGET_TIME_OFFSET } from './constants';
import '../../__tests__/lib/game-engine/GameEngine.test';
import '../../__tests__/lib/game-engine/LockManager.test';
import '../../__tests__/lib/game-engine/RiskManager.test';
import '../../__tests__/lib/game-engine/SettlementService.test';
import '../../__tests__/lib/game-engine/SnapshotService.test';
import '../../__tests__/lib/services/financial.test';
import '../../__tests__/lib/services/rateLimit.test';
import '../../tests/financial.test';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test';
}

class FakeRedis {
  async set() {
    return 'OK';
  }

  async del() {
    return 1;
  }

  async zadd() {
    return 1;
  }

  async hset() {
    return 1;
  }
}

class FakePriceService extends EventEmitter {
  getLatestPrice() {
    return null;
  }
}

type UserRow = {
  id: string;
  active: boolean;
  silenced: boolean;
  balance: number;
  playBalance: number;
};

type RoundRow = {
  id: string;
  status: string;
};

type BetRow = {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  multiplier: number;
  targetRow: number;
  targetTime: number;
  rowIndex: number;
  colIndex: number;
  asset: string;
  isPlayMode: boolean;
  status: string;
};

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  const result: Record<string, unknown> = {};
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) result[key] = row[key as keyof T];
  }
  return result;
}

class FakePrisma {
  private users = new Map<string, UserRow>();
  private rounds = new Map<string, RoundRow>();
  private betsByOrderId = new Map<string, BetRow>();
  private nextBetId = 0;
  private skipBetLookup = new Set<string>();

  seedUser(user: UserRow) {
    this.users.set(user.id, user);
  }

  seedRound(round: RoundRow) {
    this.rounds.set(round.id, round);
  }

  seedBet(bet: Partial<BetRow> & { orderId: string; userId: string }) {
    this.nextBetId += 1;
    const seeded: BetRow = {
      id: bet.id ?? `bet-${this.nextBetId}`,
      orderId: bet.orderId,
      userId: bet.userId,
      amount: bet.amount ?? 10,
      multiplier: bet.multiplier ?? 2,
      targetRow: bet.targetRow ?? CENTER_ROW_INDEX,
      targetTime: bet.targetTime ?? 1,
      rowIndex: bet.rowIndex ?? Math.round(bet.targetRow ?? CENTER_ROW_INDEX),
      colIndex: bet.colIndex ?? Math.round(bet.targetTime ?? 1),
      asset: bet.asset ?? 'BTCUSDT',
      isPlayMode: bet.isPlayMode ?? false,
      status: bet.status ?? 'PENDING',
    };
    this.betsByOrderId.set(seeded.orderId, seeded);
    return seeded;
  }

  skipNextBetLookup(orderId: string) {
    this.skipBetLookup.add(orderId);
  }

  user = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const user = this.users.get(id);
      if (!user) return null;
      return pick(user, args?.select);
    },
  };

  round = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const round = this.rounds.get(id);
      if (!round) return null;
      return pick(round, args?.select);
    },
  };

  bet = {
    findUnique: async (args: any) => {
      const orderId = args?.where?.orderId as string | undefined;
      if (!orderId) return null;
      if (this.skipBetLookup.has(orderId)) {
        this.skipBetLookup.delete(orderId);
        return null;
      }
      const bet = this.betsByOrderId.get(orderId);
      if (!bet) return null;
      return pick(bet, args?.select);
    },
    create: async (args: any) => {
      const data = args?.data ?? {};
      if (data.orderId && this.betsByOrderId.has(data.orderId)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      this.nextBetId += 1;
      const bet: BetRow = {
        id: `bet-${this.nextBetId}`,
        orderId: data.orderId,
        userId: data.userId,
        amount: data.amount,
        multiplier: data.multiplier,
        targetRow: data.targetRow,
        targetTime: data.targetTime,
        rowIndex: data.rowIndex,
        colIndex: data.colIndex,
        asset: data.asset,
        isPlayMode: data.isPlayMode ?? false,
        status: data.status ?? 'PENDING',
      };
      this.betsByOrderId.set(bet.orderId, bet);
      return bet;
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function buildEngine(prisma: FakePrisma, redis: FakeRedis = new FakeRedis()) {
  const priceService = new FakePriceService();
  const engine = new GameEngine(redis as any, prisma as any, priceService as any);

  (engine as any).checkRateLimit = async () => true;
  (engine as any).state = {
    roundId: 'round-1',
    status: 'BETTING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: CENTER_ROW_INDEX,
    elapsed: 0,
    roundStartTime: Date.now(),
    activeBets: new Map(),
  };

  return engine;
}

function allowBetting(engine: GameEngine) {
  (engine as any).riskManager = {
    assessBet: () => ({ allowed: true, maxBetAllowed: 1000 }),
  };
  (engine as any).financialService = {
    conditionalChangeBalance: async () => ({ success: true }),
  };
}

function buildRequest(overrides: Partial<PlaceBetRequest> = {}): PlaceBetRequest {
  return {
    amount: 10,
    targetRow: CENTER_ROW_INDEX,
    targetTime: 1,
    orderId: 'order-1',
    ...overrides,
  };
}

const defaultBalanceSnapshot = {
  balance: 100,
  playBalance: 50,
  totalWins: 0,
  totalLosses: 0,
  totalBets: 0,
  totalProfit: 0,
};

const messages = {
  banned: '\u8d26\u53f7\u5df2\u88ab\u5c01\u7981',
  silenced: '\u8d26\u53f7\u5df2\u88ab\u7981\u8a00',
  unauthenticated: '\u672a\u767b\u5f55',
  missingAction: '\u7f3a\u5c11 action \u53c2\u6570',
  updateDisabled:
    '\u6b64 API \u5df2\u7981\u7528\u3002\u4f59\u989d\u53d8\u66f4\u7531\u670d\u52a1\u7aef\u6e38\u620f\u5f15\u64ce\u5904\u7406\u3002',
  unknownAction: '\u672a\u77e5\u7684\u64cd\u4f5c',
};

const sameOriginHeaders = {
  get: (key: string) => (key.toLowerCase() === 'origin' ? 'http://localhost:3000' : null),
};

function buildBalanceDeps(prisma: FakePrisma, overrides: Record<string, unknown> = {}) {
  return {
    auth: async () => ({ user: { id: 'user-1', name: 'User', image: null } }),
    getOrCreateUser: async () => ({ ...defaultBalanceSnapshot }),
    setPlayBalance: async () => 10000,
    prismaClient: prisma as any,
    ...overrides,
  };
}

function buildBetsDeps(prisma: FakePrisma, overrides: Record<string, unknown> = {}) {
  return {
    auth: async () => ({ user: { id: 'user-1', name: 'User', image: null } }),
    getUserBetHistory: async () => [],
    prismaClient: prisma as any,
    ...overrides,
  };
}

test('user status validation: rejects inactive user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: false,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  const request = buildRequest();

  await assert.rejects(
    () => engine.placeBet('user-1', request),
    (error: any) => {
      assert.equal(error?.message, '账号已被封禁');
      assert.equal(error?.code, 'USER_BANNED');
      return true;
    }
  );
});

test('user status validation: rejects silenced user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: true,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  const request = buildRequest({ orderId: 'order-2' });

  await assert.rejects(
    () => engine.placeBet('user-1', request),
    (error: any) => {
      assert.equal(error?.message, '账号已被禁言');
      assert.equal(error?.code, 'USER_SILENCED');
      return true;
    }
  );
});

test('user status validation: rejects missing user', async () => {
  const prisma = new FakePrisma();
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  const request = buildRequest({ orderId: 'order-missing' });

  await assert.rejects(
    () => engine.placeBet('user-missing', request),
    (error: any) => {
      assert.equal(error?.message, '用户不存在');
      assert.equal(error?.code, 'USER_NOT_FOUND');
      return true;
    }
  );
});

test('user status validation: allows active user to place bet', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  allowBetting(engine);

  const request = buildRequest({ orderId: 'order-3' });
  const result = await engine.placeBet('user-1', request);

  assert.ok(result.betId);
  assert.equal((engine as any).state.activeBets.size, 1);
});

test('idempotency: returns same bet for repeated orderId', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  allowBetting(engine);

  const request = buildRequest({ orderId: 'order-idem-1' });
  const first = await engine.placeBet('user-1', request);
  const second = await engine.placeBet('user-1', request);

  assert.equal(second.betId, first.betId);
  assert.equal((engine as any).state.activeBets.size, 1);
});

test('idempotency: continues when redis lock is busy', async () => {
  class BusyRedis extends FakeRedis {
    async set() {
      return null;
    }
  }

  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma, new BusyRedis());
  allowBetting(engine);

  const result = await engine.placeBet('user-1', buildRequest({ orderId: 'order-idem-2' }));

  assert.ok(result.betId);
  assert.equal((engine as any).state.activeBets.size, 1);
});

test('idempotency: handles redis down with db unique constraint', async () => {
  class DownRedis extends FakeRedis {
    async set() {
      throw new Error('Redis unavailable');
    }
  }

  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const seeded = prisma.seedBet({ orderId: 'order-idem-3', userId: 'user-1' });
  prisma.skipNextBetLookup('order-idem-3');

  const engine = buildEngine(prisma, new DownRedis());
  allowBetting(engine);

  const result = await engine.placeBet('user-1', buildRequest({ orderId: 'order-idem-3' }));

  assert.equal(result.betId, seeded.id);
  assert.equal(result.multiplier, seeded.multiplier);
  assert.equal(result.targetRow, seeded.targetRow);
  assert.equal(result.targetTime, seeded.targetTime);
});

test('user status validation: enforces target time boundary', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  allowBetting(engine);

  const minTargetTime = (engine as any).state.elapsed + MIN_TARGET_TIME_OFFSET;

  await assert.rejects(
    () => engine.placeBet('user-1', buildRequest({ orderId: 'order-time-1', targetTime: minTargetTime })),
    (error: any) => {
      assert.equal(error?.code, 'TARGET_TIME_PASSED');
      return true;
    }
  );

  const result = await engine.placeBet(
    'user-1',
    buildRequest({ orderId: 'order-time-2', targetTime: minTargetTime + 0.01 })
  );

  assert.ok(result.betId);
});

test('user status validation: accepts boundary target rows', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  allowBetting(engine);

  const minResult = await engine.placeBet(
    'user-1',
    buildRequest({ orderId: 'order-row-min', targetRow: 0 })
  );
  const maxResult = await engine.placeBet(
    'user-1',
    buildRequest({ orderId: 'order-row-max', targetRow: MAX_ROW_INDEX, targetTime: 1.5 })
  );

  assert.ok(minResult.betId);
  assert.ok(maxResult.betId);
  assert.equal((engine as any).state.activeBets.size, 2);
});

test('user status validation: allows anonymous play mode bet', async () => {
  const prisma = new FakePrisma();
  prisma.seedRound({ id: 'round-1', status: 'BETTING' });

  const engine = buildEngine(prisma);
  (engine as any).riskManager = {
    assessBet: () => ({ allowed: true, maxBetAllowed: 1000 }),
  };

  let conditionalCalls = 0;
  (engine as any).financialService = {
    conditionalChangeBalance: async () => {
      conditionalCalls += 1;
      return { success: true };
    },
  };

  const result = await engine.placeBet(
    'anon-1',
    buildRequest({ orderId: 'order-anon', isPlayMode: true })
  );

  assert.ok(result.betId);
  assert.equal(conditionalCalls, 0);
});

test('balance route GET rejects unauthenticated user', async () => {
  const prisma = new FakePrisma();
  const { GET } = await import('../../app/api/user/balance/route');

  const response = await GET(buildBalanceDeps(prisma, { auth: async () => null }));

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, messages.unauthenticated);
});

test('balance route GET rejects inactive user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: false,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { GET } = await import('../../app/api/user/balance/route');
  const response = await GET(buildBalanceDeps(prisma));

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error, messages.banned);
});

test('balance route GET returns balances for active user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { GET } = await import('../../app/api/user/balance/route');
  const response = await GET(
    buildBalanceDeps(prisma, {
      getOrCreateUser: async () => ({ ...defaultBalanceSnapshot, balance: 250 }),
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.balance, 250);
  assert.equal(payload.playBalance, defaultBalanceSnapshot.playBalance);
});

test('balance route POST rejects unauthenticated user', async () => {
  const prisma = new FakePrisma();
  const { POST } = await import('../../app/api/user/balance/route');
  const request = { json: async () => ({ action: 'reset_play_balance' }), headers: sameOriginHeaders };

  const response = await POST(request as any, buildBalanceDeps(prisma, { auth: async () => null }));

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, messages.unauthenticated);
});

test('balance route POST rejects missing action', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { POST } = await import('../../app/api/user/balance/route');
  const response = await POST({ json: async () => ({}), headers: sameOriginHeaders } as any, buildBalanceDeps(prisma));

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, messages.missingAction);
});

test('balance route POST resets play balance', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { POST } = await import('../../app/api/user/balance/route');
  const response = await POST(
    { json: async () => ({ action: 'reset_play_balance' }), headers: sameOriginHeaders } as any,
    buildBalanceDeps(prisma, { setPlayBalance: async () => 4321 })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.playBalance, 4321);
});

test('balance route POST rejects update action', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { POST } = await import('../../app/api/user/balance/route');
  const response = await POST(
    { json: async () => ({ action: 'update' }), headers: sameOriginHeaders } as any,
    buildBalanceDeps(prisma)
  );

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error, messages.updateDisabled);
});

test('balance route POST rejects unknown action', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { POST } = await import('../../app/api/user/balance/route');
  const response = await POST(
    { json: async () => ({ action: 'other' }), headers: sameOriginHeaders } as any,
    buildBalanceDeps(prisma)
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, messages.unknownAction);
});

test('bets route GET rejects unauthenticated user', async () => {
  const prisma = new FakePrisma();
  const { GET } = await import('../../app/api/user/bets/route');

  const response = await GET(buildBetsDeps(prisma, { auth: async () => null }));

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, messages.unauthenticated);
});

test('bets route GET rejects silenced user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: true,
    balance: 100,
    playBalance: 0,
  });

  let historyCalls = 0;
  const { GET } = await import('../../app/api/user/bets/route');
  const response = await GET(
    buildBetsDeps(prisma, {
      getUserBetHistory: async () => {
        historyCalls += 1;
        return [];
      },
    })
  );

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error, messages.silenced);
  assert.equal(historyCalls, 0);
});

test('bets route GET returns history for active user', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    active: true,
    silenced: false,
    balance: 100,
    playBalance: 0,
  });

  const { GET } = await import('../../app/api/user/bets/route');
  const response = await GET(
    buildBetsDeps(prisma, {
      getUserBetHistory: async () => [{ id: 'bet-1', amount: 10 }],
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.bets.length, 1);
});
