import test from 'node:test';
import assert from 'node:assert/strict';
import { SettlementService } from '../../../lib/game-engine/SettlementService';
import { HIT_TIME_TOLERANCE } from '../../../lib/game-engine/constants';
import type { ServerBet } from '../../../lib/game-engine/types';

type BetRow = {
  id: string;
  roundId: string;
  userId: string;
  amount: number;
  multiplier: number;
  status: string;
  isPlayMode: boolean;
  targetRow: number;
  targetTime: number;
  payout?: number;
  isWin?: boolean;
  hitPrice?: number;
  hitRow?: number;
  hitTime?: number;
};

type UserRow = {
  id: string;
  totalBets: number;
  totalWins: number;
  totalLosses: number;
  totalProfit: number;
};

class FakePrisma {
  private bets = new Map<string, BetRow>();
  private users = new Map<string, UserRow>();
  failTransactions = 0;
  forcedPendingCount: number | null = null;
  forceUpdateFail = false;

  seedBet(row: BetRow) {
    this.bets.set(row.id, { ...row });
  }

  seedUser(row: UserRow) {
    this.users.set(row.id, { ...row });
  }

  getBet(id: string) {
    return this.bets.get(id);
  }

  getUser(id: string) {
    return this.users.get(id);
  }

  bet = {
    updateMany: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      const status = args?.where?.status as string | undefined;
      if (!id) throw new Error('Missing bet id');

      const bet = this.bets.get(id);
      if (!bet) return { count: 0 };
      if (status && bet.status !== status) return { count: 0 };
      if (this.forceUpdateFail) return { count: 0 };

      Object.assign(bet, args.data ?? {});
      return { count: 1 };
    },
    findMany: async (args: any) => {
      const roundId = args?.where?.roundId as string | undefined;
      const status = args?.where?.status as string | undefined;
      return Array.from(this.bets.values()).filter((bet) => {
        if (roundId && bet.roundId !== roundId) return false;
        if (status && bet.status !== status) return false;
        return true;
      });
    },
    count: async (args: any) => {
      if (this.forcedPendingCount !== null) return this.forcedPendingCount;
      const roundId = args?.where?.roundId as string | undefined;
      const status = args?.where?.status as string | undefined;
      return Array.from(this.bets.values()).filter((bet) => {
        if (roundId && bet.roundId !== roundId) return false;
        if (status && bet.status !== status) return false;
        return true;
      }).length;
    },
  };

  user = {
    update: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing user id');
      const user = this.users.get(id);
      if (!user) throw new Error('Missing user');

      const data = args.data ?? {};
      if (data.totalBets?.increment) user.totalBets += data.totalBets.increment;
      if (data.totalWins?.increment) user.totalWins += data.totalWins.increment;
      if (data.totalLosses?.increment) user.totalLosses += data.totalLosses.increment;
      if (data.totalProfit?.increment) user.totalProfit += data.totalProfit.increment;

      return { ...user };
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    if (this.failTransactions > 0) {
      this.failTransactions -= 1;
      throw new Error('transaction failed');
    }
    return fn(this);
  }
}

class FakeFinancialService {
  changeCalls: any[] = [];
  batchCalls: any[] = [];

  async changeBalance(params: any) {
    this.changeCalls.push(params);
    return { balanceBefore: 0, balanceAfter: 0 };
  }

  async batchChangeBalance(params: any) {
    this.batchCalls.push(params);
    return { balanceBefore: 0, balanceAfter: 0, transactionIds: [] };
  }
}

class FakeHousePoolService {
  applyCalls: Array<{ asset: string; amount: number }> = [];

  async applyDelta(params: { asset: string; amount: number }) {
    this.applyCalls.push({ asset: params.asset, amount: params.amount });
    return { balance: 0, version: 1 };
  }
}

class FakeSnapshotService {
  snapshots: any[] = [];
  calls: any[] = [];

  async getSnapshotsInWindow(args: any) {
    this.calls.push(args);
    return this.snapshots;
  }
}

