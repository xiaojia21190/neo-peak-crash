import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../../../lib/game-engine/RiskManager';

test('RiskManager.calculateMetrics filters bets and computes capacity', () => {
  const manager = new RiskManager({ maxRoundPayoutRatio: 0.1 });

  const metrics = manager.calculateMetrics(
    [
      { amount: 10, multiplier: 2, isPlayMode: false, status: 'PENDING' },
      { amount: 5, multiplier: 3, isPlayMode: true, status: 'PENDING' },
      { amount: 2, multiplier: 4, isPlayMode: false, status: 'WON' },
      { amount: Number.NaN, multiplier: 2, isPlayMode: false, status: 'PENDING' },
    ],
    1000
  );

  assert.equal(metrics.totalBetAmount, 10);
  assert.equal(metrics.expectedPayout, 20);
  assert.equal(metrics.maxRoundPayout, 100);
  assert.equal(metrics.remainingPayoutCapacity, 80);
});

test('RiskManager.assessBet blocks invalid or oversized bets', () => {
  const manager = new RiskManager({ maxRoundPayoutRatio: 0.1 });

  const invalid = manager.assessBet({
    activeBets: [],
    poolBalance: 1000,
    amount: -1,
    multiplier: 2,
    baseMaxBet: 100,
  });
  assert.equal(invalid.allowed, false);

  const oversized = manager.assessBet({
    activeBets: [],
    poolBalance: 100,
    amount: 50,
    multiplier: 10,
    baseMaxBet: 100,
  });
  assert.equal(oversized.allowed, false);
});

test('RiskManager.calculateMaxBet guards invalid multiplier', () => {
  const manager = new RiskManager();

  const result = manager.calculateMaxBet({
    activeBets: [],
    poolBalance: 1000,
    multiplier: 0,
    baseMaxBet: 100,
  });

  assert.equal(result, 0);
});

test('RiskManager.assessBet allows reasonable bets', () => {
  const manager = new RiskManager({ maxRoundPayoutRatio: 0.2 });

  const allowed = manager.assessBet({
    activeBets: [],
    poolBalance: 1000,
    amount: 10,
    multiplier: 1.5,
    baseMaxBet: 100,
  });

  assert.equal(allowed.allowed, true);
  assert.ok(allowed.maxBetAllowed > 0);
});
