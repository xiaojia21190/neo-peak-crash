import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GameEngine } from '../../../lib/game-engine/GameEngine';
import { ERROR_CODES, REDIS_KEYS } from '../../../lib/game-engine/constants';
import { RiskManager } from '../../../lib/game-engine/RiskManager';
import type { PriceUpdate, ServerBet, SettlementItem } from '../../../lib/game-engine/types';
import { GameError } from '../../../lib/game-engine/errors';
import { resetInMemoryRateLimit } from '../../../lib/services/rateLimit';

class FakeRedis {
  hashes = new Map<string, Record<string, string>>();
  strings = new Map<string, string>();
  dels: string[] = [];
  zadds: Array<{ key: string; score: number; member: string }> = [];

  async hset(key: string, data: Record<string, string>) {
    this.hashes.set(key, data);
    return 1;
  }

  async get(key: string) {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async del(key: string) {
    this.dels.push(key);
    this.hashes.delete(key);
    this.strings.delete(key);
    return 1;
  }

  async eval(script: string, numKeys: number, ...args: any[]) {
    if (script.includes('risk:reserve_expected_payout')) {
      if (numKeys !== 2) throw new Error('Invalid key count');
      const [reservedKey, reservationKey, maxPayoutRaw, deltaRaw] = args;
      const maxPayout = Number(maxPayoutRaw);
      const delta = Number(deltaRaw);
      const existing = this.strings.get(String(reservationKey));
      const currentTotal = Number(this.strings.get(String(reservedKey)) ?? 0);

      if (existing != null) {
        return [1, 0, currentTotal, Number(existing)];
      }

      if (currentTotal + delta > maxPayout + 1e-6) {
        return [0, 0, currentTotal, 0];
      }

      const nextTotal = currentTotal + delta;
      this.strings.set(String(reservedKey), String(nextTotal));
      this.strings.set(String(reservationKey), String(delta));
      return [1, 1, nextTotal, delta];
    }

    if (script.includes('risk:release_expected_payout')) {
      if (numKeys !== 2) throw new Error('Invalid key count');
      const [reservedKey, reservationKey] = args;
      const existing = this.strings.get(String(reservationKey));
      const currentTotal = Number(this.strings.get(String(reservedKey)) ?? 0);
      if (existing == null) {
        return [0, currentTotal, 0];
      }
      const delta = Number(existing);
      const nextTotal = Math.max(0, currentTotal - delta);
      this.strings.set(String(reservedKey), String(nextTotal));
      this.strings.delete(String(reservationKey));
      return [1, nextTotal, delta];
    }

    throw new Error('Unsupported eval script');
  }

  async zadd(key: string, score: number, member: string) {
    this.zadds.push({ key, score, member });
    return 1;
  }
}

class FakePrisma {
  rounds = new Map<string, any>();
  bets = new Map<string, any>();
  users = new Map<string, any>();
  betsByOrderId = new Map<string, any>();
  updateCalls: any[] = [];
  roundUpdateManyError: Error | null = null;
  betFindManyError: Error | null = null;
  private roundSeq = 0;
  private betSeq = 0;

  seedUser(row: { id: string; active?: boolean; silenced?: boolean; balance?: number; playBalance?: number }) {
    this.users.set(row.id, {
      id: row.id,
      active: row.active ?? true,
      silenced: row.silenced ?? false,
      balance: row.balance ?? 100,
      playBalance: row.playBalance ?? 0,
    });
  }

  seedBet(row: { id?: string; orderId: string; userId: string; roundId: string; status?: string }) {
    this.betSeq += 1;
    const id = row.id ?? `bet-${this.betSeq}`;
    const bet = {
      id,
      orderId: row.orderId,
      userId: row.userId,
      roundId: row.roundId,
      status: row.status ?? 'PENDING',
      amount: 10,
      multiplier: 2,
      targetTime: 2,
      targetRow: 5,
      isPlayMode: false,
      asset: 'BTCUSDT',
      createdAt: new Date(),
    };
    this.bets.set(id, bet);
    this.betsByOrderId.set(row.orderId, bet);
    return bet;
  }

