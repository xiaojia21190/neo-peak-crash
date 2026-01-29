export const HOUSE_EDGE = 0.08;

// Row index system:
// - Canonical storage/transport is 0-based (0..MAX_ROW_INDEX)
// - UI may display rowIndex + 1 when showing "Row N"
export const MIN_ROW_INDEX = 0;
export const MAX_ROW_INDEX = 13;
export const CENTER_ROW_INDEX = (MIN_ROW_INDEX + MAX_ROW_INDEX) / 2; // 6.5

// 1% price change => 10 rows
export const PRICE_SENSITIVITY = 1000;

export const MIN_MULTIPLIER = 1.01;
export const MAX_MULTIPLIER = 100;

// These should stay aligned with the real hit logic in `lib/game-engine/*`.
export const DEFAULT_HIT_TIME_TOLERANCE_SECONDS = 0.5;
export const DEFAULT_HIT_ROW_TOLERANCE = 0.4;

export const MULTIPLIER_MODEL = {
  sigma: 3.7,
  baseProbability: 0.9,
  timePenalty: 0.03,
} as const;

export type PayoutModel = {
  sigma: number;
  baseProbability: number;
  timePenalty: number;
};

export type PayoutModelOptions = {
  model?: Partial<PayoutModel>;
  hitTimeToleranceSeconds?: number;
  hitRowTolerance?: number;
};

export function clampRowIndex(rowIndex: number): number {
  return Math.max(MIN_ROW_INDEX, Math.min(MAX_ROW_INDEX, rowIndex));
}

// Money is stored as Decimal(18,2) in DB, so always round payouts/balances to cents.
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function toNumber(value: unknown, fallback = 0): number {
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

export function isValidMoneyAmount(amount: number): boolean {
  if (!Number.isFinite(amount)) return false;
  return Math.abs(amount - roundMoney(amount)) < 1e-9;
}

export type RowTick = {
  elapsed: number;
  row: number;
};

export function isHitByTickSeries(params: {
  ticks: RowTick[];
  targetTime: number;
  targetRow: number;
  hitTimeToleranceSeconds?: number;
  hitRowTolerance?: number;
}): boolean {
  const hitTimeToleranceSeconds =
    params.hitTimeToleranceSeconds ?? DEFAULT_HIT_TIME_TOLERANCE_SECONDS;
  const hitRowTolerance = params.hitRowTolerance ?? DEFAULT_HIT_ROW_TOLERANCE;

  const targetTime = toNumber(params.targetTime, 0);
  const targetRow = toNumber(params.targetRow, 0);
  if (!Number.isFinite(targetTime) || !Number.isFinite(targetRow)) return false;

  const ticks = params.ticks;
  if (!Array.isArray(ticks) || ticks.length < 2) return false;

  const windowStart = targetTime - hitTimeToleranceSeconds;
  const windowEnd = targetTime + hitTimeToleranceSeconds;

  for (let i = 1; i < ticks.length; i += 1) {
    const elapsed = ticks[i]!.elapsed;
    if (!Number.isFinite(elapsed)) continue;
    if (elapsed < windowStart) continue;
    if (elapsed > windowEnd) break;

    const prevRow = ticks[i - 1]!.row;
    const currRow = ticks[i]!.row;
    if (!Number.isFinite(prevRow) || !Number.isFinite(currRow)) continue;

    const minRow = Math.min(prevRow, currRow) - hitRowTolerance;
    const maxRow = Math.max(prevRow, currRow) + hitRowTolerance;
    if (targetRow >= minRow && targetRow <= maxRow) return true;
  }

  return false;
}

export function calculateMultiplier(
  targetRow: number,
  referenceRow: number = CENTER_ROW_INDEX,
  timeDeltaSeconds: number = 0,
  options?: PayoutModelOptions
): number {
  const adjustedProbability = calculateAdjustedProbability(targetRow, referenceRow, timeDeltaSeconds, options);

  // Avoid Infinity in pathological cases.
  const fairPayout = adjustedProbability > 0 ? 1 / adjustedProbability : MAX_MULTIPLIER;
  const housePayout = fairPayout * (1 - HOUSE_EDGE);

  const clamped = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, housePayout));
  return Math.round(clamped * 10000) / 10000;
}