test('SettlementService.enqueue settles wins and emits callbacks', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-1',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-1',
    roundId: 'round-1',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    status: 'PENDING',
    isPlayMode: false,
    targetRow: 5,
    targetTime: 1,
  });

  const financial = new FakeFinancialService();
  const housePoolService = new FakeHousePoolService();
  const snapshotService = new FakeSnapshotService();
  const activeBets = new Map<string, ServerBet>();
  const bet: ServerBet = {
    id: 'bet-1',
    orderId: 'order-1',
    userId: 'user-1',
    amount: 10,
    multiplier: 2,
    targetRow: 5,
    targetTime: 1,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  };
  activeBets.set(bet.id, bet);

  const settled: any[] = [];
  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: housePoolService as any,
    snapshotService: snapshotService as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
    callbacks: {
      getActiveBet: (betId) => activeBets.get(betId),
      onBetSettled: (payload) => settled.push(payload),
    },
  });

  service.enqueue([
    {
      bet,
      isWin: true,
      hitDetails: { hitPrice: 100, hitRow: 5, hitTime: 1 },
    },
  ]);

  await service.flushQueue();

  const dbBet = prisma.getBet('bet-1');
  assert.equal(dbBet?.status, 'WON');
  assert.equal(dbBet?.payout, 20);
  assert.equal(bet.status, 'WON');
  assert.equal(financial.batchCalls.length, 1);
  assert.equal(financial.changeCalls.length, 0);
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(housePoolService.applyCalls[0].amount, -20);

  const user = prisma.getUser('user-1');
  assert.equal(user?.totalBets, 1);
  assert.equal(user?.totalWins, 1);
  assert.equal(user?.totalLosses, 0);
  assert.equal(user?.totalProfit, 10);

  assert.equal(settled.length, 1);
  assert.equal(settled[0].betId, 'bet-1');
  assert.equal(settled[0].payout, 20);
});

test('SettlementService.compensateUnsettledBets settles pending bets using snapshots', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-2',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-2',
    roundId: 'round-2',
    userId: 'user-2',
    amount: 5,
    multiplier: 3,
    status: 'PENDING',
    isPlayMode: false,
    targetRow: 10,
    targetTime: 5,
  });

  const financial = new FakeFinancialService();
  const housePoolService = new FakeHousePoolService();
  const snapshotService = new FakeSnapshotService();
  const roundStartTime = Date.now() - 10000;
  snapshotService.snapshots = [
    {
      roundId: 'round-2',
      timestamp: new Date(roundStartTime + 4800),
      price: 99,
      rowIndex: 8,
    },
    {
      roundId: 'round-2',
      timestamp: new Date(roundStartTime + 5200),
      price: 101,
      rowIndex: 12,
    },
  ];

  const activeBet: ServerBet = {
    id: 'bet-2',
    orderId: 'order-2',
    userId: 'user-2',
    amount: 5,
    multiplier: 3,
    targetRow: 10,
    targetTime: 5,
    placedAt: Date.now(),
    status: 'PENDING',
    isPlayMode: false,
  };

  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: housePoolService as any,
    snapshotService: snapshotService as any,
    asset: 'BTCUSDT',
    hitTolerance: 2,
    callbacks: {
      getActiveBet: (betId) => (betId === 'bet-2' ? activeBet : undefined),
    },
  });

  await service.compensateUnsettledBets('round-2', {
    elapsed: 9,
    currentRow: 0,
    currentPrice: 90,
    roundStartTime,
  });

  const dbBet = prisma.getBet('bet-2');
  assert.equal(dbBet?.status, 'WON');
  assert.equal(dbBet?.payout, 15);
  assert.equal(activeBet.status, 'WON');
  assert.equal(financial.changeCalls.length, 1);
  assert.equal(housePoolService.applyCalls.length, 1);
  assert.equal(housePoolService.applyCalls[0].amount, -15);
  assert.equal(snapshotService.calls.length, 1);

  const expectedStart = roundStartTime + (5 - HIT_TIME_TOLERANCE) * 1000;
  const expectedEnd = roundStartTime + (5 + HIT_TIME_TOLERANCE) * 1000;
  assert.equal(snapshotService.calls[0].windowStart.getTime(), expectedStart);
  assert.equal(snapshotService.calls[0].windowEnd.getTime(), expectedEnd);
});

test('SettlementService.resolveHitBySnapshots detects hits within the window', async () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const roundStartTime = 1000;
  const snapshots = [
    {
      roundId: 'round-hit',
      timestamp: new Date(roundStartTime + 4400),
      price: 100,
      rowIndex: 4,
    },
    {
      roundId: 'round-hit',
      timestamp: new Date(roundStartTime + 4700),
      price: 101,
      rowIndex: 6,
    },
  ];

  const result = await service.resolveHitBySnapshots({
    roundId: 'round-hit',
    roundStartTime,
    targetTime: 4.6,
    targetRow: 5,
    snapshots,
    fallbackSnapshot: {
      elapsed: 9,
      currentRow: 0,
      currentPrice: 90,
      roundStartTime,
    },
  });

  assert.equal(result.isWin, true);
  assert.equal(result.usedFallback, false);
  assert.equal(result.hitDetails?.hitRow, 6);
});

