import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DistributedLock } from '../../../lib/game-engine/DistributedLock';

class FakeRedis {
  setCalls: any[] = [];
  evalCalls: any[] = [];
  existsCalls: any[] = [];

  setResult: any = null;
  evalResult: any = 0;
  existsResult: any = 0;

  async set(...args: any[]) {
    this.setCalls.push(args);
    return this.setResult;
  }

  async eval(...args: any[]) {
    this.evalCalls.push(args);
    return this.evalResult;
  }

  async exists(...args: any[]) {
    this.existsCalls.push(args);
    return this.existsResult;
  }
}

describe('lib/game-engine/DistributedLock acquire', () => {
  test('returns token on success', async () => {
    const redis = new FakeRedis();
    redis.setResult = 'OK';

    const lock = new DistributedLock(redis as any);
    const token = await lock.acquire('lock:key', 123);

    assert.ok(token);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(redis.setCalls.length, 1);
    assert.deepEqual(redis.setCalls[0], ['lock:key', token, 'PX', 123, 'NX']);
  });

  test('returns null on failure', async () => {
    const redis = new FakeRedis();
    redis.setResult = null;

    const lock = new DistributedLock(redis as any);
    const token = await lock.acquire('lock:key', 123);
    assert.equal(token, null);
  });
});

describe('lib/game-engine/DistributedLock release/extend/exists', () => {
  test('release returns true when eval returns 1, false when returns 0', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedLock(redis as any);

    redis.evalResult = 1;
    assert.equal(await lock.release('lock:key', 'token'), true);

    redis.evalResult = 0;
    assert.equal(await lock.release('lock:key', 'token'), false);
  });

  test('extend returns true/false based on eval result', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedLock(redis as any);

    redis.evalResult = 1;
    assert.equal(await lock.extend('lock:key', 'token', 500), true);

    redis.evalResult = 0;
    assert.equal(await lock.extend('lock:key', 'token', 500), false);
  });

  test('exists returns true when redis.exists returns 1, false otherwise', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedLock(redis as any);

    redis.existsResult = 1;
    assert.equal(await lock.exists('lock:key'), true);

    redis.existsResult = 0;
    assert.equal(await lock.exists('lock:key'), false);
  });
});