  round = {
    create: async (args: any) => {
      this.roundSeq += 1;
      const round = { id: `round-${this.roundSeq}`, ...args.data };
      this.rounds.set(round.id, round);
      return round;
    },
    updateMany: async (args: any) => {
      if (this.roundUpdateManyError) {
        throw this.roundUpdateManyError;
      }
      this.updateCalls.push(args);
      const where = args?.where ?? {};
      const data = args?.data ?? {};
      let count = 0;

      for (const round of this.rounds.values()) {
        if (where.id && round.id !== where.id) continue;
        if (where.status) {
          if (typeof where.status === 'string' && round.status !== where.status) continue;
          if (where.status.in && !where.status.in.includes(round.status)) continue;
        }
        Object.assign(round, data);
        count += 1;
      }

      return { count };
    },
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const round = this.rounds.get(id);
      if (!round) return null;
      if (!args.select) return round;
      const result: any = {};
      if (args.select.status) result.status = round.status;
      return result;
    },
  };

  bet = {
    updateMany: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      const status = args?.where?.status as any;
      const bet = id ? this.bets.get(id) : undefined;
      if (!bet) return { count: 0 };
      if (status) {
        if (typeof status === 'string' && bet.status !== status) return { count: 0 };
        if (status.in && !status.in.includes(bet.status)) return { count: 0 };
      }
      Object.assign(bet, args.data ?? {});
      return { count: 1 };
    },
    findMany: async (args: any) => {
      if (this.betFindManyError) {
        throw this.betFindManyError;
      }
      const where = args?.where ?? {};
      const roundId = where.roundId as string | undefined;
      const status = where.status as any;
      const results = Array.from(this.bets.values()).filter((bet) => {
        if (roundId && bet.roundId !== roundId) return false;
        if (status) {
          if (typeof status === 'string' && bet.status !== status) return false;
          if (status.in && !status.in.includes(bet.status)) return false;
        }
        return true;
      });

      if (!args.select) return results;

      return results.map((bet) => {
        const selected: any = {};
        for (const [key, enabled] of Object.entries(args.select as Record<string, boolean>)) {
          if (enabled) selected[key] = (bet as any)[key];
        }
        return selected;
      });
    },
    findUnique: async (args: any) => {
      const orderId = args?.where?.orderId as string | undefined;
      if (!orderId) return null;
      return this.betsByOrderId.get(orderId) ?? null;
    },
    create: async (args: any) => {
      if (args?.data?.orderId && this.betsByOrderId.has(args.data.orderId)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      this.betSeq += 1;
      const bet = { id: `bet-${this.betSeq}`, ...args.data };
      this.bets.set(bet.id, bet);
      if (bet.orderId) this.betsByOrderId.set(bet.orderId, bet);
      return bet;
    },
  };

