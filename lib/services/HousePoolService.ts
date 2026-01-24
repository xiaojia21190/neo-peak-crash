import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { roundMoney, toNumber } from '../shared/gameMath';

export class HousePoolNotInitializedError extends Error {
  override name = 'HousePoolNotInitializedError';
  constructor(asset: string) {
    super(`House pool not initialized for asset: ${asset}`);
  }
}

export class HousePoolConflictError extends Error {
  override name = 'HousePoolConflictError';
  constructor(asset: string) {
    super(`House pool update conflict for asset: ${asset}`);
  }
}

function normalizeAsset(asset: string): string {
  if (typeof asset !== 'string') {
    throw new Error('Asset must be a string');
  }
  const trimmed = asset.trim();
  if (!trimmed) {
    throw new Error('Asset is required');
  }
  return trimmed;
}

function normalizeAmount(amount: number, allowZero = false): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Amount must be finite');
  }
  const rounded = roundMoney(amount);
  if (!allowZero && rounded === 0) {
    throw new Error('Amount must be non-zero');
  }
  return rounded;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code === 'P2002'
  );
}

export class HousePoolService {
  constructor(private prisma: PrismaClient) {}

  async getBalance(asset: string): Promise<number | null> {
    const normalizedAsset = normalizeAsset(asset);
    const pool = await this.prisma.housePool.findUnique({
      where: { asset: normalizedAsset },
      select: { balance: true },
    });
    if (!pool) return null;
    return toNumber(pool.balance, 0);
  }

  async initialize(asset: string, initialBalance: number): Promise<number> {
    const normalizedAsset = normalizeAsset(asset);
    const balance = normalizeAmount(initialBalance, true);
    if (balance < 0) {
      throw new Error('Initial balance must be non-negative');
    }

    try {
      const created = await this.prisma.housePool.create({
        data: { asset: normalizedAsset, balance },
        select: { balance: true },
      });
      return toNumber(created.balance, 0);
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    const existing = await this.prisma.housePool.findUnique({
      where: { asset: normalizedAsset },
      select: { balance: true },
    });
    if (!existing) {
      throw new HousePoolNotInitializedError(normalizedAsset);
    }
    return toNumber(existing.balance, 0);
  }

  async applyDelta(
    params: { asset: string; amount: number },
    tx: Prisma.TransactionClient
  ): Promise<{ balance: number; version: number }> {
    const normalizedAsset = normalizeAsset(params.asset);
    const amount = normalizeAmount(params.amount);

    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const current = await tx.housePool.findUnique({
        where: { asset: normalizedAsset },
        select: { balance: true, version: true },
      });
      if (!current) {
        throw new HousePoolNotInitializedError(normalizedAsset);
      }

      const update = await tx.housePool.updateMany({
        where: { asset: normalizedAsset, version: current.version },
        data: {
          balance: { increment: amount },
          version: { increment: 1 },
        },
      });

      if (update.count === 1) {
        return {
          balance: roundMoney(toNumber(current.balance, 0) + amount),
          version: current.version + 1,
        };
      }

      if (attempt >= maxRetries) {
        break;
      }

      const delayMs = 100 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new HousePoolConflictError(normalizedAsset);
  }

}
