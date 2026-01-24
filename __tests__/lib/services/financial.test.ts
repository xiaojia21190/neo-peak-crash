import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialService } from '../../../lib/services/financial';

type UserRow = {
  id: string;
  balance: number;
  playBalance: number;
};

class FakePrisma {
  users = new Map<string, UserRow>();
  transactions: any[] = [];
  calls: { findMany?: any; create?: any } = {};
  private nextTransactionId = 0;

  seedUser(row: UserRow) {
    this.users.set(row.id, { ...row });
  }

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return fn(this as any);
  }

  private applySelect(row: UserRow, select?: Record<string, any>): any {
    if (!select) return { ...row };
    const result: any = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) result[key] = (row as any)[key];
    }
    return result;
  }

  user = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const row = this.users.get(id);
      if (!row) return null;
      return this.applySelect(row, args?.select);
    },
    update: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) {
        const error: any = new Error('Missing where.id');
        error.code = 'P2025';
        throw error;
      }
      const row = this.users.get(id);
      if (!row) {
        const error: any = new Error(`User ${id} not found`);
        error.code = 'P2025';
        throw error;
      }

      const data = args?.data ?? {};
      for (const field of ['balance', 'playBalance']) {
        const update = data[field];
        if (update?.increment !== undefined) {
          row[field as 'balance' | 'playBalance'] += update.increment;
        } else if (typeof update === 'number') {
          row[field as 'balance' | 'playBalance'] = update;
        }
      }

      return this.applySelect(row, args?.select);
    },
    updateMany: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return { count: 0 };
      const row = this.users.get(id);
      if (!row) return { count: 0 };

      const where = args?.where ?? {};
      const balanceFilter = where.balance;
      const playBalanceFilter = where.playBalance;
      const field = balanceFilter ? 'balance' : playBalanceFilter ? 'playBalance' : null;
      const gteValue = field ? where[field]?.gte : undefined;

      if (field && typeof gteValue === 'number' && row[field] < gteValue) {
        return { count: 0 };
      }

      const data = args?.data ?? {};
      if (field && data[field]?.increment !== undefined) {
        row[field] += data[field].increment;
      }
      return { count: 1 };
    },
  };

  transaction = {
    findMany: async (args: any) => {
      this.calls.findMany = args;
      return [{ id: 'txn-1' }];
    },
    create: async (args: any) => {
      this.calls.create = args;
      this.nextTransactionId += 1;
      const id = `txn-${this.nextTransactionId}`;
      this.transactions.push({ id, ...(args?.data ?? {}) });
      return { id };
    },
  };
}

test('FinancialService.getBalance returns zero for anonymous users', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  const result = await service.getBalance('anon-1');
  assert.deepEqual(result, { balance: 0, playBalance: 0 });
});

test('FinancialService.getBalance returns null for missing users', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  const result = await service.getBalance('missing');
  assert.equal(result, null);
});

test('FinancialService.getBalance returns balances', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({ id: 'user-1', balance: 12.5, playBalance: 99 });
  const service = new FinancialService(prisma as any);

  const result = await service.getBalance('user-1');
  assert.deepEqual(result, { balance: 12.5, playBalance: 99 });
});

test('FinancialService.getTransactionHistory builds filters', async () => {
  const prisma = new FakePrisma();
  const service = new FinancialService(prisma as any);

  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date('2025-01-31T00:00:00Z');

  const result = await service.getTransactionHistory('user-1', {
    type: 'WIN',
    startDate,
    endDate,
    limit: 5,
  });

  assert.equal(result.length, 1);
  assert.equal(prisma.calls.findMany?.where?.userId, 'user-1');
  assert.equal(prisma.calls.findMany?.where?.type, 'WIN');
  assert.equal(prisma.calls.findMany?.where?.createdAt?.gte, startDate);
  assert.equal(prisma.calls.findMany?.where?.createdAt?.lte, endDate);
  assert.equal(prisma.calls.findMany?.take, 5);
});

test('FinancialService.changeBalance throws on insufficient balance', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({ id: 'user-1', balance: 5, playBalance: 0 });
  const service = new FinancialService(prisma as any);

  await assert.rejects(
    () =>
      service.changeBalance({
        userId: 'user-1',
        amount: -10,
        type: 'BET',
        isPlayMode: false,
      }),
    (err) => err instanceof Error && err.message === 'Insufficient balance'
  );
});

test('FinancialService.changeBalance debits balance correctly', async () => {
  const prisma = new FakePrisma();
  prisma.seedUser({ id: 'user-1', balance: 12.5, playBalance: 0 });
  const service = new FinancialService(prisma as any);

  const result = await service.changeBalance({
    userId: 'user-1',
    amount: -2,
    type: 'BET',
    isPlayMode: false,
    relatedBetId: 'bet-1',
  });

  assert.equal(result.balanceBefore, 12.5);
  assert.equal(result.balanceAfter, 10.5);
  assert.equal(prisma.users.get('user-1')?.balance, 10.5);
});