  user = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const user = this.users.get(id);
      if (!user) return null;
      if (!args.select) return user;
      const result: any = {};
      if (args.select.active) result.active = user.active;
      if (args.select.silenced) result.silenced = user.silenced;
      if (args.select.balance) result.balance = user.balance;
      if (args.select.playBalance) result.playBalance = user.playBalance;
      return result;
    },
    update: async (_args: any) => {
      return {};
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakePriceService extends EventEmitter {
  private price: PriceUpdate | null;
  constructor(price: PriceUpdate | null) {
    super();
    this.price = price;
  }

  getLatestPrice() {
    return this.price;
  }

  setPrice(price: PriceUpdate) {
    this.price = price;
    this.emit('price', price);
  }
}

class FakeSettlementService {
  enqueueCalls: SettlementItem[][] = [];
  scheduleCalls: Array<{ roundId: string; reason: string }> = [];
  flushed = true;
  pendingCount = 0;
  resetCalled = false;
  disposeCalled = false;
  compensateCalls = 0;

  enqueue(items: SettlementItem[]) {
    this.enqueueCalls.push(items);
  }

  async flushQueue() {
    return this.flushed;
  }

  async compensateUnsettledBets() {
    this.compensateCalls += 1;
  }

  async countPendingBets() {
    return this.pendingCount;
  }

  scheduleRetry(roundId: string, _snapshot: any, reason: string) {
    this.scheduleCalls.push({ roundId, reason });
  }

  calculatePayout(amount: number, multiplier: number, isWin: boolean) {
    return isWin ? amount * multiplier : 0;
  }

  resetQueue() {
    this.resetCalled = true;
  }

  dispose() {
    this.disposeCalled = true;
  }
}

class FakeSnapshotService {
  bufferCalls: any[] = [];
  flushCalls = 0;
  resetCalled = false;

  bufferSnapshot(payload: any) {
    this.bufferCalls.push(payload);
  }

  async flushSnapshots() {
    this.flushCalls += 1;
  }

  resetBuffer() {
    this.resetCalled = true;
  }
}

class FakeLockManager {
  acquireCalls = 0;
  releaseCalls = 0;
  betAcquireCalls = 0;
  betReleaseCalls = 0;
  betLockToken: string | null = 'bet-token';
  betReleaseResult = true;
  betAcquireError: Error | null = null;
  betReleaseError: Error | null = null;

  async acquireRoundLock() {
    this.acquireCalls += 1;
    return 'lock-token';
  }

  async releaseRoundLock() {
    this.releaseCalls += 1;
    return true;
  }

  async acquireBetLock(_orderId?: string, _ttlMs?: number) {
    this.betAcquireCalls += 1;
    if (this.betAcquireError) {
      throw this.betAcquireError;
    }
    return this.betLockToken;
  }

  async releaseBetLock(_orderId?: string, _token?: string) {
    this.betReleaseCalls += 1;
    if (this.betReleaseError) {
      throw this.betReleaseError;
    }
    return this.betReleaseResult;
  }
}

class FakeFinancialService {
  changeCalls: any[] = [];
  conditionalCalls: any[] = [];
  conditionalResult: { success: boolean; error?: string } = { success: true };

  async changeBalance(params: any) {
    this.changeCalls.push(params);
    return { balanceBefore: 0, balanceAfter: 0 };
  }

  async conditionalChangeBalance(params: any) {
    this.conditionalCalls.push(params);
    return this.conditionalResult;
  }
}

class FakeHousePoolService {
  balances = new Map<string, number>();
  getCalls: string[] = [];
  initCalls: Array<{ asset: string; initialBalance: number }> = [];
  applyCalls: Array<{ asset: string; amount: number; tx: any }> = [];

  async getBalance(asset: string) {
    this.getCalls.push(asset);
    return this.balances.has(asset) ? this.balances.get(asset)! : null;
  }

  async initialize(asset: string, initialBalance: number) {
    this.initCalls.push({ asset, initialBalance });
    if (!this.balances.has(asset)) {
      this.balances.set(asset, initialBalance);
    }
    return this.balances.get(asset)!;
  }

  async applyDelta(params: { asset: string; amount: number }, tx: any) {
    this.applyCalls.push({ ...params, tx });
    const current = this.balances.get(params.asset) ?? 0;
    const next = current + params.amount;
    this.balances.set(params.asset, next);
    return { balance: next, version: 1 };
  }
}

function createEngine(price: PriceUpdate | null) {
  process.env.RATE_LIMIT_REDIS_ENABLED = 'false';
  const redis = new FakeRedis();
  const prisma = new FakePrisma();
  const priceService = new FakePriceService(price);
  const engine = new GameEngine(redis as any, prisma as any, priceService as any, {
    asset: 'BTCUSDT',
    bettingDuration: 0,
    maxDuration: 10,
    minBetAmount: 1,
    maxBetAmount: 100,
    maxBetsPerUser: 10,
    maxBetsPerSecond: 5,
    hitTolerance: 1,
    tickInterval: 100,
  });

  const settlementService = new FakeSettlementService();
  const snapshotService = new FakeSnapshotService();
  const lockManager = new FakeLockManager();
  const financialService = new FakeFinancialService();
  const housePoolService = new FakeHousePoolService();
  housePoolService.balances.set('BTCUSDT', 100000);
  const originalStartTickLoop = (engine as any).startTickLoop.bind(engine);
  const originalStopTickLoop = (engine as any).stopTickLoop.bind(engine);

  (engine as any).settlementService = settlementService;
  (engine as any).snapshotService = snapshotService;
  (engine as any).lockManager = lockManager;
  (engine as any).financialService = financialService;
  (engine as any).housePoolService = housePoolService;
  (engine as any).startTickLoop = () => {};
  (engine as any).checkRateLimit = async () => true;

  return {
    engine,
    redis,
    prisma,
    priceService,
    settlementService,
    snapshotService,
    lockManager,
    financialService,
    housePoolService,
    originalStartTickLoop,
    originalStopTickLoop,
  };
}

function seedBettingState(engine: GameEngine, prisma: FakePrisma, roundId = 'round-bet') {
  const now = Date.now();
  (engine as any).state = {
    roundId,
    status: 'BETTING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: now - 1000,
    activeBets: new Map<string, ServerBet>(),
  };
  prisma.rounds.set(roundId, { id: roundId, status: 'BETTING' });
  return roundId;
}

function makeValidRequest(overrides: Partial<{ orderId: string; targetRow: number; targetTime: number; amount: number; isPlayMode: boolean }> = {}) {
  return {
    orderId: 'order-1',
    targetRow: 5,
    targetTime: 2,
    amount: 10,
    isPlayMode: false,
    ...overrides,
  };
}

test('GameEngine startRound transitions to RUNNING', async () => {
  const { engine, prisma, lockManager } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  await engine.startRound();
  assert.equal(engine.getState()?.status, 'BETTING');
  assert.equal(lockManager.acquireCalls, 1);
  assert.equal(prisma.rounds.size, 1);

  (engine as any).transitionToRunning();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(engine.getState()?.status, 'RUNNING');
});

test('GameEngine startRound fails when price is unavailable', async () => {
  const { engine } = createEngine(null);

  await assert.rejects(
    () => engine.startRound(),
    (err) => err instanceof GameError && err.code === ERROR_CODES.PRICE_UNAVAILABLE
  );
});

test('GameEngine startRound refuses when a round is already active', async () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-active',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };

  await assert.rejects(
    () => engine.startRound(),
    (err) => err instanceof GameError && err.code === ERROR_CODES.NO_ACTIVE_ROUND
  );
});

