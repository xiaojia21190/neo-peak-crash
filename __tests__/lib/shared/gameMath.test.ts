import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAdjustedProbability,
  calculateMultiplier,
  clampRowIndex,
  isHitByTickSeries,
  isValidMoneyAmount,
  roundMoney,
  toNumber,
  CENTER_ROW_INDEX,
  MAX_MULTIPLIER,
  MAX_ROW_INDEX,
  MIN_MULTIPLIER,
  MIN_ROW_INDEX,
} from '../../../lib/shared/gameMath';

test('clampRowIndex clamps to bounds', () => {
  assert.equal(clampRowIndex(-10), MIN_ROW_INDEX);
  assert.equal(clampRowIndex(MAX_ROW_INDEX + 4), MAX_ROW_INDEX);
  assert.equal(clampRowIndex(6), 6);
});

test('roundMoney rounds to cents (including negative)', () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(10.334), 10.33);
  assert.equal(roundMoney(-1.005), -1);
});

test('toNumber handles edge inputs', () => {
  assert.equal(toNumber(null, 7), 7);
  assert.equal(toNumber(undefined, 7), 7);
  assert.equal(toNumber(' 12.5 ', 7), 12.5);
  assert.equal(toNumber('not-a-number', 7), 7);
  assert.equal(toNumber(Number.NaN, 7), 7);
  assert.equal(toNumber(Number.POSITIVE_INFINITY, 7), 7);
  assert.equal(toNumber({ valueOf: () => 42 } as any, 7), 42);
});

test('isValidMoneyAmount validates at most 2 decimals', () => {
  assert.equal(isValidMoneyAmount(10.0), true);
  assert.equal(isValidMoneyAmount(10.5), true);
  assert.equal(isValidMoneyAmount(10.55), true);
  assert.equal(isValidMoneyAmount(10.001), false);
  assert.equal(isValidMoneyAmount(Number.NaN), false);
});

describe('isHitByTickSeries boundaries', () => {
  test('returns false for insufficient ticks', () => {
    assert.equal(isHitByTickSeries({ ticks: [], targetTime: 1, targetRow: 1 }), false);
    assert.equal(isHitByTickSeries({ ticks: [{ elapsed: 0, row: 0 }], targetTime: 1, targetRow: 1 }), false);
  });

  test('returns true when target row intersects between two ticks', () => {
    const ticks = [
      { elapsed: 1.0, row: 5 },
      { elapsed: 1.2, row: 7 },
    ];

    assert.equal(isHitByTickSeries({ ticks, targetTime: 1.1, targetRow: 6 }), true);
  });

  test('includes hits at time window boundary', () => {
    const ticks = [
      { elapsed: 0.0, row: 0 },
      { elapsed: 0.5, row: 1 },
    ];

    assert.equal(
      isHitByTickSeries({
        ticks,
        targetTime: 1,
        targetRow: 0,
        hitTimeToleranceSeconds: 0.5,
        hitRowTolerance: 0,
      }),
      true
    );
  });

  test('returns false when target time window misses ticks', () => {
    const ticks = [
      { elapsed: 0.0, row: 0 },
      { elapsed: 0.4, row: 1 },
      { elapsed: 0.9, row: 2 },
    ];

    assert.equal(
      isHitByTickSeries({ ticks, targetTime: 2, targetRow: 1, hitTimeToleranceSeconds: 0.1, hitRowTolerance: 0 }),
      false
    );
  });

  test('skips non-finite tick samples', () => {
    const ticks = [
      { elapsed: 0.0, row: 0 },
      { elapsed: Number.NaN, row: 100 },
      { elapsed: 0.6, row: 1 },
    ];

    assert.equal(
      isHitByTickSeries({ ticks, targetTime: 0.6, targetRow: 1, hitTimeToleranceSeconds: 0.2, hitRowTolerance: 0 }),
      true
    );
  });
});

describe('calculateAdjustedProbability boundaries', () => {
  test('returns 0 for invalid model params', () => {
    assert.equal(calculateAdjustedProbability(1, CENTER_ROW_INDEX, 1, { model: { sigma: 0 } }), 0);
    assert.equal(calculateAdjustedProbability(1, CENTER_ROW_INDEX, 1, { model: { baseProbability: 0 } }), 0);
  });

  test('clamps negative time delta to 0 and returns finite probability', () => {
    const probability = calculateAdjustedProbability(CENTER_ROW_INDEX, CENTER_ROW_INDEX, -10);
    assert.ok(Number.isFinite(probability));
    assert.ok(probability >= 0 && probability <= 1);
  });
});

describe('calculateMultiplier boundaries', () => {
  test('stays within min/max for extreme inputs', () => {
    const cases = [
      calculateMultiplier(MIN_ROW_INDEX - 1000, CENTER_ROW_INDEX, 0),
      calculateMultiplier(MAX_ROW_INDEX + 1000, CENTER_ROW_INDEX, 0),
      calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 999999),
      calculateMultiplier(Number.NaN, CENTER_ROW_INDEX, 1),
    ];

    for (const multiplier of cases) {
      assert.ok(Number.isFinite(multiplier));
      assert.ok(multiplier >= MIN_MULTIPLIER);
      assert.ok(multiplier <= MAX_MULTIPLIER);
    }
  });
});

