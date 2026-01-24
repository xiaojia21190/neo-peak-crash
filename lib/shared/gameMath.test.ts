import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAdjustedProbability,
  calculateMultiplier,
  clampRowIndex,
  isValidMoneyAmount,
  roundMoney,
  toNumber,
  HOUSE_EDGE,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  MIN_ROW_INDEX,
  MAX_ROW_INDEX,
  CENTER_ROW_INDEX,
} from './gameMath';

test('clampRowIndex clamps to bounds', () => {
  assert.equal(clampRowIndex(-10), MIN_ROW_INDEX);
  assert.equal(clampRowIndex(MAX_ROW_INDEX + 4), MAX_ROW_INDEX);
  assert.equal(clampRowIndex(6), 6);
});

test('roundMoney rounds to cents', () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(10.334), 10.33);
});

test('toNumber normalizes inputs and falls back safely', () => {
  assert.equal(toNumber(null, 7), 7);
  assert.equal(toNumber(undefined, 7), 7);

  assert.equal(toNumber(12.5, 7), 12.5);
  assert.equal(toNumber(Number.NaN, 7), 7);
  assert.equal(toNumber(Number.POSITIVE_INFINITY, 7), 7);

  assert.equal(toNumber('12.5', 7), 12.5);

  assert.equal(toNumber({ toNumber: () => 9.25 }, 7), 9.25);
  assert.equal(toNumber({ toNumber: () => Number.POSITIVE_INFINITY }, 7), 7);
  assert.equal(
    toNumber(
      {
        toNumber: () => {
          throw new Error('bad');
        },
      },
      7
    ),
    7
  );
});

test('isValidMoneyAmount validates at most 2 decimals', () => {
  assert.equal(isValidMoneyAmount(10.0), true);
  assert.equal(isValidMoneyAmount(10.5), true);
  assert.equal(isValidMoneyAmount(10.55), true);

  assert.equal(isValidMoneyAmount(10.001), false);
  assert.equal(isValidMoneyAmount(10.555), false);

  assert.equal(isValidMoneyAmount(Number.NaN), false);
  assert.equal(isValidMoneyAmount(Number.POSITIVE_INFINITY), false);
});

test('calculateMultiplier stays within bounds', () => {
  const multiplier = calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0);
  assert.ok(multiplier >= MIN_MULTIPLIER);
  assert.ok(multiplier <= MAX_MULTIPLIER);
});

test('calculateMultiplier increases with time penalty', () => {
  const short = calculateMultiplier(4, CENTER_ROW_INDEX, 2);
  const long = calculateMultiplier(4, CENTER_ROW_INDEX, 10);
  assert.ok(long > short);
});

test('calculateAdjustedProbability decreases with distance', () => {
  const near = calculateAdjustedProbability(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 3);
  const far = calculateAdjustedProbability(MIN_ROW_INDEX, CENTER_ROW_INDEX, 3);
  assert.ok(near > far);
});

test('calculateMultiplier applies house edge consistently', () => {
  const cases = [
    { targetRow: 3, referenceRow: CENTER_ROW_INDEX, timeDelta: 4 },
    { targetRow: 10, referenceRow: CENTER_ROW_INDEX, timeDelta: 6 },
  ];

  for (const { targetRow, referenceRow, timeDelta } of cases) {
    const probability = calculateAdjustedProbability(targetRow, referenceRow, timeDelta);
    const multiplier = calculateMultiplier(targetRow, referenceRow, timeDelta);
    assert.ok(multiplier > MIN_MULTIPLIER && multiplier < MAX_MULTIPLIER);
    const houseEdge = 1 - probability * multiplier;
    assert.ok(houseEdge >= HOUSE_EDGE - 0.005);
  }
});

test('calculateMultiplier handles degenerate probability', () => {
  const multiplier = calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, Number.POSITIVE_INFINITY);
  const expected = Math.round(MAX_MULTIPLIER * (1 - HOUSE_EDGE) * 10000) / 10000;
  assert.equal(multiplier, expected);
});