test('SettlementService.resolveHitBySnapshots returns misses when snapshots skip rows', async () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const roundStartTime = 2000;
  const snapshots = [
    {
      roundId: 'round-miss',
      timestamp: new Date(roundStartTime + 4500),
      price: 100,
      rowIndex: 1,
    },
    {
      roundId: 'round-miss',
      timestamp: new Date(roundStartTime + 4700),
      price: 101,
      rowIndex: 2,
    },
  ];

  const result = await service.resolveHitBySnapshots({
    roundId: 'round-miss',
    roundStartTime,
    targetTime: 4.6,
    targetRow: 10,
    snapshots,
    fallbackSnapshot: {
      elapsed: 9,
      currentRow: 0,
      currentPrice: 90,
      roundStartTime,
    },
  });

  assert.equal(result.isWin, false);
  assert.equal(result.usedFallback, false);
});

test('SettlementService.resolveHitBySnapshots falls back to end snapshot', async () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const roundStartTime = 3000;
  const result = await service.resolveHitBySnapshots({
    roundId: 'round-fallback',
    roundStartTime,
    targetTime: 1,
    targetRow: 2,
    snapshots: [],
    fallbackSnapshot: {
      elapsed: 1,
      currentRow: 2,
      currentPrice: 100,
      roundStartTime,
    },
  });

  assert.equal(result.isWin, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.hitDetails?.hitRow, 2);
});

test('SettlementService.calculatePayout guards invalid inputs', () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  assert.equal(service.calculatePayout(10, 2, false), 0);
  assert.equal(service.calculatePayout(Number.NaN, 2, true), 0);
});

test('SettlementService handles empty queue and reset/dispose', async () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  service.enqueue([]);
  service.resetQueue();
  service.dispose();

  assert.equal((service as any).settlementQueue.length, 0);
});

test('SettlementService.flushQueue times out when settling stalls', async () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  (service as any).settlementQueue = [{ bet: { id: 'x' }, isWin: false }];
  (service as any).isSettling = true;

  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ === 0 ? 0 : 40000);

  const result = await service.flushQueue();
  Date.now = originalNow;

  assert.equal(result, false);
});

