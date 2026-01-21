import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialService } from '../lib/services/financial';

function toCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100) * Math.sign(amount);
}

function fromCents(cents: number): number {
  return cents / 100;
}

async function microYield(): Promise<void> {
  await Promise.resolve();
}

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

type UserRow = {
  id: string;
  balanceCents: number;
  playBalanceCents: number;
};

type TransactionRow = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  status: string;
  balanceBefore: number;
  balanceAfter: number;
  relatedBetId?: string;
  orderNo?: string;
  tradeNo?: string;
  remark?: string;
  completedAt?: Date;
};

class FakePrisma {
  private users = new Map<string, UserRow>();
  private transactionsById = new Map<string, TransactionRow>();
  private orderNoToId = new Map<string, string>();
  private userLocks = new Map<string, Mutex>();
  private orderLocks = new Map<string, Mutex>();
  private nextTransactionId = 0;

  seedUser(id: string, balance: number, playBalance: number) {
    this.users.set(id, {
      id,
      balanceCents: toCents(balance),
      playBalanceCents: toCents(playBalance),
    });
  }

  seedRechargeOrder(params: { id?: string; orderNo: string; userId: string; amount: number; status?: string }) {
    const id = params.id ?? this.newTransactionId();
    const row: TransactionRow = {
      id,
      userId: params.userId,
      type: 'RECHARGE',
      amount: params.amount,
      status: params.status ?? 'PENDING',
      balanceBefore: 0,
      balanceAfter: 0,
      orderNo: params.orderNo,
    };
    this.transactionsById.set(id, row);
    this.orderNoToId.set(params.orderNo, id);
  }

  getUser(id: string): UserRow | undefined {
    return this.users.get(id);
  }

  getTransactions(): TransactionRow[] {
    return Array.from(this.transactionsById.values());
  }

  private newTransactionId(): string {
    this.nextTransactionId += 1;
    return `txn-${this.nextTransactionId}`;
  }

  private getUserMutex(id: string): Mutex {
    const existing = this.userLocks.get(id);
    if (existing) return existing;
    const created = new Mutex();
    this.userLocks.set(id, created);
    return created;
  }

  private getOrderMutex(orderNo: string): Mutex {
    const existing = this.orderLocks.get(orderNo);
    if (existing) return existing;
    const created = new Mutex();
    this.orderLocks.set(orderNo, created);
    return created;
  }

  async $transaction<T>(fn: (tx: FakeTxClient) => Promise<T>): Promise<T> {
    const tx = new FakeTxClient(this);
    try {
      const result = await fn(tx);
      tx.commit();
      return result;
    } catch (error) {
      tx.rollback();
      throw error;
    }
  }

  // Internal helpers used by FakeTxClient
  _readUser(id: string): UserRow | undefined {
    return this.users.get(id);
  }

  _writeUser(row: UserRow) {
    this.users.set(row.id, row);
  }

  _findTransactionByOrderNo(orderNo: string): TransactionRow | undefined {
    const id = this.orderNoToId.get(orderNo);
    return id ? this.transactionsById.get(id) : undefined;
  }

  _findTransactionById(id: string): TransactionRow | undefined {
    return this.transactionsById.get(id);
  }

  _upsertTransaction(row: TransactionRow) {
    this.transactionsById.set(row.id, row);
    if (row.orderNo) this.orderNoToId.set(row.orderNo, row.id);
  }

  _getUserLock(id: string): Promise<() => void> {
    return this.getUserMutex(id).acquire();
  }

  _getOrderLock(orderNo: string): Promise<() => void> {
    return this.getOrderMutex(orderNo).acquire();
  }

  _newTransactionId(): string {
    return this.newTransactionId();
  }
}

class FakeTxClient {
  private userSnapshots = new Map<string, UserRow>();
  private orderSnapshots = new Map<string, TransactionRow>();
  private createdTransactions: TransactionRow[] = [];
  private acquiredUserUnlocks = new Map<string, () => void>();
  private acquiredOrderUnlocks = new Map<string, () => void>();
  private committedOrRolledBack = false;

