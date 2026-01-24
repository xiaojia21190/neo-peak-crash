import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotService } from '../../../lib/game-engine/SnapshotService';

class FakePrisma {
  batches: any[][] = [];
  failNext = false;
  failFind = false;
  snapshotRows: any[] = [];
  findArgs: any = null;

  priceSnapshot = {
    createMany: async (args: any) => {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('createMany failed');
      }
      this.batches.push(args.data ?? []);
      return { count: (args.data ?? []).length };
    },
    findMany: async (args: any) => {
      this.findArgs = args;
      if (this.failFind) {
        throw new Error('findMany failed');
      }
      return this.snapshotRows;
    },
  };
}

test('SnapshotService buffers and flushes snapshots', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  service.bufferSnapshot({
    roundId: 'round-1',
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    currentPrice: 100,
    currentRow: 5,
  });

  await service.flushSnapshots();

  assert.equal(prisma.batches.length, 1);
  assert.equal(prisma.batches[0].length, 1);
});

test('SnapshotService backs off after failures', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  service.bufferSnapshot({
    roundId: 'round-2',
    elapsed: 2,
    roundStartTime: Date.now() - 2000,
    currentPrice: 110,
    currentRow: 6,
  });

  prisma.failNext = true;
  await service.flushSnapshots();

  const failures = (service as any).snapshotFlushFailures;
  const backoffUntil = (service as any).snapshotFlushBackoffUntil;
  const bufferSize = (service as any).priceSnapshotBuffer.length;

  assert.equal(failures, 1);
  assert.ok(backoffUntil > Date.now() - 10);
  assert.ok(bufferSize > 0);

  service.resetBuffer();
  assert.equal((service as any).priceSnapshotBuffer.length, 0);
});

test('SnapshotService skips duplicate snapshot indexes', () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  const now = Date.now();
  const roundStartTime = now - 1000;

  service.bufferSnapshot({
    roundId: 'round-dup',
    elapsed: 1,
    roundStartTime,
    currentPrice: 120,
    currentRow: 7,
  });

  service.bufferSnapshot({
    roundId: 'round-dup',
    elapsed: 1,
    roundStartTime,
    currentPrice: 120,
    currentRow: 7,
  });

  assert.equal((service as any).priceSnapshotBuffer.length, 1);
});

test('SnapshotService enforces buffer limits', () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  const originalLimit = process.env.MAX_SNAPSHOT_QUEUE;
  process.env.MAX_SNAPSHOT_QUEUE = '1';
  (service as any).snapshotFlushBackoffUntil = Date.now() + 10000;

  const now = Date.now();
  const roundStartTime = now - 1000;
  service.bufferSnapshot({
    roundId: 'round-limit',
    elapsed: 1,
    roundStartTime,
    currentPrice: 120,
    currentRow: 7,
  });
  service.bufferSnapshot({
    roundId: 'round-limit',
    elapsed: 2,
    roundStartTime,
    currentPrice: 121,
    currentRow: 8,
  });

  assert.equal((service as any).priceSnapshotBufferHead, 1);

  if (originalLimit === undefined) delete process.env.MAX_SNAPSHOT_QUEUE;
  else process.env.MAX_SNAPSHOT_QUEUE = originalLimit;
});

test('SnapshotService respects backoff and empty buffers', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  const emptyResult = await service.flushSnapshots();
  assert.equal(emptyResult, undefined);

  (service as any).snapshotFlushBackoffUntil = Date.now() + 10000;
  service.bufferSnapshot({
    roundId: 'round-backoff',
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    currentPrice: 120,
    currentRow: 7,
  });

  const backoffResult = await service.flushSnapshots();
  assert.equal(backoffResult, undefined);
});

test('SnapshotService returns the active flush promise', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);

  service.bufferSnapshot({
    roundId: 'round-flush',
    elapsed: 1,
    roundStartTime: Date.now() - 1000,
    currentPrice: 120,
    currentRow: 7,
  });

  const first = service.flushSnapshots();
  const second = service.flushSnapshots();

  assert.equal(first, second);
  await first;
});

test('SnapshotService.getSnapshotsInWindow returns normalized snapshots', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);
  const roundId = 'round-window';
  const windowStart = new Date(1000);
  const windowEnd = new Date(2000);

  prisma.snapshotRows = [
    {
      roundId,
      timestamp: new Date(1500),
      price: '100.5',
      rowIndex: '6.5',
    },
  ];

  const result = await service.getSnapshotsInWindow({ roundId, windowStart, windowEnd });
  assert.equal(result.length, 1);
  assert.equal(result[0].roundId, roundId);
  assert.equal(result[0].price, 100.5);
  assert.equal(result[0].rowIndex, 6.5);
  assert.equal(prisma.findArgs.where.roundId, roundId);
});

test('SnapshotService.getSnapshotsInWindow handles query failures', async () => {
  const prisma = new FakePrisma();
  const service = new SnapshotService(prisma as any);
  prisma.failFind = true;

  const result = await service.getSnapshotsInWindow({
    roundId: 'round-error',
    windowStart: new Date(0),
    windowEnd: new Date(1),
  });

  assert.deepEqual(result, []);
});