test('GameEngine startRound fails when lock is unavailable', async () => {
  const { engine, lockManager } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  lockManager.acquireRoundLock = async () => null;

  await assert.rejects(
    () => engine.startRound(),
    (err) => err instanceof GameError && err.code === ERROR_CODES.NO_ACTIVE_ROUND
  );
});

test('GameEngine transitionToRunning skips when round already transitioned', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-skip',
    status: 'BETTING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };

  prisma.rounds.set('round-skip', { id: 'round-skip', status: 'RUNNING' });

  (engine as any).transitionToRunning();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(engine.getState()?.status, 'BETTING');
});

test('GameEngine tick loop can start and stop', () => {
  const { engine, originalStartTickLoop, originalStopTickLoop } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  originalStartTickLoop();
  originalStopTickLoop();

  assert.equal((engine as any).tickTimer, null);
});

test('GameEngine placeBet succeeds for active users', async () => {
  const { engine, prisma, redis, lockManager, financialService, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-1');
  prisma.seedUser({ id: 'user-1', balance: 250, playBalance: 50 });

  const result = await engine.placeBet('user-1', makeValidRequest());

  assert.ok(result.betId);
  assert.equal(lockManager.betAcquireCalls, 1);
  assert.equal(financialService.conditionalCalls.length, 1);
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(housePoolService.applyCalls[0].amount, 10);
  assert.equal((engine as any).state.activeBets.size, 1);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(redis.zadds.length, 1);
});

test('GameEngine placeBet returns existing bet for duplicate orderId', async () => {
  const { engine, prisma, lockManager } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-bet-2');
  prisma.seedUser({ id: 'user-1' });

  const seeded = prisma.seedBet({ orderId: 'order-dup', userId: 'user-1', roundId });
  const result = await engine.placeBet('user-1', makeValidRequest({ orderId: 'order-dup' }));

  assert.equal(result.betId, seeded.id);
  assert.equal(lockManager.betAcquireCalls, 0);
});

test('GameEngine placeBet rehydrates existing pending bets into in-memory state', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-bet-rehydrate');
  prisma.seedUser({ id: 'user-1' });

  const seeded = prisma.seedBet({ orderId: 'order-rehydrate', userId: 'user-1', roundId });
  assert.equal((engine as any).state.activeBets.size, 0);

  const result = await engine.placeBet('user-1', makeValidRequest({ orderId: 'order-rehydrate' }));

  assert.equal(result.betId, seeded.id);
  assert.equal((engine as any).state.activeBets.size, 1);
  assert.ok((engine as any).state.activeBets.has(seeded.id));
});

test('GameEngine placeBet validates user status', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-3');

  await assert.rejects(
    () => engine.placeBet('missing-user', makeValidRequest()),
    (err) => err instanceof GameError && err.code === ERROR_CODES.USER_NOT_FOUND
  );

  prisma.seedUser({ id: 'user-2', active: false });
  await assert.rejects(
    () => engine.placeBet('user-2', makeValidRequest({ orderId: 'order-2' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.USER_BANNED
  );

  prisma.seedUser({ id: 'user-3', silenced: true });
  await assert.rejects(
    () => engine.placeBet('user-3', makeValidRequest({ orderId: 'order-3' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.USER_SILENCED
  );
});

test('GameEngine placeBet rejects invalid requests and rate limits', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-4');
  prisma.seedUser({ id: 'user-1' });

  (engine as any).checkRateLimit = async () => false;
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest()),
    (err) => err instanceof GameError && err.code === ERROR_CODES.RATE_LIMITED
  );

  (engine as any).checkRateLimit = async () => true;
  (engine as any).state.elapsed = 10;
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-4', targetTime: 10 })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.TARGET_TIME_PASSED
  );

  (engine as any).state.elapsed = 1;
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-5', targetTime: 100 })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );

  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-5b', amount: 200 })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );

  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-6', amount: 0 })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );

  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-7', targetRow: -1 })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );

  (engine as any).state.activeBets.set('existing', {
    id: 'existing',
    orderId: 'existing',
    userId: 'user-1',
    amount: 1,
    multiplier: 1,
    targetRow: 1,
    targetTime: 2,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  });
  (engine as any).state.activeBets.set('existing-2', {
    id: 'existing-2',
    orderId: 'existing-2',
    userId: 'user-1',
    amount: 1,
    multiplier: 1,
    targetRow: 1,
    targetTime: 2,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  });
  (engine as any).config.maxBetsPerUser = 1;
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-8' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.MAX_BETS_REACHED
  );

  process.env.MAX_ACTIVE_BETS = '1';
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-8b' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.MAX_BETS_REACHED
  );
  delete process.env.MAX_ACTIVE_BETS;
});

