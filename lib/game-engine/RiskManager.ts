import type { Redis } from 'ioredis';
import { roundMoney } from '../shared/gameMath';

export type RiskBet = {
  amount: number;
  multiplier: number;
  isPlayMode?: boolean;
  status?: string;
};

export type RiskMetrics = {
  totalBetAmount: number;
  expectedPayout: number;
  poolBalance: number;
  maxRoundPayout: number;
  remainingPayoutCapacity: number;
};

export type RiskAssessment = {
  allowed: boolean;
  maxBetAllowed: number;
  projectedPayout: number;
  metrics: RiskMetrics;
};

export type ExpectedPayoutReservation = {
  allowed: boolean;
  didReserve: boolean;
  reservedTotal: number;
  reservedForOrder: number;
};

export type ExpectedPayoutRelease = {
  released: boolean;
  reservedTotal: number;
  releasedAmount: number;
};

export class RiskManager {
  private readonly maxRoundPayout?: number;
  private readonly maxRoundPayoutRatio: number;

  constructor(options: { maxRoundPayout?: number; maxRoundPayoutRatio?: number } = {}) {
    this.maxRoundPayout = options.maxRoundPayout;
    const ratio = options.maxRoundPayoutRatio ?? Number(process.env.MAX_ROUND_PAYOUT ?? '0.15');
    this.maxRoundPayoutRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  }

  getMaxRoundPayout(poolBalance: number): number {
    return this.resolveMaxRoundPayout(poolBalance);
  }

