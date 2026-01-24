import type { PrismaClient } from '@prisma/client';
import type { PriceSnapshot } from './types';

type SnapshotState = {
  roundId: string;
  elapsed: number;
  roundStartTime: number;
  currentPrice: number;
  currentRow: number;
};

export class SnapshotService {
  private priceSnapshotBuffer: PriceSnapshot[] = [];
  private priceSnapshotBufferHead = 0;
  private lastSnapshotFlush = 0;
  private snapshotFlushPromise: Promise<void> | null = null;
  private snapshotFlushBackoffUntil = 0;
  private snapshotFlushFailures = 0;

  constructor(private prisma: PrismaClient) {}

  bufferSnapshot(state: SnapshotState): void {
    const snapshotIndex = Math.floor(state.elapsed * 10);
    const bufferSize = this.priceSnapshotBuffer.length - this.priceSnapshotBufferHead;
    if (bufferSize > 0) {
      const lastIndex = Math.floor(
        (this.priceSnapshotBuffer[this.priceSnapshotBuffer.length - 1].timestamp.getTime() -
          state.roundStartTime) /
          100
      );
      if (snapshotIndex === lastIndex) return;
    }

    const maxQueue = parseInt(process.env.MAX_SNAPSHOT_QUEUE ?? '10000', 10);
    if (bufferSize >= maxQueue) {
      this.priceSnapshotBufferHead++;
    }

    this.priceSnapshotBuffer.push({
      roundId: state.roundId,
      timestamp: new Date(),
      price: state.currentPrice,
      rowIndex: state.currentRow,
    });

    const now = Date.now();
    if (
      now - this.lastSnapshotFlush >= 1000 &&
      now >= this.snapshotFlushBackoffUntil &&
      bufferSize > 0
    ) {
      void this.flushSnapshots().catch(console.error);
    }
  }

  flushSnapshots(): Promise<void> {
    if (this.snapshotFlushPromise) return this.snapshotFlushPromise;
    const bufferSize = this.priceSnapshotBuffer.length - this.priceSnapshotBufferHead;
    if (bufferSize === 0) return Promise.resolve();

    const now = Date.now();
    if (now < this.snapshotFlushBackoffUntil) return Promise.resolve();

    this.lastSnapshotFlush = now;

    this.snapshotFlushPromise = this.flushSnapshotsInternal().finally(() => {
      this.snapshotFlushPromise = null;
    });

    return this.snapshotFlushPromise;
  }

  resetBuffer(): void {
    this.priceSnapshotBuffer = [];
    this.priceSnapshotBufferHead = 0;
  }

  async getSnapshotsInWindow(params: {
    roundId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<PriceSnapshot[]> {
    try {
      const snapshots = await this.prisma.priceSnapshot.findMany({
        where: {
          roundId: params.roundId,
          timestamp: { gte: params.windowStart, lte: params.windowEnd },
        },
        orderBy: { timestamp: 'asc' },
        select: {
          roundId: true,
          timestamp: true,
          price: true,
          rowIndex: true,
        },
      });

      return snapshots.map((snapshot) => ({
        roundId: snapshot.roundId,
        timestamp: snapshot.timestamp,
        price: this.toNumber(snapshot.price, 0),
        rowIndex: this.toNumber(snapshot.rowIndex, 0),
      }));
    } catch (error) {
      console.error(
        `[GameEngine] Failed to load snapshots for round ${params.roundId} (window ${params.windowStart.toISOString()} - ${params.windowEnd.toISOString()}):`,
        error
      );
      return [];
    }
  }

  private async flushSnapshotsInternal(): Promise<void> {
    const buffer = this.priceSnapshotBuffer.slice(this.priceSnapshotBufferHead);
    this.priceSnapshotBuffer = [];
    this.priceSnapshotBufferHead = 0;
    if (buffer.length === 0) return;

    const rawBatchSize = parseInt(process.env.SNAPSHOT_FLUSH_BATCH_SIZE ?? '500', 10);
    const batchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 500;

    let index = 0;
    try {
      for (; index < buffer.length; index += batchSize) {
        const batch = buffer.slice(index, index + batchSize);
        await this.prisma.priceSnapshot.createMany({ data: batch });
      }

      this.snapshotFlushFailures = 0;
      this.snapshotFlushBackoffUntil = 0;
    } catch (error) {
      console.error('[GameEngine] Price snapshot flush failed:', error);

      const remaining = buffer.slice(index);
      if (remaining.length > 0) {
        this.priceSnapshotBuffer = remaining.concat(this.priceSnapshotBuffer);
      }

      this.snapshotFlushFailures = Math.min(this.snapshotFlushFailures + 1, 10);
      const baseDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_BASE_MS ?? '1000', 10);
      const maxDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_MAX_MS ?? '30000', 10);
      const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 1000;
      const max = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : 30000;
      const delayMs = Math.min(max, base * 2 ** (this.snapshotFlushFailures - 1));
      this.snapshotFlushBackoffUntil = Date.now() + delayMs;
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    if (value == null) return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    const maybeToNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof maybeToNumber === 'function') {
      try {
        const num = maybeToNumber.call(value);
        return Number.isFinite(num) ? num : fallback;
      } catch {
        return fallback;
      }
    }
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : fallback;
  }
}
