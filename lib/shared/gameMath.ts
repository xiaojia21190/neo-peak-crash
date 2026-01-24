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

export const MULTIPLIER_MODEL = {
  sigma: 3.7,
  baseProbability: 0.9,
  timePenalty: 0.03,
} as const;

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

export function calculateMultiplier(
  targetRow: number,
  referenceRow: number = CENTER_ROW_INDEX,
  timeDeltaSeconds: number = 0
): number {
  const adjustedProbability = calculateAdjustedProbability(targetRow, referenceRow, timeDeltaSeconds);

  // Avoid Infinity in pathological cases.
  const fairPayout = adjustedProbability > 0 ? 1 / adjustedProbability : MAX_MULTIPLIER;
  const housePayout = fairPayout * (1 - HOUSE_EDGE);

  const clamped = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, housePayout));
  return Math.round(clamped * 10000) / 10000;
}

export function calculateAdjustedProbability(
  targetRow: number,
  referenceRow: number = CENTER_ROW_INDEX,
  timeDeltaSeconds: number = 0
): number {
  const distance = Math.abs(targetRow - referenceRow);
  const timePenalty = 1 + Math.max(0, timeDeltaSeconds) * MULTIPLIER_MODEL.timePenalty;
  return (MULTIPLIER_MODEL.baseProbability *
    Math.exp(-(distance * distance) / (2 * MULTIPLIER_MODEL.sigma * MULTIPLIER_MODEL.sigma))) / timePenalty;
}
