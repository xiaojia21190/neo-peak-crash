import test from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../../../lib/game-engine/LockManager';
import { REDIS_KEYS } from '../../../lib/game-engine/constants';

class FakeRedis {
  private store = new Map<string, string>();

  async set(key: string, value: string, mode: string, ttl: number, flag: string) {
    if (flag === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string) {
    const existed = this.store.delete(key);
    return existed ? 1 : 0;
  }

  async eval(_script: string, _keys: number, key: string, token: string) {
    const current = this.store.get(key);
    if (current === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async exists(key: string) {
    return this.store.has(key) ? 1 : 0;
  }
}

test('LockManager handles round locks', async () => {
  const redis = new FakeRedis();
  const manager = new LockManager(redis as any);

  const token = await manager.acquireRoundLock('BTCUSDT', 5000);
  assert.ok(token);

  const released = await manager.releaseRoundLock('BTCUSDT');
  assert.equal(released, true);

  const releasedAgain = await manager.releaseRoundLock('BTCUSDT');
  assert.equal(releasedAgain, false);
});

test('LockManager handles bet locks', async () => {
  const redis = new FakeRedis();
  const manager = new LockManager(redis as any);

  const first = await manager.acquireBetLock('order-1', 30000);
  const second = await manager.acquireBetLock('order-1', 30000);

  assert.ok(first);
  assert.equal(second, null);

  const wrongRelease = await manager.releaseBetLock('order-1', 'bad-token');
  assert.equal(wrongRelease, false);

  const released = await manager.releaseBetLock('order-1', first!);
  assert.equal(released, true);

  const third = await manager.acquireBetLock('order-1', 30000);
  assert.ok(third);
  assert.notEqual(third, first);

  const lockKey = `${REDIS_KEYS.BET_LOCK}order-1`;
  assert.equal(await redis.exists(lockKey), 1);
});

test('LockManager ignores stale bet lock tokens', async () => {
  const redis = new FakeRedis();
  const manager = new LockManager(redis as any);

  const lockKey = `${REDIS_KEYS.BET_LOCK}order-expire`;
  const first = await manager.acquireBetLock('order-expire', 30000);
  assert.ok(first);

  await redis.del(lockKey);

  const second = await manager.acquireBetLock('order-expire', 30000);
  assert.ok(second);

  const released = await manager.releaseBetLock('order-expire', first!);
  assert.equal(released, false);
  assert.equal(await redis.exists(lockKey), 1);
});
