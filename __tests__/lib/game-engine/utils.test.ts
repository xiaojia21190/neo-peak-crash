import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRowIndex,
  createDebouncer,
  createThrottler,
  delay,
  generateOrderId,
  withTimeout,
} from '../../../lib/game-engine/utils';
import { CENTER_ROW_INDEX, MAX_ROW_INDEX, MIN_ROW_INDEX } from '../../../lib/game-engine/constants';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('lib/game-engine/utils calculateRowIndex', () => {
  test('center price returns center index', () => {
    assert.equal(calculateRowIndex(100, 100), CENTER_ROW_INDEX);
  });

  test('price increase/decrease shifts row', () => {
    assert.ok(Math.abs(calculateRowIndex(100.1, 100) - (CENTER_ROW_INDEX - 1)) < 1e-9);
    assert.ok(Math.abs(calculateRowIndex(99.9, 100) - (CENTER_ROW_INDEX + 1)) < 1e-9);
  });

  test('boundary clamping', () => {
    assert.equal(calculateRowIndex(200, 100), MIN_ROW_INDEX);
    assert.equal(calculateRowIndex(0, 100), MAX_ROW_INDEX);
  });
});

describe('lib/game-engine/utils generateOrderId', () => {
  test('returns string with timestamp prefix and hex suffix', () => {
    const before = Date.now();
    const id = generateOrderId();
    const after = Date.now();

    assert.match(id, /^\d+-[0-9a-f]{8}$/);

    const [timestampRaw] = id.split('-', 1);
    const timestamp = Number(timestampRaw);
    assert.ok(Number.isFinite(timestamp));
    assert.ok(timestamp >= before && timestamp <= after);
  });

  test('returns unique ids', () => {
    const first = generateOrderId();
    const second = generateOrderId();
    assert.notEqual(first, second);
  });
});

describe('lib/game-engine/utils createThrottler', () => {
  test('executes immediately first call, suppresses within interval, allows after interval', async () => {
    const calls: number[] = [];
    const throttled = createThrottler((value: number) => {
      calls.push(value);
    }, 50);

    throttled(1);
    throttled(2);
    assert.deepEqual(calls, [1]);

    await sleep(60);

    throttled(3);
    assert.deepEqual(calls, [1, 3]);
  });
});

describe('lib/game-engine/utils createDebouncer', () => {
  test('delays execution, resets timer on subsequent calls', async () => {
    const calls: number[] = [];
    const debounced = createDebouncer((value: number) => {
      calls.push(value);
    }, 50);

    debounced(1);
    await sleep(25);
    debounced(2);

    await sleep(40);
    assert.deepEqual(calls, []);

    await sleep(20);
    assert.deepEqual(calls, [2]);
  });
});

describe('lib/game-engine/utils delay', () => {
  test('resolves after specified ms', async () => {
    const startedAt = Date.now();
    await delay(50);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 40);
  });
});

describe('lib/game-engine/utils withTimeout', () => {
  test('resolves when promise completes within timeout', async () => {
    const result = await withTimeout(sleep(20).then(() => 'ok'), 80);
    assert.equal(result, 'ok');
  });

  test('rejects when exceeds timeout', async () => {
    await assert.rejects(() => withTimeout(sleep(80).then(() => 'late'), 30), /Operation timed out/);
  });
});
