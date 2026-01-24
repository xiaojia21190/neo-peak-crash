import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_ROUND_CONFIG } from '../lib/game-engine/constants';
import { calculateRowIndex } from '../lib/game-engine/utils';
import { calculateMultiplier, CENTER_ROW_INDEX } from '../lib/shared/gameMath';

type PricePoint = {
  timestamp: number;
  price: number;
};

type Args = {
  file?: string;
  symbol: string;
  interval: string;
  limit: number;
  durationSec: number;
};

function parseArgs(argv: string[]): Args {
  const getValue = (flag: string): string | undefined => {
    const exactIndex = argv.indexOf(flag);
    if (exactIndex !== -1) return argv[exactIndex + 1];
    const prefix = `${flag}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };

  return {
    file: getValue('--file'),
    symbol: getValue('--symbol') ?? 'BTCUSDT',
    interval: getValue('--interval') ?? '1m',
    limit: Number(getValue('--limit') ?? '1000'),
    durationSec: Number(getValue('--duration') ?? `${DEFAULT_ROUND_CONFIG.maxDuration}`),
  };
}

function parseCsv(filePath: string): PricePoint[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0]!.split(',');
  const hasHeader = header.some((col) => /time|timestamp|date/i.test(col));
  const timeIndex = hasHeader ? header.findIndex((col) => /time|timestamp|date/i.test(col)) : 0;
  const priceIndex = hasHeader ? header.findIndex((col) => /close|price/i.test(col)) : 1;
  const startIndex = hasHeader ? 1 : 0;

  const points: PricePoint[] = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const parts = lines[i]!.split(',');
    const rawTime = parts[timeIndex] ?? parts[0];
    const rawPrice = parts[priceIndex] ?? parts[1];
    const timestamp = Number(rawTime);
    const price = Number(rawPrice);
    if (!Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
    points.push({ timestamp, price });
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<PricePoint[]> {
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as Array<[number, string, string, string, string]>;
  return data.map((row) => ({
    timestamp: row[0],
    price: Number(row[4]),
  }));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function buildDistribution(points: PricePoint[], durationSec: number) {
  if (points.length < 2) {
    throw new Error('Not enough data points for backtest.');
  }

  const deltas = points.slice(1).map((point, idx) => point.timestamp - points[idx]!.timestamp);
  const stepMs = Math.max(1000, median(deltas));
  const stepSec = stepMs / 1000;
  const samplesPerRound = Math.floor((durationSec * 1000) / stepMs);
  const totalRounds = Math.floor((points.length - 1) / samplesPerRound);

  const offsetTotals = new Map<number, number>();
  const offsetRowCounts = new Map<number, Map<number, number>>();
  const rowTotals = new Map<number, number>();

  for (let round = 0; round < totalRounds; round += 1) {
    const startIndex = round * samplesPerRound;
    const startPrice = points[startIndex]!.price;
    for (let offset = 1; offset <= samplesPerRound; offset += 1) {
      const idx = startIndex + offset;
      if (idx >= points.length) break;
      const rowIndex = Math.round(calculateRowIndex(points[idx]!.price, startPrice));
      const total = offsetTotals.get(offset) ?? 0;
      offsetTotals.set(offset, total + 1);

      const rowMap = offsetRowCounts.get(offset) ?? new Map<number, number>();
      rowMap.set(rowIndex, (rowMap.get(rowIndex) ?? 0) + 1);
      offsetRowCounts.set(offset, rowMap);

      rowTotals.set(rowIndex, (rowTotals.get(rowIndex) ?? 0) + 1);
    }
  }

  return {
    stepSec,
    totalRounds,
    offsetTotals,
    offsetRowCounts,
    rowTotals,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function summarizeDistribution(params: {
  stepSec: number;
  totalRounds: number;
  offsetTotals: Map<number, number>;
  offsetRowCounts: Map<number, Map<number, number>>;
  rowTotals: Map<number, number>;
}) {
  const { stepSec, totalRounds, offsetTotals, offsetRowCounts, rowTotals } = params;

  const rowSummary = Array.from(rowTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  let minEdge = Number.POSITIVE_INFINITY;
  let maxEdge = Number.NEGATIVE_INFINITY;
  let totalEdge = 0;
  let edgeCount = 0;

  for (const [offset, total] of offsetTotals.entries()) {
    const rowMap = offsetRowCounts.get(offset);
    if (!rowMap) continue;
    let bestReturn = 0;
    let expectedReturn = 0;
    for (const [row, count] of rowMap.entries()) {
      const prob = count / total;
      const multiplier = calculateMultiplier(row, CENTER_ROW_INDEX, offset * stepSec);
      const expected = prob * multiplier;
      expectedReturn += expected;
      if (expected > bestReturn) bestReturn = expected;
    }
    const edge = 1 - bestReturn;
    minEdge = Math.min(minEdge, edge);
    maxEdge = Math.max(maxEdge, edge);
    totalEdge += 1 - expectedReturn;
    edgeCount += 1;
  }

  console.log('Backtest Summary');
  console.log(`Rounds evaluated: ${totalRounds}`);
  console.log(`Step size: ${stepSec}s`);
  console.log('');
  console.log('Crash row distribution (top 10 rows):');
  for (const [row, count] of rowSummary) {
    console.log(`  row ${row}: ${count}`);
  }
  console.log('');
  console.log(`Best-case house edge (min): ${formatPercent(minEdge)}`);
  console.log(`Best-case house edge (max): ${formatPercent(maxEdge)}`);
  console.log(`Average edge (by offset): ${formatPercent(totalEdge / Math.max(1, edgeCount))}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = args.file
    ? parseCsv(resolve(args.file))
    : await fetchBinanceKlines(args.symbol, args.interval, args.limit);

  if (data.length === 0) {
    throw new Error('No price data loaded.');
  }

  const distribution = buildDistribution(data, args.durationSec);
  summarizeDistribution(distribution);
}

main().catch((error) => {
  console.error('[backtest] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
