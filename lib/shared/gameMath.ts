export const HOUSE_EDGE = 0.06;

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

export function clampRowIndex(rowIndex: number): number {
  return Math.max(MIN_ROW_INDEX, Math.min(MAX_ROW_INDEX, rowIndex));
}

// Money is stored as Decimal(18,2) in DB, so always round payouts/balances to cents.
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function calculateMultiplier(
  targetRow: number,
  referenceRow: number = CENTER_ROW_INDEX,
  timeDeltaSeconds: number = 0
): number {
  const distance = Math.abs(targetRow - referenceRow);

  const sigma = 3.5;
  const baseProbability = 0.92;

  // Apply time bonus to probability calculation to maintain house edge
  const timeBonus = 1 + Math.max(0, timeDeltaSeconds) * 0.04;
  const adjustedProbability = (baseProbability * Math.exp(-(distance * distance) / (2 * sigma * sigma))) / timeBonus;

  // Avoid Infinity in pathological cases.
  const fairPayout = adjustedProbability > 0 ? 1 / adjustedProbability : MAX_MULTIPLIER;
  const housePayout = fairPayout * (1 - HOUSE_EDGE);

  const clamped = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, housePayout));
  return Math.round(clamped * 10000) / 10000;
}
