import type { Prisma, PrismaClient } from '@prisma/client';
import type { HitDetails, PriceSnapshot, SettlementItem, ServerBet } from './types';
import { HIT_TIME_TOLERANCE } from './constants';
import { roundMoney, toNumber } from '../shared/gameMath';
import { FinancialService } from '../services/financial';
import { HousePoolService } from '../services/HousePoolService';
import { SnapshotService } from './SnapshotService';

type SettlementSnapshot = {
  elapsed: number;
  currentRow: number;
  currentPrice: number;
  roundStartTime: number;
};

type SettlementCallbacks = {
  getActiveBet?: (betId: string) => ServerBet | undefined;
  onBetSettled?: (payload: {
    betId: string;
    orderId: string;
    userId: string;
    isWin: boolean;
    payout: number;
    hitDetails?: HitDetails;
  }) => void;
};

type SettlementServiceOptions = {
  prisma: PrismaClient;
  financialService: FinancialService;
  housePoolService: HousePoolService;
  snapshotService: SnapshotService;
  asset: string;
  hitTolerance: number;
  callbacks?: SettlementCallbacks;
};

type ResolveHitResult = {
  isWin: boolean;
  hitDetails?: HitDetails;
  usedFallback: boolean;
};

export class SettlementService {
  private settlementQueue: SettlementItem[] = [];
  private isSettling = false;
  private settlementRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private settlementRetryAttempts: Map<string, number> = new Map();
  private callbacks: SettlementCallbacks;

  private prisma: PrismaClient;
  private financialService: FinancialService;
  private housePoolService: HousePoolService;
  private snapshotService: SnapshotService;
  private hitTolerance: number;
  private asset: string;

  constructor(options: SettlementServiceOptions) {
    this.prisma = options.prisma;
    this.financialService = options.financialService;
    this.housePoolService = options.housePoolService;
    this.snapshotService = options.snapshotService;
    this.hitTolerance = options.hitTolerance;
    this.asset = options.asset;
    this.callbacks = options.callbacks ?? {};
  }

  enqueue(items: SettlementItem[]): void {
    if (items.length === 0) return;
    this.settlementQueue.push(...items);
    void this.processSettlementQueue();
  }

  resetQueue(): void {
    this.settlementQueue = [];
    this.isSettling = false;
  }

