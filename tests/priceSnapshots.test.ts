import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GET, __setPrismaLoaderForTest, normalizeAsset, resolvePriceSnapshots } from '../app/api/market/price-snapshots/route';

function assertNoProvablyFairFields(obj: unknown) {
  const json = JSON.stringify(obj);
  assert.equal(json.includes('serverSeed'), false);
  assert.equal(json.includes('clientSeed'), false);
  assert.equal(json.includes('commitHash'), false);
  assert.equal(json.includes('roundHash'), false);
}

type FakeRound = {
  id: string;
  asset: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  startPrice: unknown;
  endPrice: unknown | null;
};

type FakeSnapshot = {
  timestamp: Date;
  price: unknown;
  rowIndex: unknown;
};

function makeFakePrisma(args: {
  round: FakeRound | null;
  snapshots?: FakeSnapshot[];
  onArgs?: (calls: { findUnique?: any; findFirst?: any; findMany?: any }) => void;
}) {
  const calls: { findUnique?: any; findFirst?: any; findMany?: any } = {};

  const validateSelect = (queryArgs: any) => {
    const select = queryArgs?.select;
    if (!select) return;
    for (const bad of ['serverSeed', 'clientSeed', 'commitHash', 'roundHash']) {
      if (Object.prototype.hasOwnProperty.call(select, bad)) {
        throw new Error(`Provably-fair field must not be selected: ${bad}`);
      }
    }
  };

  const prisma = {
    round: {
      async findUnique(queryArgs: any) {
        calls.findUnique = queryArgs;
        validateSelect(queryArgs);
        return args.round;
      },
      async findFirst(queryArgs: any) {
        calls.findFirst = queryArgs;
        validateSelect(queryArgs);
        return args.round;
      },
    },
    priceSnapshot: {
      async findMany(queryArgs: any) {
        calls.findMany = queryArgs;
        validateSelect(queryArgs);
        return args.snapshots ?? [];
      },
    },
  };

  args.onArgs?.(calls);
  return { prisma, calls };
}

beforeEach(() => {
  // Default to a loader that fails loudly if a test forgets to set it.
  __setPrismaLoaderForTest(async () => {
    throw new Error('prismaLoader not set for test');
  });
});

test('schema.prisma: provably-fair fields removed', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  assert.equal(schema.includes('serverSeed'), false);
  assert.equal(schema.includes('clientSeed'), false);
  assert.equal(schema.includes('commitHash'), false);
  assert.equal(schema.includes('roundHash'), false);
});

test('normalizeAsset: accepts BTC, btc-usdt and defaults to BTCUSDT', () => {
  assert.equal(normalizeAsset(undefined), 'BTCUSDT');
  assert.equal(normalizeAsset(''), 'BTCUSDT');
  assert.equal(normalizeAsset('btc'), 'BTCUSDT');
  assert.equal(normalizeAsset('BTCUSDT'), 'BTCUSDT');
  assert.equal(normalizeAsset('btc-usdt'), 'BTCUSDT');
  assert.equal(normalizeAsset('BTC/USDT'), 'BTCUSDT');
});

test('resolvePriceSnapshots: returns null when no round exists', async () => {
  const { prisma } = makeFakePrisma({ round: null });
  const result = await resolvePriceSnapshots({ prisma: prisma as any, limit: 10 });
  assert.equal(result, null);
});

test('resolvePriceSnapshots: roundId path + timestamp filter -> stable output shape', async () => {
  const round: FakeRound = {
    id: 'r1',
    asset: 'BTCUSDT',
    status: 'RUNNING',
    startedAt: new Date(1000),
    endedAt: null,
    startPrice: '50000.25',
    endPrice: null,
  };

  const snapshots: FakeSnapshot[] = [
    { timestamp: new Date(1100), price: '50000.30', rowIndex: '6.5' },
    { timestamp: new Date(1200), price: '50000.35', rowIndex: '6.4' },
  ];

  const { prisma, calls } = makeFakePrisma({ round, snapshots });

  const result = await resolvePriceSnapshots({
    prisma: prisma as any,
    roundId: 'r1',
    limit: 2,
    from: 1050,
    to: 1300,
  });

  assert.ok(result);
  assert.equal(result.source, 'bybit');
  assert.equal(result.asset, 'BTCUSDT');
  assert.equal(result.round.id, 'r1');
  assert.equal(result.round.startedAt, 1000);
  assert.deepEqual(
    result.snapshots.map((s) => s.timestamp),
    [1100, 1200]
  );
  assert.equal(result.snapshots[0].price, 50000.3);
  assert.equal(result.snapshots[0].rowIndex, 6.5);
  assertNoProvablyFairFields(result);

  // Ensure we queried the right round id and applied timestamp filters.
  assert.equal(calls.findUnique?.where?.id, 'r1');
  assert.equal(calls.findMany?.where?.roundId, 'r1');
  assert.equal(calls.findMany?.where?.timestamp?.gte instanceof Date, true);
  assert.equal(calls.findMany?.where?.timestamp?.lte instanceof Date, true);
});

test('GET: rejects invalid query and does not touch prisma', async () => {
  __setPrismaLoaderForTest(async () => {
    throw new Error('should not load prisma on invalid query');
  });

  const res = await GET(new Request('http://localhost/api/market/price-snapshots?limit=0') as any);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

test('GET: returns 404 when no rounds exist', async () => {
  __setPrismaLoaderForTest(async () => {
    const { prisma } = makeFakePrisma({ round: null });
    return prisma as any;
  });

  const res = await GET(new Request('http://localhost/api/market/price-snapshots?asset=BTC') as any);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'No round found');
});

test('GET: returns round + snapshots and does not expose provably-fair fields', async () => {
  __setPrismaLoaderForTest(async () => {
    const { prisma } = makeFakePrisma({
      round: {
        id: 'r2',
        asset: 'BTCUSDT',
        status: 'BETTING',
        startedAt: new Date(2000),
        endedAt: null,
        startPrice: 51000,
        endPrice: null,
      },
      snapshots: [{ timestamp: new Date(2100), price: 51001, rowIndex: 6.49 }],
    });
    return prisma as any;
  });

  const res = await GET(new Request('http://localhost/api/market/price-snapshots?limit=10') as any);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.source, 'bybit');
  assert.equal(body.round.id, 'r2');
  assert.deepEqual(body.snapshots.length, 1);
  assert.equal(body.snapshots[0].timestamp, 2100);
  assertNoProvablyFairFields(body);
});