  constructor(private root: FakePrisma) {}

  private async ensureUserLocked(userId: string): Promise<UserRow> {
    if (!this.acquiredUserUnlocks.has(userId)) {
      const unlock = await this.root._getUserLock(userId);
      this.acquiredUserUnlocks.set(userId, unlock);
    }

    const snapshot = this.userSnapshots.get(userId);
    if (snapshot) return snapshot;

    const existing = this.root._readUser(userId);
    if (!existing) {
      throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    }

    const cloned: UserRow = { ...existing };
    this.userSnapshots.set(userId, cloned);
    return cloned;
  }

  private async ensureOrderLocked(orderNo: string): Promise<TransactionRow | undefined> {
    if (!this.acquiredOrderUnlocks.has(orderNo)) {
      const unlock = await this.root._getOrderLock(orderNo);
      this.acquiredOrderUnlocks.set(orderNo, unlock);
    }

    const existingSnapshot = this.orderSnapshots.get(orderNo);
    if (existingSnapshot) return existingSnapshot;

    const existing = this.root._findTransactionByOrderNo(orderNo);
    if (!existing) return undefined;

    const cloned: TransactionRow = { ...existing };
    this.orderSnapshots.set(orderNo, cloned);
    return cloned;
  }

  commit() {
    if (this.committedOrRolledBack) return;
    this.committedOrRolledBack = true;

    for (const row of this.userSnapshots.values()) {
      this.root._writeUser(row);
    }

    for (const order of this.orderSnapshots.values()) {
      this.root._upsertTransaction(order);
    }

    for (const created of this.createdTransactions) {
      this.root._upsertTransaction(created);
    }

    for (const unlock of this.acquiredOrderUnlocks.values()) unlock();
    for (const unlock of this.acquiredUserUnlocks.values()) unlock();
  }

  rollback() {
    if (this.committedOrRolledBack) return;
    this.committedOrRolledBack = true;
    for (const unlock of this.acquiredOrderUnlocks.values()) unlock();
    for (const unlock of this.acquiredUserUnlocks.values()) unlock();
  }

  user = {
    findUnique: async (args: any) => {
      await microYield();
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');

      const local = this.userSnapshots.get(id);
      const existing = local ?? this.root._readUser(id);
      if (!existing) return null;

      if (!args.select) {
        return {
          id: existing.id,
          balance: fromCents(existing.balanceCents),
          playBalance: fromCents(existing.playBalanceCents),
        };
      }

      const result: any = {};
      if (args.select.id) result.id = existing.id;
      if (args.select.balance) result.balance = fromCents(existing.balanceCents);
      if (args.select.playBalance) result.playBalance = fromCents(existing.playBalanceCents);
      return result;
    },

    update: async (args: any) => {
      await microYield();
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');

      const row = await this.ensureUserLocked(id);

      if (args.data?.balance?.increment !== undefined) {
        const deltaCents = toCents(Number(args.data.balance.increment));
        row.balanceCents += deltaCents;
      }

      if (args.data?.playBalance?.increment !== undefined) {
        const deltaCents = toCents(Number(args.data.playBalance.increment));
        row.playBalanceCents += deltaCents;
      }

      if (args.data?.playBalance !== undefined && typeof args.data.playBalance === 'number') {
        row.playBalanceCents = toCents(args.data.playBalance);
      }

      const select = args.select ?? {};
      const result: any = {};
      if (select.balance) result.balance = fromCents(row.balanceCents);
      if (select.playBalance) result.playBalance = fromCents(row.playBalanceCents);

      // Computed selects like { [balanceField]: true }
      for (const [key, value] of Object.entries(select)) {
        if (!value) continue;
        if (key === 'balance') continue;
        if (key === 'playBalance') continue;
        if (key === 'id') result.id = row.id;
      }

      return result;
    },

    updateMany: async (args: any) => {
      await microYield();
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');

      // If user doesn't exist, behave like prisma: updateMany count=0 (no error)
      const existsGlobal = this.root._readUser(id);
      if (!existsGlobal) {
        return { count: 0 };
      }

      const row = await this.ensureUserLocked(id);

      const where = args.where ?? {};
      const data = args.data ?? {};

      const balanceGate = where.balance?.gte !== undefined ? toCents(Number(where.balance.gte)) : undefined;
      const playBalanceGate = where.playBalance?.gte !== undefined ? toCents(Number(where.playBalance.gte)) : undefined;

      if (balanceGate !== undefined && row.balanceCents < balanceGate) return { count: 0 };
      if (playBalanceGate !== undefined && row.playBalanceCents < playBalanceGate) return { count: 0 };

      if (data.balance?.increment !== undefined) {
        row.balanceCents += toCents(Number(data.balance.increment));
      }
      if (data.playBalance?.increment !== undefined) {
        row.playBalanceCents += toCents(Number(data.playBalance.increment));
      }

      return { count: 1 };
    },
  };