test('SettlementService.countPendingBets returns 0 on errors', async () => {
  const prisma = new FakePrisma();
  prisma.bet.count = async () => {
    throw new Error('count failed');
  };

  const service = new SettlementService({
    prisma: prisma as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const count = await service.countPendingBets('round-error');
  assert.equal(count, 0);
});

test('SettlementService.scheduleRetry respects timers and limits', () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const timer = setTimeout(() => {}, 0);
  (service as any).settlementRetryTimers.set('round-timer', timer);
  service.scheduleRetry(
    'round-timer',
    { elapsed: 1, currentRow: 1, currentPrice: 1, roundStartTime: 0 },
    'reason'
  );
  assert.equal((service as any).settlementRetryTimers.size, 1);
  clearTimeout(timer);

  (service as any).settlementRetryAttempts.set('round-max', 3);
  service.scheduleRetry(
    'round-max',
    { elapsed: 1, currentRow: 1, currentPrice: 1, roundStartTime: 0 },
    'reason'
  );
  assert.equal((service as any).settlementRetryTimers.has('round-max'), false);
});

test('SettlementService.scheduleRetry triggers retry callback', () => {
  const service = new SettlementService({
    prisma: new FakePrisma() as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  const originalSetTimeout = global.setTimeout;
  let invoked = false;

  global.setTimeout = ((fn: () => void) => {
    fn();
    return 0 as any;
  }) as any;

  (service as any).retryPendingBets = async () => {
    invoked = true;
  };

  service.scheduleRetry(
    'round-callback',
    { elapsed: 1, currentRow: 1, currentPrice: 1, roundStartTime: 0 },
    'reason'
  );

  global.setTimeout = originalSetTimeout;
  assert.equal(invoked, true);
});

test('SettlementService processSettlementQueue skips missing bets', async () => {
  const prisma = new FakePrisma();
  const financial = new FakeFinancialService();
  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  service.enqueue([
    {
      bet: {
        id: 'bet-missing',
        orderId: 'order-missing',
        userId: 'user-missing',
        amount: 5,
        multiplier: 2,
        targetRow: 1,
        targetTime: 1,
        placedAt: Date.now(),
        status: 'PENDING',
        isPlayMode: false,
      },
      isWin: true,
    },
  ]);

  await service.flushQueue();
  assert.equal(financial.batchCalls.length, 0);
});

test('SettlementService retryPendingBets clears when none remain', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-clear',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-clear',
    roundId: 'round-clear',
    userId: 'user-clear',
    amount: 5,
    multiplier: 2,
    status: 'PENDING',
    isPlayMode: false,
    targetRow: 4,
    targetTime: 3,
  });
  prisma.forcedPendingCount = 0;

  const service = new SettlementService({
    prisma: prisma as any,
    financialService: new FakeFinancialService() as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  await (service as any).retryPendingBets(
    'round-clear',
    { elapsed: 3, currentRow: 4, currentPrice: 10, roundStartTime: Date.now() - 3000 },
    'test'
  );
  assert.equal((service as any).settlementRetryAttempts.size, 0);
});

test('SettlementService pays out play-mode wins', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-play',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-play',
    roundId: 'round-play',
    userId: 'user-play',
    amount: 10,
    multiplier: 2,
    status: 'PENDING',
    isPlayMode: true,
    targetRow: 5,
    targetTime: 1,
  });

  const financial = new FakeFinancialService();
  const housePoolService = new FakeHousePoolService();
  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: housePoolService as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  service.enqueue([
    {
      bet: {
        id: 'bet-play',
        orderId: 'order-play',
        userId: 'user-play',
        amount: 10,
        multiplier: 2,
        targetRow: 5,
        targetTime: 1,
        placedAt: Date.now(),
        status: 'PENDING',
        isPlayMode: true,
      },
      isWin: true,
    },
  ]);

  await service.flushQueue();

  assert.equal(financial.changeCalls.length, 1);
  assert.equal(financial.batchCalls.length, 0);
  assert.equal(housePoolService.applyCalls.length, 0);
});

test('SettlementService retries pending bets and clears retry state', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-retry',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-retry',
    roundId: 'round-retry',
    userId: 'user-retry',
    amount: 5,
    multiplier: 2,
    status: 'PENDING',
    isPlayMode: false,
    targetRow: 4,
    targetTime: 3,
  });

  const financial = new FakeFinancialService();
  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  (service as any).settlementRetryTimers.set('round-empty', setTimeout(() => {}, 0));
  (service as any).settlementRetryAttempts.set('round-empty', 1);
  await (service as any).retryPendingBets(
    'round-empty',
    { elapsed: 1, currentRow: 1, currentPrice: 10, roundStartTime: Date.now() - 1000 },
    'test'
  );
  assert.equal((service as any).settlementRetryTimers.size, 0);

  prisma.forcedPendingCount = 1;
  let scheduled = false;
  (service as any).scheduleRetry = () => {
    scheduled = true;
  };

  await (service as any).retryPendingBets(
    'round-retry',
    { elapsed: 3, currentRow: 4, currentPrice: 10, roundStartTime: Date.now() - 3000 },
    'test'
  );
  assert.equal(scheduled, true);
});

test('SettlementService retries after transient transaction failures', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({
    id: 'user-fail',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });
  prisma.seedBet({
    id: 'bet-fail',
    roundId: 'round-fail',
    userId: 'user-fail',
    amount: 5,
    multiplier: 2,
    status: 'PENDING',
    isPlayMode: false,
    targetRow: 5,
    targetTime: 2,
  });

  const financial = new FakeFinancialService();
  const service = new SettlementService({
    prisma: prisma as any,
    financialService: financial as any,
    housePoolService: new FakeHousePoolService() as any,
    snapshotService: new FakeSnapshotService() as any,
    asset: 'BTCUSDT',
    hitTolerance: 1,
  });

  prisma.failTransactions = 1;
  service.enqueue([
    {
      bet: {
        id: 'bet-fail',
        orderId: 'order-fail',
        userId: 'user-fail',
        amount: 5,
        multiplier: 2,
        targetRow: 5,
        targetTime: 2,
        placedAt: Date.now(),
        status: 'PENDING',
        isPlayMode: false,
      },
      isWin: true,
    },
  ]);

  await service.flushQueue();
  assert.equal(prisma.getBet('bet-fail')?.status, 'WON');
});
