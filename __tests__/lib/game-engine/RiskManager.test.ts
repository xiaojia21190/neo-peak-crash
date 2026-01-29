import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../../../lib/game-engine/RiskManager';

class FakeRedis {
  strings = new Map<string, string>();

  async get(key: string) {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async eval(script: string, numKeys: number, ...args: any[]) {
    if (script.includes('risk:reserve_expected_payout')) {
      if (numKeys !== 2) throw new Error('Invalid key count');
      const [reservedKey, reservationKey, maxPayoutRaw, deltaRaw] = args;
      const maxPayout = Number(maxPayoutRaw);
      const delta = Number(deltaRaw);
      const existing = this.strings.get(String(reservationKey));
      const currentTotal = Number(this.strings.get(String(reservedKey)) ?? 0);

      if (existing != null) {
        return [1, 0, currentTotal, Number(existing)];
      }

      if (currentTotal + delta > maxPayout + 1e-6) {
        return [0, 0, currentTotal, 0];
      }

      const nextTotal = currentTotal + delta;
      this.strings.set(String(reservedKey), String(nextTotal));
      this.strings.set(String(reservationKey), String(delta));
      return [1, 1, nextTotal, delta];
    }

    if (script.includes('risk:release_expected_payout')) {
      if (numKeys !== 2) throw new Error('Invalid key count');
      const [reservedKey, reservationKey] = args;
      const existing = this.strings.get(String(reservationKey));
      const currentTotal = Number(this.strings.get(String(reservedKey)) ?? 0);
      if (existing == null) {
        return [0, currentTotal, 0];
      }
      const delta = Number(existing);
      const nextTotal = Math.max(0, currentTotal - delta);
      this.strings.set(String(reservedKey), String(nextTotal));
      this.strings.delete(String(reservationKey));
      return [1, nextTotal, delta];
    }

    throw new Error('Unsupported eval script');
  }
}

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

test('RiskManager.reserveExpectedPayout enforces maxRoundPayout and is idempotent per orderId', async () => {
  const manager = new RiskManager({ maxRoundPayout: 100 });
  const redis = new FakeRedis();

  const roundId = 'round-1';
  const ttlMs = 60000;

  const first = await manager.reserveExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-1',
    expectedPayout: 60,
    maxRoundPayout: 100,
    ttlMs,
  });

  assert.equal(first.allowed, true);
  assert.equal(first.didReserve, true);
  assert.equal(first.reservedTotal, 60);

  const duplicate = await manager.reserveExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-1',
    expectedPayout: 60,
    maxRoundPayout: 100,
    ttlMs,
  });

  assert.equal(duplicate.allowed, true);
  assert.equal(duplicate.didReserve, false);
  assert.equal(duplicate.reservedTotal, 60);

  const rejected = await manager.reserveExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-2',
    expectedPayout: 50,
    maxRoundPayout: 100,
    ttlMs,
  });

  assert.equal(rejected.allowed, false);
  assert.equal(rejected.didReserve, false);
  assert.equal(rejected.reservedTotal, 60);
});

test('RiskManager.releaseExpectedPayout decrements reserved total once', async () => {
  const manager = new RiskManager({ maxRoundPayout: 100 });
  const redis = new FakeRedis();
  const roundId = 'round-2';
  const ttlMs = 60000;

  await manager.reserveExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-1',
    expectedPayout: 25,
    maxRoundPayout: 100,
    ttlMs,
  });

  const release = await manager.releaseExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-1',
    ttlMs,
  });

  assert.equal(release.released, true);
  assert.equal(release.releasedAmount, 25);
  assert.equal(release.reservedTotal, 0);

  const second = await manager.releaseExpectedPayout({
    redis: redis as any,
    roundId,
    orderId: 'order-1',
    ttlMs,
  });

  assert.equal(second.released, false);
  assert.equal(second.reservedTotal, 0);
});