  transaction = {
    findUnique: async (args: any) => {
      await microYield();
      const orderNo = args?.where?.orderNo as string | undefined;
      if (!orderNo) throw new Error('Missing where.orderNo');

      const local = this.orderSnapshots.get(orderNo);
      const existing = local ?? this.root._findTransactionByOrderNo(orderNo);
      return existing ? { ...existing } : null;
    },

    findMany: async (args: any) => {
      await microYield();
      const whereUserId = args?.where?.userId as string | undefined;
      const items = this.root
        .getTransactions()
        .filter((t) => (whereUserId ? t.userId === whereUserId : true))
        .sort((a, b) => a.id.localeCompare(b.id));
      return items;
    },

    create: async (args: any) => {
      await microYield();
      const data = args?.data ?? {};
      const id = this.root._newTransactionId();
      const row: TransactionRow = {
        id,
        userId: String(data.userId),
        type: String(data.type),
        amount: Number(data.amount),
        status: String(data.status ?? 'COMPLETED'),
        balanceBefore: Number(data.balanceBefore ?? 0),
        balanceAfter: Number(data.balanceAfter ?? 0),
        relatedBetId: data.relatedBetId ?? undefined,
        orderNo: data.orderNo ?? undefined,
        tradeNo: data.tradeNo ?? undefined,
        remark: data.remark ?? undefined,
        completedAt: data.completedAt ?? undefined,
      };
      this.createdTransactions.push(row);
      if (row.orderNo) this.orderSnapshots.set(row.orderNo, { ...row });
      return { id };
    },

    updateMany: async (args: any) => {
      await microYield();
      const orderNo = args?.where?.orderNo as string | undefined;
      if (!orderNo) throw new Error('Missing where.orderNo');

      const whereStatus = args?.where?.status as string | undefined;
      const data = args?.data ?? {};

      const order = await this.ensureOrderLocked(orderNo);
      if (!order) return { count: 0 };

      if (whereStatus && order.status !== whereStatus) return { count: 0 };

      if (data.status !== undefined) order.status = String(data.status);
      if (data.tradeNo !== undefined) order.tradeNo = String(data.tradeNo);
      if (data.balanceBefore !== undefined) order.balanceBefore = Number(data.balanceBefore);
      if (data.balanceAfter !== undefined) order.balanceAfter = Number(data.balanceAfter);
      if (data.completedAt !== undefined) order.completedAt = data.completedAt as Date;

      return { count: 1 };
    },
  };
}

test('FinancialService.changeBalance: atomic before/after and ledger entry', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 500, 1000);

  const service = new FinancialService(prisma as any);
  const result = await service.changeBalance({
    userId: 'user-1',
    amount: 100,
    type: 'RECHARGE',
    isPlayMode: false,
  });

  assert.equal(result.balanceBefore, 500);
  assert.equal(result.balanceAfter, 600);
  assert.ok(result.transactionId);

  const user = prisma.getUser('user-1');
  assert.equal(fromCents(user!.balanceCents), 600);

  const txn = prisma.getTransactions().find((t) => t.id === result.transactionId);
  assert.equal(txn?.type, 'RECHARGE');
  assert.equal(txn?.balanceBefore, 500);
  assert.equal(txn?.balanceAfter, 600);
});

