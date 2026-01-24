import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HousePoolService,
  HousePoolConflictError,
  HousePoolNotInitializedError,
} from '../../../lib/services/HousePoolService';

type PoolRow = {
  asset: string;
  balance: number;
  version: number;
};

class FakePrisma {
  pools = new Map<string, PoolRow>();
  forceUpdateFail = false;

  housePool = {
    findUnique: async (args: any) => {
      const asset = args?.where?.asset as string | undefined;
      if (!asset) return null;
      const pool = this.pools.get(asset);
      if (!pool) return null;
      if (!args?.select) return { ...pool };
      const result: any = {};
      if (args.select.balance) result.balance = pool.balance;
      if (args.select.version) result.version = pool.version;
      return result;
    },
    create: async (args: any) => {
      const data = args?.data ?? {};
      if (this.pools.has(data.asset)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      const pool: PoolRow = {
        asset: data.asset,
        balance: data.balance,
        version: 0,
      };
      this.pools.set(pool.asset, pool);
      if (!args?.select) return { ...pool };
      const result: any = {};
      if (args.select.balance) result.balance = pool.balance;
      return result;
    },
    updateMany: async (args: any) => {
      if (this.forceUpdateFail) return { count: 0 };
      const where = args?.where ?? {};
      const data = args?.data ?? {};
      const asset = where.asset as string | undefined;
      if (!asset) return { count: 0 };
      const pool = this.pools.get(asset);
      if (!pool) return { count: 0 };
      if (where.version !== undefined && pool.version !== where.version) return { count: 0 };
      pool.balance += data.balance?.increment ?? 0;
      pool.version += data.version?.increment ?? 0;
      return { count: 1 };
    },
  };
}

test('HousePoolService.getBalance returns null when missing', async () => {
  const prisma = new FakePrisma();
  const service = new HousePoolService(prisma as any);

  const result = await service.getBalance('BTCUSDT');
  assert.equal(result, null);
});

test('HousePoolService validates asset and amount inputs', async () => {
  const prisma = new FakePrisma();
  const service = new HousePoolService(prisma as any);

  await assert.rejects(
    () => service.getBalance('   '),
    (err) => err instanceof Error && err.message.includes('Asset is required')
  );

  await assert.rejects(
    () => service.getBalance(123 as any),
    (err) => err instanceof Error && err.message.includes('Asset must be a string')
  );

  await assert.rejects(
    () => service.initialize('BTCUSDT', -1),
    (err) => err instanceof Error && err.message.includes('non-negative')
  );

  await assert.rejects(
    () => service.applyDelta({ asset: 'BTCUSDT', amount: 0 }, prisma as any),
    (err) => err instanceof Error && err.message.includes('non-zero')
  );

  await assert.rejects(
    () => service.applyDelta({ asset: 'BTCUSDT', amount: Number.NaN }, prisma as any),
    (err) => err instanceof Error && err.message.includes('finite')
  );
});

test('HousePoolService.initialize creates and is idempotent', async () => {
  const prisma = new FakePrisma();
  const service = new HousePoolService(prisma as any);

  const created = await service.initialize('BTCUSDT', 100.25);
  assert.equal(created, 100.25);
  assert.equal(prisma.pools.get('BTCUSDT')?.balance, 100.25);

  const existing = await service.initialize('BTCUSDT', 999);
  assert.equal(existing, 100.25);
  assert.equal(prisma.pools.get('BTCUSDT')?.balance, 100.25);
});

test('HousePoolService.getBalance normalizes Decimal-like balances', async () => {
  const prisma = new FakePrisma();
  const service = new HousePoolService(prisma as any);

  prisma.housePool.findUnique = async () => ({ balance: '9.25' });
  const stringBalance = await service.getBalance('BTCUSDT');
  assert.equal(stringBalance, 9.25);

  prisma.housePool.findUnique = async () => ({ balance: { toNumber: () => 12.5 } });
  const result = await service.getBalance('BTCUSDT');
  assert.equal(result, 12.5);

  prisma.housePool.findUnique = async () => ({
    balance: { toNumber: () => { throw new Error('bad'); } },
  });
  const fallback = await service.getBalance('BTCUSDT');
  assert.equal(fallback, 0);
});

test('HousePoolService.applyDelta updates balance and version', async () => {
  const prisma = new FakePrisma();
  prisma.pools.set('BTCUSDT', { asset: 'BTCUSDT', balance: 200, version: 0 });
  const service = new HousePoolService(prisma as any);

  const result = await service.applyDelta({ asset: 'BTCUSDT', amount: -20 }, prisma as any);
  assert.equal(result.balance, 180);
  assert.equal(result.version, 1);
  assert.equal(prisma.pools.get('BTCUSDT')?.balance, 180);
  assert.equal(prisma.pools.get('BTCUSDT')?.version, 1);
});

test('HousePoolService.applyDelta retries optimistic lock conflicts', async () => {
  const prisma = new FakePrisma();
  prisma.pools.set('BTCUSDT', { asset: 'BTCUSDT', balance: 200, version: 0 });
  const service = new HousePoolService(prisma as any);

  let updateCalls = 0;
  const originalUpdateMany = prisma.housePool.updateMany;
  prisma.housePool.updateMany = async (args: any) => {
    updateCalls += 1;
    prisma.forceUpdateFail = updateCalls === 1;
    return originalUpdateMany(args);
  };

  const result = await service.applyDelta({ asset: 'BTCUSDT', amount: 10 }, prisma as any);
  assert.equal(updateCalls, 2);
  assert.equal(result.balance, 210);
  assert.equal(result.version, 1);
  assert.equal(prisma.pools.get('BTCUSDT')?.balance, 210);
  assert.equal(prisma.pools.get('BTCUSDT')?.version, 1);
});

test('HousePoolService.applyDelta throws on conflicts', async () => {
  const prisma = new FakePrisma();
  prisma.pools.set('BTCUSDT', { asset: 'BTCUSDT', balance: 50, version: 0 });
  prisma.forceUpdateFail = true;
  const service = new HousePoolService(prisma as any);

  await assert.rejects(
    () => service.applyDelta({ asset: 'BTCUSDT', amount: 10 }, prisma as any),
    (err) => err instanceof HousePoolConflictError
  );
});

test('HousePoolService.applyDelta throws when pool missing', async () => {
  const prisma = new FakePrisma();
  const service = new HousePoolService(prisma as any);

  await assert.rejects(
    () => service.applyDelta({ asset: 'BTCUSDT', amount: 10 }, prisma as any),
    (err) => err instanceof HousePoolNotInitializedError
  );
});