test('GameEngine checkRateLimit uses in-memory limiter', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-rate');
  resetInMemoryRateLimit();

  const allowed = await (GameEngine.prototype as any).checkRateLimit.call(engine, 'user-rate');
  assert.equal(allowed, true);
});

test('GameEngine placeBet handles locks and transaction failures', async () => {
  const { engine, prisma, lockManager, financialService, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-bet-5');
  prisma.seedUser({ id: 'user-1' });

  prisma.seedBet({ orderId: 'order-dupe', userId: 'other', roundId });
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-dupe' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.DUPLICATE_BET
  );

  prisma.betsByOrderId.delete('order-dupe');
  lockManager.betLockToken = null;
  const lockFallback = await engine.placeBet('user-1', makeValidRequest({ orderId: 'order-9' }));
  assert.ok(lockFallback.betId);
  assert.equal(housePoolService.applyCalls.length, 1);

  lockManager.betLockToken = 'bet-token';
  financialService.conditionalResult = { success: false, error: 'no funds' };
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-10' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INSUFFICIENT_BALANCE
  );
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(lockManager.betReleaseCalls, 1);
});

test('GameEngine placeBet warns when bet lock release fails', async () => {
  const { engine, prisma, lockManager, financialService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-warn');
  prisma.seedUser({ id: 'user-1' });

  lockManager.betLockToken = 'bet-token';
  lockManager.betReleaseResult = false;
  financialService.conditionalResult = { success: false, error: 'no funds' };

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };

  try {
    await assert.rejects(
      () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-warn' })),
      (err) => err instanceof GameError && err.code === ERROR_CODES.INSUFFICIENT_BALANCE
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some((message) => message.includes('Bet lock release skipped')));
});

test('GameEngine placeBet is idempotent under concurrent requests', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-concurrent');
  prisma.seedUser({ id: 'user-1' });

  const request = makeValidRequest({ orderId: 'order-concurrent' });
  const [first, second] = await Promise.all([
    engine.placeBet('user-1', request),
    engine.placeBet('user-1', request),
  ]);

  assert.equal(first.betId, second.betId);
  assert.equal(prisma.betsByOrderId.size, 1);
  assert.equal((engine as any).state.activeBets.size, 1);
});

test('GameEngine placeBet accepts concurrent bets from multiple users', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-multi');
  prisma.seedUser({ id: 'user-1' });
  prisma.seedUser({ id: 'user-2' });

  const [first, second] = await Promise.all([
    engine.placeBet('user-1', makeValidRequest({ orderId: 'order-multi-1' })),
    engine.placeBet('user-2', makeValidRequest({ orderId: 'order-multi-2' })),
  ]);

  assert.ok(first.betId);
  assert.ok(second.betId);
  assert.notEqual(first.betId, second.betId);
  assert.equal(prisma.betsByOrderId.size, 2);
  assert.equal((engine as any).state.activeBets.size, 2);
});

test('GameEngine placeBet rejects invalid state and orderId', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  prisma.seedUser({ id: 'user-1' });

  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest()),
    (err) => err instanceof GameError && err.code === ERROR_CODES.NO_ACTIVE_ROUND
  );

  seedBettingState(engine, prisma, 'round-bet-6');
  (engine as any).state.status = 'RUNNING';
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-11' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.BETTING_CLOSED
  );

  (engine as any).state.status = 'BETTING';
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: '  ' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );
});