test('FinancialService.changeBalance: play mode skips ledger', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 1000);

  const service = new FinancialService(prisma as any);
  const result = await service.changeBalance({
    userId: 'user-1',
    amount: 50,
    type: 'WIN',
    isPlayMode: true,
  });

  assert.equal(result.balanceBefore, 1000);
  assert.equal(result.balanceAfter, 1050);
  assert.equal(result.transactionId, undefined);

  assert.equal(prisma.getTransactions().length, 0);
  assert.equal(fromCents(prisma.getUser('user-1')!.playBalanceCents), 1050);
});

test('FinancialService.changeBalance: anonymous user rules', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  const play = await service.changeBalance({
    userId: 'anon-1',
    amount: 10,
    type: 'WIN',
    isPlayMode: true,
  });
  assert.deepEqual(play, { balanceBefore: 0, balanceAfter: 0 });

  await assert.rejects(
    () =>
      service.changeBalance({
        userId: 'anon-1',
        amount: 10,
        type: 'RECHARGE',
        isPlayMode: false,
      }),
    /Anonymous users can only use play mode/
  );
});

test('FinancialService.conditionalChangeBalance: enforces sufficient balance', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 100, 0);

  const service = new FinancialService(prisma as any);

  const ok = await service.conditionalChangeBalance({
    userId: 'user-1',
    amount: -50,
    type: 'BET',
    isPlayMode: false,
  });
  assert.equal(ok.success, true);
  assert.equal(ok.result?.balanceBefore, 100);
  assert.equal(ok.result?.balanceAfter, 50);

  const bad = await service.conditionalChangeBalance({
    userId: 'user-1',
    amount: -100,
    type: 'BET',
    isPlayMode: false,
  });
  assert.equal(bad.success, false);
  assert.equal(bad.error, 'Insufficient balance');

  assert.equal(fromCents(prisma.getUser('user-1')!.balanceCents), 50);
});

test('FinancialService.batchChangeBalance: updates once and writes per-change ledger', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 1000, 0);

  const service = new FinancialService(prisma as any);
  const result = await service.batchChangeBalance({
    userId: 'user-1',
    isPlayMode: false,
    changes: [
      { amount: 100, type: 'WIN', relatedBetId: 'bet-1', remark: 'Win 1' },
      { amount: 200, type: 'WIN', relatedBetId: 'bet-2', remark: 'Win 2' },
      { amount: 150, type: 'WIN', relatedBetId: 'bet-3', remark: 'Win 3' },
    ],
  });

  assert.equal(result.balanceBefore, 1000);
  assert.equal(result.balanceAfter, 1450);
  assert.equal(result.transactionIds.length, 3);

  const created = result.transactionIds.map((id) => prisma.getTransactions().find((t) => t.id === id)!);
  const byBefore = created.slice().sort((a, b) => a.balanceBefore - b.balanceBefore);
  assert.deepEqual(
    byBefore.map((t) => [t.balanceBefore, t.balanceAfter]),
    [
      [1000, 1100],
      [1100, 1300],
      [1300, 1450],
    ]
  );
});

test('FinancialService: normalizes empty relatedBetId to undefined', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 10, 0);

  const service = new FinancialService(prisma as any);
  const result = await service.changeBalance({
    userId: 'user-1',
    amount: -1,
    type: 'BET',
    isPlayMode: false,
    relatedBetId: '',
  });

  const txn = prisma.getTransactions().find((t) => t.id === result.transactionId)!;
  assert.equal(txn.relatedBetId, undefined);
});

test('FinancialService.completeRechargeOrder: idempotent under concurrency', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 0);
  prisma.seedRechargeOrder({ orderNo: 'ord-1', userId: 'user-1', amount: 10, status: 'PENDING' });

  const service = new FinancialService(prisma as any);

  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      service.completeRechargeOrder({ orderNo: 'ord-1', tradeNo: 'trade-1', amount: 10 })
    )
  );

  assert.equal(fromCents(prisma.getUser('user-1')!.balanceCents), 10);

  const processedCount = results.filter((r) => r.processed).length;
  assert.equal(processedCount, 1);

  const order = prisma.getTransactions().find((t) => t.orderNo === 'ord-1')!;
  assert.equal(order.status, 'COMPLETED');
  assert.equal(order.tradeNo, 'trade-1');
  assert.equal(order.balanceBefore, 0);
  assert.equal(order.balanceAfter, 10);
});