  calculateProjectedPayout(amount: number, multiplier: number): number {
    if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) return 0;
    return roundMoney(amount * multiplier);
  }

  calculateMetrics(activeBets: Iterable<RiskBet>, poolBalance: number): RiskMetrics {
    const safePoolBalance = Number.isFinite(poolBalance) && poolBalance > 0 ? poolBalance : 0;
    let totalBetAmount = 0;
    let expectedPayout = 0;

    for (const bet of activeBets) {
      if (!bet || bet.isPlayMode) continue;
      if (bet.status && bet.status !== 'PENDING') continue;
      if (!Number.isFinite(bet.amount) || !Number.isFinite(bet.multiplier)) continue;

      totalBetAmount += bet.amount;
      expectedPayout += bet.amount * bet.multiplier;
    }

    const maxRoundPayout = this.resolveMaxRoundPayout(safePoolBalance);
    const remainingPayoutCapacity = Math.max(0, roundMoney(maxRoundPayout - expectedPayout));

    return {
      totalBetAmount: roundMoney(totalBetAmount),
      expectedPayout: roundMoney(expectedPayout),
      poolBalance: roundMoney(safePoolBalance),
      maxRoundPayout,
      remainingPayoutCapacity,
    };
  }

  calculateMaxBet(params: {
    activeBets: Iterable<RiskBet>;
    poolBalance: number;
    multiplier: number;
    baseMaxBet: number;
  }): number {
    const metrics = this.calculateMetrics(params.activeBets, params.poolBalance);
    return this.calculateMaxBetFromMetrics(metrics, params.multiplier, params.baseMaxBet);
  }

  assessBet(params: {
    activeBets: Iterable<RiskBet>;
    poolBalance: number;
    amount: number;
    multiplier: number;
    baseMaxBet: number;
  }): RiskAssessment {
    const metrics = this.calculateMetrics(params.activeBets, params.poolBalance);
    const maxBetAllowed = this.calculateMaxBetFromMetrics(metrics, params.multiplier, params.baseMaxBet);
    const projectedPayout = roundMoney(params.amount * params.multiplier);
    const allowed =
      params.amount > 0 &&
      Number.isFinite(projectedPayout) &&
      params.amount <= maxBetAllowed &&
      metrics.expectedPayout + projectedPayout <= metrics.maxRoundPayout + 1e-6;

    if (!allowed) {
      console.warn('[RiskManager] Bet rejected by risk assessment', {
        amount: params.amount,
        multiplier: params.multiplier,
        maxBetAllowed,
        projectedPayout,
        metrics,
      });
    }

    return {
      allowed,
      maxBetAllowed,
      projectedPayout,
      metrics,
    };
  }

  async reserveExpectedPayout(params: {
    redis: Redis;
    roundId: string;
    orderId: string;
    expectedPayout: number;
    maxRoundPayout: number;
    ttlMs: number;
  }): Promise<ExpectedPayoutReservation> {
    const expectedPayout = roundMoney(params.expectedPayout);
    const maxRoundPayout = roundMoney(params.maxRoundPayout);
    const ttlMs = Math.max(1000, Math.floor(params.ttlMs));

    if (!Number.isFinite(expectedPayout) || expectedPayout <= 0) {
      return { allowed: false, didReserve: false, reservedTotal: 0, reservedForOrder: 0 };
    }

    if (!Number.isFinite(maxRoundPayout) || maxRoundPayout <= 0) {
      return { allowed: false, didReserve: false, reservedTotal: 0, reservedForOrder: 0 };
    }

    const reservedKey = this.buildReservedExpectedPayoutKey(params.roundId);
    const reservationKey = this.buildOrderReservationKey(params.roundId, params.orderId);

    const script = `
      -- risk:reserve_expected_payout
      local reservedKey = KEYS[1]
      local reservationKey = KEYS[2]

      local maxPayout = tonumber(ARGV[1])
      local delta = tonumber(ARGV[2])
      local ttl = tonumber(ARGV[3])

      local existing = redis.call("get", reservationKey)
      if existing then
        local total = tonumber(redis.call("get", reservedKey) or "0")
        return {1, 0, total, tonumber(existing)}
      end

      local current = tonumber(redis.call("get", reservedKey) or "0")
      if current + delta > maxPayout + 0.000001 then
        return {0, 0, current, 0}
      end

      local nextTotal = current + delta
      redis.call("set", reservedKey, nextTotal, "PX", ttl)
      redis.call("set", reservationKey, delta, "PX", ttl)
      return {1, 1, nextTotal, delta}
    `;

    const result = (await params.redis.eval(
      script,
      2,
      reservedKey,
      reservationKey,
      maxRoundPayout.toString(),
      expectedPayout.toString(),
      ttlMs.toString()
    )) as unknown;

    const parsed = Array.isArray(result) ? result : [];
    const allowed = Number(parsed[0]) === 1;
    const didReserve = Number(parsed[1]) === 1;
    const reservedTotal = roundMoney(Number(parsed[2] ?? 0));
    const reservedForOrder = roundMoney(Number(parsed[3] ?? 0));

    return {
      allowed,
      didReserve,
      reservedTotal: Number.isFinite(reservedTotal) ? reservedTotal : 0,
      reservedForOrder: Number.isFinite(reservedForOrder) ? reservedForOrder : 0,
    };
  }

  async releaseExpectedPayout(params: {
    redis: Redis;
    roundId: string;
    orderId: string;
    ttlMs: number;
  }): Promise<ExpectedPayoutRelease> {
    const ttlMs = Math.max(1000, Math.floor(params.ttlMs));
    const reservedKey = this.buildReservedExpectedPayoutKey(params.roundId);
    const reservationKey = this.buildOrderReservationKey(params.roundId, params.orderId);

    const script = `
      -- risk:release_expected_payout
      local reservedKey = KEYS[1]
      local reservationKey = KEYS[2]

      local ttl = tonumber(ARGV[1])

      local existing = redis.call("get", reservationKey)
      if not existing then
        local total = tonumber(redis.call("get", reservedKey) or "0")
        return {0, total, 0}
      end

      local delta = tonumber(existing)
      local current = tonumber(redis.call("get", reservedKey) or "0")
      local nextTotal = current - delta
      if nextTotal < 0 then nextTotal = 0 end

      redis.call("set", reservedKey, nextTotal, "PX", ttl)
      redis.call("del", reservationKey)
      return {1, nextTotal, delta}
    `;

    const result = (await params.redis.eval(script, 2, reservedKey, reservationKey, ttlMs.toString())) as unknown;
    const parsed = Array.isArray(result) ? result : [];
    const released = Number(parsed[0]) === 1;
    const reservedTotal = roundMoney(Number(parsed[1] ?? 0));
    const releasedAmount = roundMoney(Number(parsed[2] ?? 0));

    return {
      released,
      reservedTotal: Number.isFinite(reservedTotal) ? reservedTotal : 0,
      releasedAmount: Number.isFinite(releasedAmount) ? releasedAmount : 0,
    };
  }

  buildReservedExpectedPayoutKey(roundId: string): string {
    return `game:risk:expected_payout:${roundId}`;
  }

  buildOrderReservationKey(roundId: string, orderId: string): string {
    return `game:risk:expected_payout:${roundId}:order:${orderId}`;
  }

  calculateMaxBetFromRemainingPayoutCapacity(params: {
    remainingPayoutCapacity: number;
    multiplier: number;
    baseMaxBet: number;
  }): number {
    const metrics: RiskMetrics = {
      totalBetAmount: 0,
      expectedPayout: 0,
      poolBalance: 0,
      maxRoundPayout: 0,
      remainingPayoutCapacity: roundMoney(Math.max(0, params.remainingPayoutCapacity)),
    };
    return this.calculateMaxBetFromMetrics(metrics, params.multiplier, params.baseMaxBet);
  }

  private resolveMaxRoundPayout(poolBalance: number): number {
    if (!Number.isFinite(poolBalance) || poolBalance <= 0) return 0;
    if (this.maxRoundPayout !== undefined) {
      return Math.max(0, roundMoney(this.maxRoundPayout));
    }

    const ratioOrAbsolute = this.maxRoundPayoutRatio;
    const maxPayout = ratioOrAbsolute <= 1 ? poolBalance * ratioOrAbsolute : ratioOrAbsolute;
    return Math.max(0, roundMoney(maxPayout));
  }

  private calculateMaxBetFromMetrics(metrics: RiskMetrics, multiplier: number, baseMaxBet: number): number {
    if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
    const safeBaseMaxBet = Number.isFinite(baseMaxBet) && baseMaxBet > 0 ? baseMaxBet : 0;
    const maxByPayout = metrics.remainingPayoutCapacity / multiplier;
    return Math.max(0, roundMoney(Math.min(safeBaseMaxBet, maxByPayout)));
  }
}
