/**
 * Market price snapshots API
 *
 * Transparent read-only endpoint for real-time-ish price history.
 * Data source: Bybit stream ingested by the game server and persisted as PriceSnapshot rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

type RoundRow = {
  id: string;
  asset: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  startPrice: unknown;
  endPrice: unknown | null;
};

type SnapshotRow = {
  timestamp: Date;
  price: unknown;
  rowIndex: unknown;
};

export type PriceSnapshotsResponse = {
  asset: string;
  source: 'bybit';
  round: {
    id: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    startPrice: number;
    endPrice: number | null;
  };
  snapshots: Array<{
    timestamp: number;
    price: number;
    rowIndex: number;
  }>;
};

const QuerySchema = z.object({
  asset: z.string().optional(),
  roundId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export function normalizeAsset(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'BTCUSDT';

  // Accept "BTC", "btc-usdt", "BTC/USDT" etc.
  const compact = trimmed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (compact.endsWith('USDT')) return compact;
  return `${compact}USDT`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (value && typeof value === 'object') {
    const anyValue = value as { toNumber?: () => number; toString?: () => string };
    if (typeof anyValue.toNumber === 'function') return anyValue.toNumber();
    if (typeof anyValue.toString === 'function') return Number(anyValue.toString());
  }
  return Number(value);
}

export async function resolvePriceSnapshots(args: {
  prisma: {
    round: {
      findUnique: (args: unknown) => Promise<RoundRow | null>;
      findFirst: (args: unknown) => Promise<RoundRow | null>;
    };
    priceSnapshot: {
      findMany: (args: unknown) => Promise<SnapshotRow[]>;
    };
  };
  asset?: string;
  roundId?: string;
  limit: number;
  from?: number;
  to?: number;
}): Promise<PriceSnapshotsResponse | null> {
  const { prisma, roundId, limit } = args;
  const asset = normalizeAsset(args.asset);

  const round = roundId
    ? await prisma.round.findUnique({
        where: { id: roundId },
        select: {
          id: true,
          asset: true,
          status: true,
          startedAt: true,
          endedAt: true,
          startPrice: true,
          endPrice: true,
        },
      } as any)
    : await prisma.round.findFirst({
        where: { asset },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          asset: true,
          status: true,
          startedAt: true,
          endedAt: true,
          startPrice: true,
          endPrice: true,
        },
      } as any);

  if (!round) return null;

  const timestampFilter: Record<string, Date> = {};
  if (Number.isFinite(args.from)) timestampFilter.gte = new Date(args.from!);
  if (Number.isFinite(args.to)) timestampFilter.lte = new Date(args.to!);

  const snapshots = await prisma.priceSnapshot.findMany({
    where: {
      roundId: round.id,
      ...(Object.keys(timestampFilter).length > 0 ? { timestamp: timestampFilter } : null),
    },
    orderBy: { timestamp: 'asc' },
    take: limit,
    select: {
      timestamp: true,
      price: true,
      rowIndex: true,
    },
  } as any);

  return {
    asset: round.asset,
    source: 'bybit',
    round: {
      id: round.id,
      status: round.status,
      startedAt: round.startedAt.getTime(),
      endedAt: round.endedAt ? round.endedAt.getTime() : null,
      startPrice: toNumber(round.startPrice),
      endPrice: round.endPrice == null ? null : toNumber(round.endPrice),
    },
    snapshots: snapshots.map((s) => ({
      timestamp: s.timestamp.getTime(),
      price: toNumber(s.price),
      rowIndex: toNumber(s.rowIndex),
    })),
  };
}

async function loadPrisma() {
  // Lazy import so unit tests can import this module without a configured DATABASE_URL.
  const mod = await import('@/lib/prisma');
  return mod.default;
}

let prismaLoader: () => Promise<unknown> = loadPrisma;

// Test seam (kept tiny and isolated).
export function __setPrismaLoaderForTest(loader: () => Promise<unknown>) {
  prismaLoader = loader;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const prisma = await prismaLoader();
    const data = await resolvePriceSnapshots({
      prisma: prisma as any,
      asset: parsed.data.asset,
      roundId: parsed.data.roundId,
      limit: parsed.data.limit,
      from: parsed.data.from,
      to: parsed.data.to,
    });

    if (!data) {
      return NextResponse.json({ error: 'No round found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[price-snapshots] GET failed:', error);
    return NextResponse.json({ error: 'Failed to load price snapshots' }, { status: 500 });
  }
}