test('FinancialService: 100+ concurrent credits keep balances consistent', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 0);

  const service = new FinancialService(prisma as any);
  const concurrency = 120;

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      service.changeBalance({
        userId: 'user-1',
        amount: 1,
        type: 'WIN',
        isPlayMode: false,
        relatedBetId: `bet-${i}`,
      })
    )
  );

  assert.equal(fromCents(prisma.getUser('user-1')!.balanceCents), concurrency);

  const txns = prisma.getTransactions().filter((t) => t.type === 'WIN');
  assert.equal(txns.length, concurrency);

  const sorted = txns.slice().sort((a, b) => a.balanceAfter - b.balanceAfter);
  assert.equal(sorted[0]!.balanceBefore, 0);
  assert.equal(sorted[0]!.balanceAfter, 1);
  assert.equal(sorted[sorted.length - 1]!.balanceAfter, concurrency);

  for (const t of sorted) {
    assert.equal(toCents(t.balanceAfter - t.balanceBefore), 100);
  }
});

test('FinancialService: concurrent conditional debits never overdraw', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 50, 0);

  const service = new FinancialService(prisma as any);
  const attempts = 100;

  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      service.conditionalChangeBalance({
        userId: 'user-1',
        amount: -1,
        type: 'BET',
        isPlayMode: false,
      })
    )
  );

  const successes = results.filter((r) => r.success).length;
  assert.equal(successes, 50);
  assert.equal(fromCents(prisma.getUser('user-1')!.balanceCents), 0);
});

test('FinancialService.setPlayBalance: sets exact value', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 123.45);

  const service = new FinancialService(prisma as any);
  const updated = await service.setPlayBalance('user-1', 10000);

  assert.equal(updated, 10000);
  assert.equal(fromCents(prisma.getUser('user-1')!.playBalanceCents), 10000);
});

test('FinancialService.changeBalance: throws when user missing (P2025)', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  await assert.rejects(
    () =>
      service.changeBalance({
        userId: 'missing-user',
        amount: 1,
        type: 'WIN',
        isPlayMode: false,
      }),
    /User missing-user not found/
  );
});

test('FinancialService.changeBalance: supports explicit tx client (nested transaction)', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 10, 0);
  const service = new FinancialService(prisma as any);

  await prisma.$transaction(async (tx) => {
    const result = await service.changeBalance(
      {
        userId: 'user-1',
        amount: -2,
        type: 'BET',
        isPlayMode: false,
      },
      tx as any
    );
    assert.equal(result.balanceBefore, 10);
    assert.equal(result.balanceAfter, 8);
  });

  assert.equal(fromCents(prisma.getUser('user-1')!.balanceCents), 8);
});

test('FinancialService.completeRechargeOrder: amount mismatch rejects', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 0);
  prisma.seedRechargeOrder({ orderNo: 'ord-1', userId: 'user-1', amount: 10, status: 'PENDING' });

  const service = new FinancialService(prisma as any);
  await assert.rejects(
    () => service.completeRechargeOrder({ orderNo: 'ord-1', tradeNo: 'trade-1', amount: 9.99 }),
    /Amount mismatch/
  );
});

test('FinancialService.conditionalChangeBalance: positive amount delegates to changeBalance', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser('user-1', 0, 0);

  const service = new FinancialService(prisma as any);
  const result = await service.conditionalChangeBalance({
    userId: 'user-1',
    amount: 10,
    type: 'WIN',
    isPlayMode: false,
  });

  assert.equal(result.success, true);
  assert.equal(result.result?.balanceBefore, 0);
  assert.equal(result.result?.balanceAfter, 10);
});

test('FinancialService.setPlayBalance: missing user throws', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  await assert.rejects(() => service.setPlayBalance('missing-user', 10000), /User missing-user not found/);
});