test('GameEngine placeBet enforces round status and anonymous rules', async () => {
  const { engine, prisma, lockManager } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-bet-7');
  prisma.seedUser({ id: 'user-1' });

  prisma.rounds.set(roundId, { id: roundId, status: 'RUNNING' });
  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-12' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.BETTING_CLOSED
  );

  prisma.rounds.set(roundId, { id: roundId, status: 'BETTING' });
  await assert.rejects(
    () => engine.placeBet('anon-1', makeValidRequest({ orderId: 'order-13', isPlayMode: false })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INSUFFICIENT_BALANCE
  );

  // Anonymous real-money check now happens before lock acquisition, so only 1 release call
  assert.equal(lockManager.betReleaseCalls, 1);
});

test('GameEngine placeBet respects risk limits', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  seedBettingState(engine, prisma, 'round-bet-8');
  prisma.seedUser({ id: 'user-1' });

  (engine as any).riskManager = new RiskManager({ maxRoundPayout: 1 });

  await assert.rejects(
    () => engine.placeBet('user-1', makeValidRequest({ orderId: 'order-14' })),
    (err) => err instanceof GameError && err.code === ERROR_CODES.INVALID_AMOUNT
  );
});

test('GameEngine placeBet reserves expected payout and releases after settlement', async () => {
  const { engine, prisma, redis } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-reserve-1');
  prisma.seedUser({ id: 'user-1' });

  (engine as any).riskManager = new RiskManager({ maxRoundPayout: 100 });

  const result = await engine.placeBet('user-1', makeValidRequest({ orderId: 'order-reserve' }));

  const reservedKey = (engine as any).riskManager.buildReservedExpectedPayoutKey(roundId);
  const reservationKey = (engine as any).riskManager.buildOrderReservationKey(roundId, 'order-reserve');

  const reservedBefore = Number(await redis.get(reservedKey));
  assert.ok(reservedBefore > 0);
  assert.equal(await redis.get(reservationKey), String(reservedBefore));

  await (engine as any).handleBetSettled({
    betId: result.betId,
    orderId: 'order-reserve',
    userId: 'user-1',
    isWin: false,
    payout: 0,
  });

  assert.equal(Number(await redis.get(reservedKey)), 0);
  assert.equal(await redis.get(reservationKey), null);
});

test('GameEngine placeBet atomically reserves expected payout across concurrent bets', async () => {
  const { engine, prisma, redis } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const roundId = seedBettingState(engine, prisma, 'round-atomic-1');
  prisma.seedUser({ id: 'user-1' });

  (engine as any).riskManager = new RiskManager({ maxRoundPayout: 11 });

  const [first, second] = await Promise.allSettled([
    engine.placeBet('user-1', makeValidRequest({ orderId: 'order-atomic-1' })),
    engine.placeBet('user-1', makeValidRequest({ orderId: 'order-atomic-2' })),
  ]);

  const successes = [first, second].filter((r) => r.status === 'fulfilled');
  const failures = [first, second].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].reason instanceof GameError);
  assert.equal((failures[0].reason as GameError).code, ERROR_CODES.INVALID_AMOUNT);

  const reservedKey = (engine as any).riskManager.buildReservedExpectedPayoutKey(roundId);
  const reserved = Number(await redis.get(reservedKey));
  assert.ok(reserved > 0);
  assert.ok(reserved <= 11);
  assert.equal(prisma.betsByOrderId.size, 1);
  assert.equal((engine as any).state.activeBets.size, 1);
});