  dispose(): void {
    for (const timer of this.settlementRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.settlementRetryTimers.clear();
    this.settlementRetryAttempts.clear();
  }

  async flushQueue(): Promise<boolean> {
    const maxWaitTime = 30000;
    const startTime = Date.now();

    while (this.settlementQueue.length > 0 || this.isSettling) {
      if (Date.now() - startTime > maxWaitTime) {
        console.error('[GameEngine] Settlement queue flush timeout, continuing anyway');
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return true;
  }

  async countPendingBets(roundId: string): Promise<number> {
    return this.prisma.bet
      .count({ where: { roundId, status: { in: ['PENDING', 'SETTLING'] } } })
      .catch((error) => {
        console.error(`[GameEngine] Failed to count pending bets for round ${roundId}:`, error);
        return 0;
      });
  }

  async compensateUnsettledBets(roundId: string, snapshot: SettlementSnapshot): Promise<void> {
    const unsettledBets = await this.prisma.bet
      .findMany({
        where: {
          roundId,
          status: { in: ['PENDING', 'SETTLING'] },
        },
      })
      .catch((error) => {
        console.error(`[GameEngine] Failed to query unsettled bets for round ${roundId}:`, error);
        return [];
      });

    if (unsettledBets.length === 0) return;

    const snapshots = await this.loadSnapshotsForBets(roundId, snapshot, unsettledBets);
    const hasSnapshots = snapshots.length > 0;
    if (!hasSnapshots) {
      console.warn(
        `[GameEngine] Snapshot window empty for round ${roundId}, falling back to end snapshot`
      );
    }

    const settlementByBetId = new Map<string, SettlementItem>();
    for (const item of this.settlementQueue) {
      settlementByBetId.set(item.bet.id, item);
    }

    console.warn(`[GameEngine] Found ${unsettledBets.length} unsettled bets, compensating...`);
    for (const dbBet of unsettledBets) {
      try {
        const queued = settlementByBetId.get(dbBet.id);

        const targetTime = toNumber(dbBet.targetTime, 0);
        const targetRow = toNumber(dbBet.targetRow, 0);

        let resolved: ResolveHitResult | null = null;
        if (!queued) {
          if (!hasSnapshots) {
            const fallback = this.resolveHitByEndSnapshot({ targetTime, targetRow, snapshot });
            resolved = { ...fallback, usedFallback: true };
          } else {
            resolved = await this.resolveHitBySnapshots({
              roundId,
              roundStartTime: snapshot.roundStartTime,
              targetTime,
              targetRow,
              snapshots,
              fallbackSnapshot: snapshot,
              betId: dbBet.id,
            });
          }
        }

        const isWin = queued?.isWin ?? resolved?.isWin ?? false;
        const hitDetails = queued?.hitDetails ?? resolved?.hitDetails;

        const amount = Number(dbBet.amount);
        const multiplierValue = Number(dbBet.multiplier);
        const payout = this.calculatePayout(amount, multiplierValue, isWin);
        const settledAt = new Date();

        const didSettle = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.bet.updateMany({
            where: { id: dbBet.id, status: { in: ['PENDING', 'SETTLING'] } },
            data: {
              status: isWin ? 'WON' : 'LOST',
              isWin,
              payout,
              hitPrice: hitDetails?.hitPrice,
              hitRow: hitDetails?.hitRow,
              hitTime: hitDetails?.hitTime,
              settledAt,
            },
          });

          if (updated.count !== 1) return false;

          if (isWin && payout > 0) {
            await this.financialService.changeBalance(
              {
                userId: dbBet.userId,
                amount: payout,
                type: 'WIN',
                isPlayMode: dbBet.isPlayMode,
                relatedBetId: dbBet.id,
                remark: `闁荤姍浣哥仼缂佸爼浜堕獮搴ㄥ即閻斿憡娈?${dbBet.id} (compensation)`,
              },
              tx
            );

            if (!dbBet.isPlayMode) {
              await this.housePoolService.applyDelta(
                {
                  asset: this.resolveAsset((dbBet as { asset?: string }).asset),
                  amount: -payout,
                },
                tx
              );
            }
          }

          if (!dbBet.isPlayMode) {
            await tx.user.update({
              where: { id: dbBet.userId },
              data: {
                totalBets: { increment: 1 },
                totalWins: isWin ? { increment: 1 } : undefined,
                totalLosses: !isWin ? { increment: 1 } : undefined,
                totalProfit: {
                  // Bet amount is already deducted on placement; winning profit should be the payout amount.
                  increment: isWin ? payout : -amount,
                },
              },
            });
          }

          return true;
        });

        if (didSettle) {
          const memBet = this.callbacks.getActiveBet?.(dbBet.id);
          if (memBet) {
            memBet.status = isWin ? 'WON' : 'LOST';
          }
        }
      } catch (error) {
        console.error(`[GameEngine] Failed to compensate bet ${dbBet.id} for round ${roundId}:`, error);
      }
    }
  }

  scheduleRetry(roundId: string, snapshot: SettlementSnapshot, reason: string): void {
    if (this.settlementRetryTimers.has(roundId)) return;

    const attempts = this.settlementRetryAttempts.get(roundId) ?? 0;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      console.error(`[GameEngine] Pending bet settlement exhausted retries for round ${roundId}`);
      return;
    }

    const delayMs = Math.min(30000, 1000 * Math.pow(2, attempts));
    console.warn(
      `[GameEngine] Scheduling settlement retry for round ${roundId} in ${delayMs}ms (attempt ${attempts + 1}, reason: ${reason})`
    );

    const timer = setTimeout(() => {
      this.settlementRetryTimers.delete(roundId);
      this.settlementRetryAttempts.set(roundId, attempts + 1);
      void this.retryPendingBets(roundId, snapshot, reason);
    }, delayMs);

    this.settlementRetryTimers.set(roundId, timer);
  }

