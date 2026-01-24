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

export class RiskManager {
  private readonly maxRoundPayout?: number;
  private readonly maxRoundPayoutRatio: number;

  constructor(options: { maxRoundPayout?: number; maxRoundPayoutRatio?: number } = {}) {
    this.maxRoundPayout = options.maxRoundPayout;
    const ratio = options.maxRoundPayoutRatio ?? Number(process.env.MAX_ROUND_PAYOUT ?? '0.15');
    this.maxRoundPayoutRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
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

  private resolveMaxRoundPayout(poolBalance: number): number {
    if (!Number.isFinite(poolBalance) || poolBalance <= 0) return 0;
    const configured = this.maxRoundPayout ?? this.maxRoundPayoutRatio;
    const maxPayout = configured <= 1 ? poolBalance * configured : configured;
    return Math.max(0, roundMoney(maxPayout));
  }

  private calculateMaxBetFromMetrics(metrics: RiskMetrics, multiplier: number, baseMaxBet: number): number {
    if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
    const safeBaseMaxBet = Number.isFinite(baseMaxBet) && baseMaxBet > 0 ? baseMaxBet : 0;
    const maxByPayout = metrics.remainingPayoutCapacity / multiplier;
    return Math.max(0, roundMoney(Math.min(safeBaseMaxBet, maxByPayout)));
  }
}