test('GameEngine tick enqueues missed bets and buffers snapshots', () => {
  const { engine, settlementService, snapshotService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const now = Date.now();
  (engine as any).state = {
    roundId: 'round-1',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 0,
    roundStartTime: now - 5000,
    activeBets: new Map(),
  };

  const missBet: ServerBet = {
    id: 'bet-miss',
    orderId: 'order-miss',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 0,
    targetTime: 1,
    placedAt: now - 4000,
    status: 'PENDING',
    isPlayMode: false,
  };

  (engine as any).heapPush(missBet);
  engine.updatePriceCache({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: now,
    source: 'bybit',
  });

  (engine as any).tick();

  assert.equal(settlementService.enqueueCalls.length, 1);
  assert.equal(settlementService.enqueueCalls[0][0].isWin, false);
  assert.equal(snapshotService.bufferCalls.length, 1);
});

test('GameEngine tick resolves winning bets', () => {
  const { engine, settlementService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const now = Date.now();
  (engine as any).state = {
    roundId: 'round-win',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    prevRow: 5,
    elapsed: 0,
    roundStartTime: now - 1000,
    activeBets: new Map(),
  };

  const winBet: ServerBet = {
    id: 'bet-win-tick',
    orderId: 'order-win-tick',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 5,
    targetTime: 1,
    placedAt: now - 900,
    status: 'PENDING',
    isPlayMode: false,
  };

  (engine as any).heapPush(winBet);
  (engine as any).tick();

  assert.equal(settlementService.enqueueCalls.length, 1);
  assert.equal(settlementService.enqueueCalls[0][0].isWin, true);
});

test('GameEngine tick exits when not running', () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = null;
  (engine as any).tick();

  (engine as any).state = {
    roundId: 'round-settling',
    status: 'SETTLING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 0,
    roundStartTime: Date.now(),
    activeBets: new Map(),
  };

  (engine as any).tick();
});

test('GameEngine settleAllPendingBets marks wins', () => {
  const { engine, settlementService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-2',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 10,
    elapsed: 5,
    roundStartTime: Date.now() - 5000,
    activeBets: new Map(),
  };

  const winBet: ServerBet = {
    id: 'bet-win',
    orderId: 'order-win',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 10,
    targetTime: 5,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  };

  (engine as any).heapPush(winBet);
  (engine as any).settleAllPendingBets();

  assert.equal(settlementService.enqueueCalls.length, 1);
  assert.equal(settlementService.enqueueCalls[0][0].isWin, true);
  assert.equal(settlementService.enqueueCalls[0][0].hitDetails?.hitRow, 10);
});

test('GameEngine endRound schedules retries and cleans up', async () => {
  const { engine, redis, prisma, settlementService, snapshotService, lockManager } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-3',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 110,
    currentRow: 7,
    elapsed: 6,
    roundStartTime: Date.now() - 6000,
    activeBets: new Map<string, ServerBet>(),
  };

  prisma.rounds.set('round-3', { id: 'round-3', status: 'RUNNING' });

  settlementService.flushed = false;
  settlementService.pendingCount = 2;

  const bet: ServerBet = {
    id: 'bet-3',
    orderId: 'order-3',
    userId: 'user-1',
    amount: 5,
    multiplier: 2,
    targetRow: 7,
    targetTime: 6,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  };
  (engine as any).state.activeBets.set(bet.id, bet);
  (engine as any).heapPush(bet);

  await engine.endRound('manual');

  assert.equal(settlementService.scheduleCalls.length, 1);
  assert.equal(settlementService.scheduleCalls[0].reason, 'flush_timeout');
  assert.equal(snapshotService.flushCalls, 1);
  assert.equal(lockManager.releaseCalls, 1);
  assert.ok(redis.dels.includes(`${REDIS_KEYS.ACTIVE_BETS}round-3`));
  assert.equal(engine.getState(), null);
});

test('GameEngine endRound is a no-op when inactive', async () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  await engine.endRound('manual');
  assert.equal(engine.getState(), null);
});