  async resolveHitBySnapshots(params: {
    roundId: string;
    roundStartTime: number;
    targetTime: number;
    targetRow: number;
    snapshots: PriceSnapshot[];
    fallbackSnapshot: SettlementSnapshot;
    betId?: string;
  }): Promise<ResolveHitResult> {
    const targetTime = toNumber(params.targetTime, 0);
    const targetRow = toNumber(params.targetRow, 0);
    const windowStartMs = params.roundStartTime + (targetTime - HIT_TIME_TOLERANCE) * 1000;
    const windowEndMs = params.roundStartTime + (targetTime + HIT_TIME_TOLERANCE) * 1000;

    const windowSnapshots = params.snapshots.filter((snapshot) => {
      const timestamp = snapshot.timestamp.getTime();
      return timestamp >= windowStartMs && timestamp <= windowEndMs;
    });

    if (windowSnapshots.length === 0) {
      if (params.snapshots.length > 0) {
        console.warn(
          `[GameEngine] Snapshot window missing for bet ${params.betId ?? 'unknown'} in round ${params.roundId}, falling back to end snapshot`
        );
      }
      const fallback = this.resolveHitByEndSnapshot({
        targetTime,
        targetRow,
        snapshot: params.fallbackSnapshot,
      });
      return { ...fallback, usedFallback: true };
    }

    if (windowSnapshots.length === 1) {
      const row = toNumber(windowSnapshots[0].rowIndex, 0);
      const minRow = row - this.hitTolerance;
      const maxRow = row + this.hitTolerance;
      if (targetRow >= minRow && targetRow <= maxRow) {
        const hitTime = (windowSnapshots[0].timestamp.getTime() - params.roundStartTime) / 1000;
        return {
          isWin: true,
          hitDetails: {
            hitPrice: toNumber(windowSnapshots[0].price, 0),
            hitRow: row,
            hitTime,
          },
          usedFallback: false,
        };
      }
      return { isWin: false, usedFallback: false };
    }

    for (let i = 1; i < windowSnapshots.length; i++) {
      const prev = windowSnapshots[i - 1];
      const curr = windowSnapshots[i];
      const prevRow = toNumber(prev.rowIndex, 0);
      const currRow = toNumber(curr.rowIndex, 0);
      const minRow = Math.min(prevRow, currRow) - this.hitTolerance;
      const maxRow = Math.max(prevRow, currRow) + this.hitTolerance;
      if (targetRow >= minRow && targetRow <= maxRow) {
        const hitTime = (curr.timestamp.getTime() - params.roundStartTime) / 1000;
        return {
          isWin: true,
          hitDetails: {
            hitPrice: toNumber(curr.price, 0),
            hitRow: currRow,
            hitTime,
          },
          usedFallback: false,
        };
      }
    }

    return { isWin: false, usedFallback: false };
  }

  private async loadSnapshotsForBets(
    roundId: string,
    snapshot: SettlementSnapshot,
    bets: Array<{ targetTime?: unknown }>
  ): Promise<PriceSnapshot[]> {
    let minTargetTime = Number.POSITIVE_INFINITY;
    let maxTargetTime = Number.NEGATIVE_INFINITY;

    for (const bet of bets) {
      const targetTime = toNumber(bet.targetTime, 0);
      minTargetTime = Math.min(minTargetTime, targetTime);
      maxTargetTime = Math.max(maxTargetTime, targetTime);
    }

    if (!Number.isFinite(minTargetTime) || !Number.isFinite(maxTargetTime)) {
      minTargetTime = snapshot.elapsed;
      maxTargetTime = snapshot.elapsed;
    }

    const windowStart = new Date(
      snapshot.roundStartTime + (minTargetTime - HIT_TIME_TOLERANCE) * 1000
    );
    const windowEnd = new Date(
      snapshot.roundStartTime + (maxTargetTime + HIT_TIME_TOLERANCE) * 1000
    );

    return this.snapshotService.getSnapshotsInWindow({ roundId, windowStart, windowEnd });
  }

