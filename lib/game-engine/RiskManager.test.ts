import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from './RiskManager';

test('RiskManager.calculateMetrics aggregates pending real bets', () => {
  const manager = new RiskManager({ maxRoundPayout: 1000 });
  const metrics = manager.calculateMetrics(
    [
      { amount: 10, multiplier: 2, isPlayMode: false, status: 'PENDING' },
      { amount: 5, multiplier: 3, isPlayMode: true, status: 'PENDING' },
      { amount: 7, multiplier: 2, isPlayMode: false, status: 'WON' },
    ],
    5000
  );

  assert.equal(metrics.totalBetAmount, 10);
  assert.equal(metrics.expectedPayout, 20);
  assert.equal(metrics.poolBalance, 5000);
  assert.equal(metrics.maxRoundPayout, 1000);
  assert.equal(metrics.remainingPayoutCapacity, 980);
});

test('RiskManager.calculateMaxBet uses remaining payout capacity', () => {
  const manager = new RiskManager({ maxRoundPayout: 1500 });
  const maxBet = manager.calculateMaxBet({
    activeBets: [{ amount: 100, multiplier: 10, status: 'PENDING' }],
    poolBalance: 10000,
    multiplier: 5,
    baseMaxBet: 500,
  });

  assert.equal(maxBet, 100);
});

test('RiskManager.assessBet rejects when projected payout exceeds cap', () => {
  const manager = new RiskManager({ maxRoundPayout: 1000 });
  const assessment = manager.assessBet({
    activeBets: [{ amount: 90, multiplier: 10, status: 'PENDING' }],
    poolBalance: 10000,
    amount: 50,
    multiplier: 3,
    baseMaxBet: 500,
  });

  assert.equal(assessment.allowed, false);
  assert.equal(assessment.maxBetAllowed, 33.33);
});

test('RiskManager.assessBet respects invalid pool balance', () => {
  const manager = new RiskManager({ maxRoundPayout: 500 });
  const assessment = manager.assessBet({
    activeBets: [],
    poolBalance: -100,
    amount: 10,
    multiplier: 2,
    baseMaxBet: 100,
  });

  assert.equal(assessment.allowed, false);
  assert.equal(assessment.maxBetAllowed, 0);
});

test('RiskManager.calculateMetrics skips invalid bet entries', () => {
  const manager = new RiskManager({ maxRoundPayoutRatio: 0.1 });
  const metrics = manager.calculateMetrics(
    [
      null as any,
      { amount: Number.NaN, multiplier: 2, status: 'PENDING' },
      { amount: 10, multiplier: Number.POSITIVE_INFINITY, status: 'PENDING' },
      { amount: 5, multiplier: 2, status: 'PENDING' },
    ],
    1000
  );

  assert.equal(metrics.totalBetAmount, 5);
  assert.equal(metrics.expectedPayout, 10);
  assert.equal(metrics.maxRoundPayout, 100);
});

test('RiskManager.calculateMaxBet rejects invalid multiplier', () => {
  const manager = new RiskManager({ maxRoundPayout: 1000 });
  const maxBet = manager.calculateMaxBet({
    activeBets: [],
    poolBalance: 1000,
    multiplier: 0,
    baseMaxBet: 100,
  });

  assert.equal(maxBet, 0);
});

test('RiskManager.assessBet rejects non-finite payout', () => {
  const manager = new RiskManager({ maxRoundPayout: 1000 });
  const assessment = manager.assessBet({
    activeBets: [],
    poolBalance: 1000,
    amount: 10,
    multiplier: Number.NaN,
    baseMaxBet: 100,
  });

  assert.equal(assessment.allowed, false);
});