test('GameEngine endRound emits crash on snapshot failures', async () => {
  const { engine, prisma, snapshotService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-crash',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };
  prisma.rounds.set('round-crash', { id: 'round-crash', status: 'RUNNING' });

  (snapshotService as any).flushSnapshots = async () => {
    throw new Error('boom');
  };

  let reason: string | undefined;
  engine.on('round:end', (payload) => {
    reason = payload.reason;
  });

  await engine.endRound('manual');
  assert.equal(reason, 'crash');
});

test('GameEngine cancelRound refunds pending bets', async () => {
  const { engine, prisma, financialService, lockManager, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const bet: ServerBet = {
    id: 'bet-refund',
    orderId: 'order-refund',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 3,
    targetTime: 2,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  };

  prisma.seedBet({
    id: 'bet-refund',
    orderId: 'order-refund',
    userId: 'user-1',
    roundId: 'round-4',
    status: 'PENDING',
  });

  (engine as any).state = {
    roundId: 'round-4',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 3,
    roundStartTime: Date.now() - 3000,
    activeBets: new Map<string, ServerBet>([['bet-refund', bet]]),
  };

  await engine.cancelRound('manual');

  assert.equal(bet.status, 'REFUNDED');
  assert.equal(financialService.changeCalls.length, 1);
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(housePoolService.applyCalls[0].amount, -10);
  assert.equal(lockManager.releaseCalls, 1);
  assert.equal(engine.getState(), null);
});

test('GameEngine cancelRound refunds settling bets', async () => {
  const { engine, prisma, financialService, lockManager, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const bet: ServerBet = {
    id: 'bet-refund-settling',
    orderId: 'order-refund-settling',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 3,
    targetTime: 2,
    placedAt: Date.now(),
    status: 'SETTLING',
    isPlayMode: false,
  };

  prisma.seedBet({
    id: 'bet-refund-settling',
    orderId: 'order-refund-settling',
    userId: 'user-1',
    roundId: 'round-settling',
    status: 'SETTLING',
  });

  (engine as any).state = {
    roundId: 'round-settling',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 3,
    roundStartTime: Date.now() - 3000,
    activeBets: new Map<string, ServerBet>([['bet-refund-settling', bet]]),
  };

  await engine.cancelRound('manual');

  assert.equal(bet.status, 'REFUNDED');
  assert.equal(financialService.changeCalls.length, 1);
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(housePoolService.applyCalls[0].amount, -10);
  assert.equal(lockManager.releaseCalls, 1);
  assert.equal(engine.getState(), null);
});

test('GameEngine refundBet skips already settled bets', async () => {
  const { engine, prisma } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const bet: ServerBet = {
    id: 'bet-skip',
    orderId: 'order-skip',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 3,
    targetTime: 2,
    placedAt: Date.now(),
    status: 'WON',
    isPlayMode: false,
  };

  prisma.bets.set('bet-skip', { id: 'bet-skip', status: 'WON' });
  await (engine as any).refundBet(bet, 'already settled');

  assert.equal(bet.status, 'WON');
});

test('GameEngine tick triggers timeout endRound', async () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  let ended = false;
  (engine as any).endRound = async () => {
    ended = true;
  };

  (engine as any).state = {
    roundId: 'round-timeout',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 0,
    roundStartTime: Date.now() - 20000,
    activeBets: new Map<string, ServerBet>(),
  };

  (engine as any).tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ended, true);
});

test('GameEngine price_critical event cancels active rounds', () => {
  const { engine, priceService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  let cancelled = false;
  (engine as any).state = {
    roundId: 'round-critical',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };

  (engine as any).cancelRound = async () => {
    cancelled = true;
  };

  priceService.emit('price_critical');
  assert.equal(cancelled, true);
});

test('GameEngine syncStateToRedis is safe without state', async () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = null;
  await (engine as any).syncStateToRedis();
});

test('GameEngine getPoolBalance returns stored pool balance', async () => {
  const { engine, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  housePoolService.balances.set('BTCUSDT', 450);
  const balance = await (engine as any).getPoolBalance();

  assert.equal(balance, 450);
  assert.equal(housePoolService.initCalls.length, 0);
});

test('GameEngine utility methods', async () => {
  const { engine, housePoolService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  let updates = 0;
  engine.on('state:update', () => {
    updates += 1;
  });

  (engine as any).emitThrottled('state:update', { ok: true }, 1000);
  (engine as any).emitThrottled('state:update', { ok: true }, 1000);

  assert.equal(updates, 1);
  assert.ok(engine.getConfig().asset);

  (engine as any).state = {
    roundId: 'round-5',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };

  let cancelled = false;
  (engine as any).cancelRound = async () => {
    cancelled = true;
  };

  (engine as any).handlePriceUnavailable();
  assert.equal(cancelled, true);

  housePoolService.balances.clear();
  const originalPool = process.env.HOUSE_POOL_BALANCE;
  process.env.HOUSE_POOL_BALANCE = 'invalid';
  assert.equal(await (engine as any).getPoolBalance(), 0);
  assert.equal(housePoolService.initCalls.length, 1);
  if (originalPool === undefined) delete process.env.HOUSE_POOL_BALANCE;
  else process.env.HOUSE_POOL_BALANCE = originalPool;
});

test('GameEngine auto-round scheduling and stop', async () => {
  const { engine } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const scheduleCalls: number[] = [];
  (engine as any).scheduleNextRound = (delayMs: number) => {
    scheduleCalls.push(delayMs);
  };

  engine.startAutoRound(2500);
  assert.equal(scheduleCalls[0], 1000);

  let started = 0;
  (engine as any).startRound = async () => {
    started += 1;
  };

  (engine as any).autoRoundEnabled = true;
  (engine as any).scheduleNextRound = (GameEngine.prototype as any).scheduleNextRound.bind(engine);
  (engine as any).scheduleNextRound(0);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 1);

  engine.stopAutoRound();
});

test('GameEngine stop disposes settlement service', async () => {
  const { engine, settlementService } = createEngine({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  (engine as any).state = {
    roundId: 'round-6',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    activeBets: new Map<string, ServerBet>(),
  };

  let cancelled = false;
  (engine as any).cancelRound = async () => {
    cancelled = true;
  };

  await engine.stop();

  assert.equal(cancelled, true);
  assert.equal(settlementService.disposeCalled, true);
});