export function calculateAdjustedProbability(
  targetRow: number,
  referenceRow: number = CENTER_ROW_INDEX,
  timeDeltaSeconds: number = 0,
  options?: PayoutModelOptions
): number {
  const resolvedModel: PayoutModel = {
    sigma: options?.model?.sigma ?? MULTIPLIER_MODEL.sigma,
    baseProbability: options?.model?.baseProbability ?? MULTIPLIER_MODEL.baseProbability,
    timePenalty: options?.model?.timePenalty ?? MULTIPLIER_MODEL.timePenalty,
  };

  const sigma = toNumber(resolvedModel.sigma, 0);
  const baseProbability = toNumber(resolvedModel.baseProbability, 0);
  const timePenaltyCoeff = toNumber(resolvedModel.timePenalty, 0);
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  if (!Number.isFinite(baseProbability) || baseProbability <= 0) return 0;

  const hitTimeToleranceSeconds =
    options?.hitTimeToleranceSeconds ?? DEFAULT_HIT_TIME_TOLERANCE_SECONDS;
  const hitRowTolerance = options?.hitRowTolerance ?? DEFAULT_HIT_ROW_TOLERANCE;

  const targetRowNum = toNumber(targetRow, CENTER_ROW_INDEX);
  const referenceRowNum = toNumber(referenceRow, CENTER_ROW_INDEX);
  const timeDelta = toNumber(timeDeltaSeconds, 0);
  if (!Number.isFinite(targetRowNum) || !Number.isFinite(referenceRowNum) || !Number.isFinite(timeDelta)) {
    return 0;
  }

  const clampedTime = Math.max(0, timeDelta);
  const penaltyDenom = 1 + clampedTime * Math.max(0, timePenaltyCoeff);

  // Model the row movement as a driftless Brownian motion in "row space" and use the same
  // hit window (time +/- tolerance, row +/- tolerance) as the real game resolver.
  const delta = targetRowNum - referenceRowNum;
  const lower = delta - Math.max(0, hitRowTolerance);
  const upper = delta + Math.max(0, hitRowTolerance);

  const windowStart = Math.max(0, clampedTime - Math.max(0, hitTimeToleranceSeconds));
  const windowEnd = Math.max(0, clampedTime + Math.max(0, hitTimeToleranceSeconds));
  const windowDuration = Math.max(0, windowEnd - windowStart);

  const rawProbability = hitProbabilityBrownianWindow({
    lower,
    upper,
    sigma,
    windowStart,
    windowDuration,
  });

  const adjusted = (baseProbability * rawProbability) / penaltyDenom;
  if (!Number.isFinite(adjusted) || adjusted <= 0) return 0;
  return Math.min(1, adjusted);
}

const SQRT_PI = Math.sqrt(Math.PI);
const SQRT2 = Math.SQRT2;

// 10-point Gauss-Hermite quadrature nodes/weights (symmetric).
const GAUSS_HERMITE_10_NODES = [
  -3.4361591188377376,
  -2.5327316742327897,
  -1.7566836492998818,
  -1.0366108297895137,
  -0.3429013272237046,
  0.3429013272237046,
  1.0366108297895137,
  1.7566836492998818,
  2.5327316742327897,
  3.4361591188377376,
];

const GAUSS_HERMITE_10_WEIGHTS = [
  0.00000764043285523262,
  0.0013436457467812327,
  0.03387439445548106,
  0.2401386110823147,
  0.6108626337353258,
  0.6108626337353258,
  0.2401386110823147,
  0.03387439445548106,
  0.0013436457467812327,
  0.00000764043285523262,
];

function hitProbabilityBrownianWindow(params: {
  lower: number;
  upper: number;
  sigma: number;
  windowStart: number;
  windowDuration: number;
}): number {
  const lower = toNumber(params.lower, 0);
  const upper = toNumber(params.upper, 0);
  const sigma = toNumber(params.sigma, 0);
  const windowStart = Math.max(0, toNumber(params.windowStart, 0));
  const windowDuration = Math.max(0, toNumber(params.windowDuration, 0));

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(sigma) || sigma <= 0) return 0;

  const normalizedLower = Math.min(lower, upper);
  const normalizedUpper = Math.max(lower, upper);
  const sigmaWindow = sigma * Math.sqrt(windowDuration);

  const conditional = (position: number): number => {
    if (position >= normalizedLower && position <= normalizedUpper) return 1;
    if (sigmaWindow <= 0) return 0;

    const distance =
      position > normalizedUpper ? position - normalizedUpper : normalizedLower - position;
    const z = distance / sigmaWindow;
    const tail = 1 - standardNormalCdf(z);
    const probability = 2 * tail;
    if (!Number.isFinite(probability) || probability <= 0) return 0;
    return probability >= 1 ? 1 : probability;
  };

  if (windowStart <= 0) {
    return conditional(0);
  }

  const sigmaStart = sigma * Math.sqrt(windowStart);
  if (!Number.isFinite(sigmaStart) || sigmaStart <= 0) {
    return conditional(0);
  }

  let sum = 0;
  for (let i = 0; i < GAUSS_HERMITE_10_NODES.length; i += 1) {
    const node = GAUSS_HERMITE_10_NODES[i]!;
    const weight = GAUSS_HERMITE_10_WEIGHTS[i]!;
    const z = SQRT2 * node; // convert Hermite nodes to standard normal samples
    sum += weight * conditional(sigmaStart * z);
  }

  const probability = sum / SQRT_PI;
  if (!Number.isFinite(probability) || probability <= 0) return 0;
  return probability >= 1 ? 1 : probability;
}

function standardNormalCdf(z: number): number {
  if (!Number.isFinite(z)) return z === Number.POSITIVE_INFINITY ? 1 : 0;
  if (z > 8) return 1;
  if (z < -8) return 0;
  return 0.5 * (1 + erf(z / SQRT2));
}

// Abramowitz and Stegun formula 7.1.26, max error ~1.5e-7.
function erf(x: number): number {
  if (!Number.isFinite(x)) return x === Number.POSITIVE_INFINITY ? 1 : -1;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absX);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-absX * absX);

  return sign * y;
}