  private resolveHitByEndSnapshot(params: {
    targetTime: number;
    targetRow: number;
    snapshot: SettlementSnapshot;
  }): { isWin: boolean; hitDetails?: HitDetails } {
    const targetTime = toNumber(params.targetTime, 0);
    const targetRow = toNumber(params.targetRow, 0);
    const isWin =
      Math.abs(params.snapshot.elapsed - targetTime) <= HIT_TIME_TOLERANCE &&
      Math.abs(params.snapshot.currentRow - targetRow) <= this.hitTolerance;

    return {
      isWin,
      hitDetails: isWin
        ? {
            hitPrice: params.snapshot.currentPrice,
            hitRow: params.snapshot.currentRow,
            hitTime: params.snapshot.elapsed,
          }
        : undefined,
    };
  }

  calculatePayout(amount: number, multiplier: number, isWin: boolean): number {
    if (!isWin) return 0;
    if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) return 0;
    return roundMoney(amount * this.roundMultiplier(multiplier));
  }

  private roundMultiplier(multiplier: number): number {
    if (!Number.isFinite(multiplier)) return 0;
    return Math.round(multiplier * 10000) / 10000;
  }


  private resolveAsset(asset: unknown): string {
    if (typeof asset === 'string') {
      const trimmed = asset.trim();
      if (trimmed) return trimmed;
    }
    return this.asset;
  }

  private async processSettlementQueue(): Promise<void> {
    if (this.isSettling || this.settlementQueue.length === 0) return;

    this.isSettling = true;

    try {
      while (this.settlementQueue.length > 0) {
        const batch = this.settlementQueue.splice(0, 50);
        if (batch.length === 0) break;
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount <= maxRetries) {
          try {
            const settledBets = await this.prisma.$transaction(async (tx) => {
              const userAggregates = new Map<
                string,
                {
                  bets: Array<{
                    bet: (typeof batch)[0]['bet'];
                    isWin: boolean;
                    hitDetails: (typeof batch)[0]['hitDetails'];
                    payout: number;
                  }>;
                  totalPayout: number;
                  totalPayoutPlay: number;
                  totalBets: number;
                  totalWins: number;
                  totalLosses: number;
                  totalProfit: number;
                  balanceChanges: Array<{
                    amount: number;
                    type: 'WIN';
                    relatedBetId: string;
                    remark: string;
                  }>;
                }
              >();
              let poolDelta = 0;
              const settled: Array<{
                bet: (typeof batch)[0]['bet'];
                isWin: boolean;
                hitDetails: (typeof batch)[0]['hitDetails'];
                payout: number;
              }> = [];

              for (const { bet, isWin, hitDetails } of batch) {
                const payout = this.calculatePayout(bet.amount, bet.multiplier, isWin);

                const updated = await tx.bet.updateMany({
                  where: { id: bet.id, status: { in: ['PENDING', 'SETTLING'] } },
                  data: {
                    status: isWin ? 'WON' : 'LOST',
                    isWin,
                    payout,
                    hitPrice: hitDetails?.hitPrice,
                    hitRow: hitDetails?.hitRow,
                    hitTime: hitDetails?.hitTime,
                    settledAt: new Date(),
                  },
                });

                if (updated.count === 1) {
                  settled.push({ bet, isWin, hitDetails, payout });
                  const agg = userAggregates.get(bet.userId) || {
                    bets: [],
                    totalPayout: 0,
                    totalPayoutPlay: 0,
                    totalBets: 0,
                    totalWins: 0,
                    totalLosses: 0,
                    totalProfit: 0,
                    balanceChanges: [],
                  };

                  agg.bets.push({ bet, isWin, hitDetails, payout });
                  if (isWin && payout > 0) {
                    if (bet.isPlayMode) {
                      agg.totalPayoutPlay += payout;
                    } else {
                      agg.totalPayout += payout;
                      poolDelta = roundMoney(poolDelta + payout);
                      agg.balanceChanges.push({
                        amount: payout,
                        type: 'WIN',
                        relatedBetId: bet.id,
                        remark: `闁荤姍浣哥仼缂佸爼浜堕獮搴ㄥ即閻斿憡娈?${bet.id}`,
                      });
                    }
                  }
                  if (!bet.isPlayMode) {
                    agg.totalBets++;
                    if (isWin) agg.totalWins++;
                    else agg.totalLosses++;
                    // Bet amount is already deducted on placement; winning profit should be the payout amount.
                    agg.totalProfit += isWin ? payout : -bet.amount;
                  }

                  userAggregates.set(bet.userId, agg);
                } else {
                  console.log(`[GameEngine] Bet ${bet.id} already settled, skipping`);
                }
              }

              for (const [userId, agg] of userAggregates) {
                const updateData: Prisma.UserUpdateInput = {
                  totalBets: { increment: agg.totalBets },
                  totalProfit: { increment: agg.totalProfit },
                  ...(agg.totalWins > 0 ? { totalWins: { increment: agg.totalWins } } : {}),
                  ...(agg.totalLosses > 0 ? { totalLosses: { increment: agg.totalLosses } } : {}),
                };

                if (agg.balanceChanges.length > 0) {
                  await this.financialService.batchChangeBalance(
                    {
                      userId,
                      changes: agg.balanceChanges,
                      isPlayMode: false,
                    },
                    tx
                  );
                } else if (agg.totalPayout > 0) {
                  await this.financialService.changeBalance(
                    {
                      userId,
                      amount: agg.totalPayout,
                      type: 'WIN',
                      isPlayMode: false,
                      remark: 'Batch payout (fallback)',
                    },
                    tx
                  );
                }

                if (agg.totalPayoutPlay > 0) {
                  await this.financialService.changeBalance(
                    {
                      userId,
                      amount: agg.totalPayoutPlay,
                      type: 'WIN',
                      isPlayMode: true,
                      remark: 'Batch payout (play)',
                    },
                    tx
                  );
                }

                await tx.user.update({ where: { id: userId }, data: updateData });
              }

              if (poolDelta > 0) {
                await this.housePoolService.applyDelta(
                  { asset: this.asset, amount: -poolDelta },
                  tx
                );
              }

              return settled;
            });

            for (const { bet, isWin } of settledBets) {
              bet.status = isWin ? 'WON' : 'LOST';
            }

            for (const { bet, isWin, hitDetails, payout } of settledBets) {
              try {
                this.callbacks.onBetSettled?.({
                  betId: bet.id,
                  orderId: bet.orderId,
                  userId: bet.userId,
                  isWin,
                  payout,
                  hitDetails,
                });
              } catch (callbackError) {
                console.error('[GameEngine] Settlement onBetSettled callback failed:', callbackError);
              }
            }
            break;
          } catch (error) {
            retryCount++;
            if (retryCount > maxRetries) {
              console.error('[GameEngine] Settlement batch failed after retries:', error);
              this.settlementQueue.unshift(...batch);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retryCount) * 100));
          }
        }
      }
    } finally {
      this.isSettling = false;
    }
  }

  private clearSettlementRetry(roundId: string): void {
    const timer = this.settlementRetryTimers.get(roundId);
    if (timer) {
      clearTimeout(timer);
      this.settlementRetryTimers.delete(roundId);
    }
    this.settlementRetryAttempts.delete(roundId);
  }

  private async retryPendingBets(
    roundId: string,
    snapshot: SettlementSnapshot,
    reason: string
  ): Promise<void> {
    const unsettledBets = await this.prisma.bet
      .findMany({
        where: {
          roundId,
          status: { in: ['PENDING', 'SETTLING'] },
        },
      })
      .catch((error) => {
        console.error(`[GameEngine] Failed to query unsettled bets for retry (round ${roundId}):`, error);
        return [];
      });

    if (unsettledBets.length === 0) {
      this.clearSettlementRetry(roundId);
      return;
    }

    const snapshots = await this.loadSnapshotsForBets(roundId, snapshot, unsettledBets);
    const hasSnapshots = snapshots.length > 0;
    if (!hasSnapshots) {
      console.warn(
        `[GameEngine] Snapshot window empty for round ${roundId}, falling back to end snapshot`
      );
    }

    console.warn(
      `[GameEngine] Retrying ${unsettledBets.length} unsettled bets for round ${roundId} (reason: ${reason})`
    );

    for (const dbBet of unsettledBets) {
      try {
        const targetTime = toNumber(dbBet.targetTime, 0);
        const targetRow = toNumber(dbBet.targetRow, 0);
        let resolved: ResolveHitResult;
        if (!hasSnapshots) {
          const fallback = this.resolveHitByEndSnapshot({ targetTime, targetRow, snapshot });
          resolved = { ...fallback, usedFallback: true };
        } else {
          resolved = await this.resolveHitBySnapshots({
            roundId,
            roundStartTime: snapshot.roundStartTime,
            targetTime,
            targetRow,
            snapshots,
            fallbackSnapshot: snapshot,
            betId: dbBet.id,
          });
        }

        const isWin = resolved.isWin;
        const hitDetails = resolved.hitDetails;

        const amount = Number(dbBet.amount);
        const multiplierValue = Number(dbBet.multiplier);
        const payout = this.calculatePayout(amount, multiplierValue, isWin);
        const settledAt = new Date();

        const didSettle = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.bet.updateMany({
            where: { id: dbBet.id, status: { in: ['PENDING', 'SETTLING'] } },
            data: {
              status: isWin ? 'WON' : 'LOST',
              isWin,
              payout,
              hitPrice: hitDetails?.hitPrice,
              hitRow: hitDetails?.hitRow,
              hitTime: hitDetails?.hitTime,
              settledAt,
            },
          });

          if (updated.count !== 1) return false;

          if (isWin && payout > 0) {
            await this.financialService.changeBalance(
              {
                userId: dbBet.userId,
                amount: payout,
                type: 'WIN',
                isPlayMode: dbBet.isPlayMode,
                relatedBetId: dbBet.id,
                remark: `Win bet ${dbBet.id} (retry)`,
              },
              tx
            );

            if (!dbBet.isPlayMode) {
              await this.housePoolService.applyDelta(
                {
                  asset: this.resolveAsset((dbBet as { asset?: string }).asset),
                  amount: -payout,
                },
                tx
              );
            }
          }

          if (!dbBet.isPlayMode) {
            await tx.user.update({
              where: { id: dbBet.userId },
              data: {
                totalBets: { increment: 1 },
                totalWins: isWin ? { increment: 1 } : undefined,
                totalLosses: !isWin ? { increment: 1 } : undefined,
                totalProfit: {
                  // Bet amount is already deducted on placement; winning profit should be the payout amount.
                  increment: isWin ? payout : -amount,
                },
              },
            });
          }

          return true;
        });

        if (didSettle) {
          const memBet = this.callbacks.getActiveBet?.(dbBet.id);
          if (memBet) {
            memBet.status = isWin ? 'WON' : 'LOST';
          }
        }
      } catch (error) {
        console.error(`[GameEngine] Failed to retry settle bet ${dbBet.id} for round ${roundId}:`, error);
      }
    }

    const remaining = await this.prisma.bet
      .count({ where: { roundId, status: { in: ['PENDING', 'SETTLING'] } } })
      .catch((error) => {
        console.error(`[GameEngine] Failed to count pending bets after retry for round ${roundId}:`, error);
        return unsettledBets.length;
      });

    if (remaining > 0) {
      this.scheduleRetry(roundId, snapshot, reason);
    } else {
      this.clearSettlementRetry(roundId);
    }
  }
}
