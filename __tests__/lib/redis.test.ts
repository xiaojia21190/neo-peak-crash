import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeRedisClient,
  getRedisClient,
  getRedisPubClient,
  getRedisSubClient,
} from '../../lib/redis';

type Listener = (...args: any[]) => void;

class FakeRedis {
  static instances: FakeRedis[] = [];

  url: string;
  options: any;
  quitCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string, options?: any) {
    this.url = url;
    this.options = options;
    FakeRedis.instances.push(this);
  }

  on(event: string, listener: Listener) {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  async quit() {
    this.quitCalls += 1;
  }
}

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

let logs: unknown[][] = [];
let warns: unknown[][] = [];
let errors: unknown[][] = [];

(globalThis as any).__redisConstructor = FakeRedis;

after(async () => {
  delete (globalThis as any).__redisConstructor;
  await closeRedisClient();

  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
});

beforeEach(async () => {
  await closeRedisClient();
  FakeRedis.instances.length = 0;

  logs = [];
  warns = [];
  errors = [];

  console.log = (...args: unknown[]) => { logs.push(args); };
  console.warn = (...args: unknown[]) => { warns.push(args); };
  console.error = (...args: unknown[]) => { errors.push(args); };
});

describe('lib/redis getRedisClient options', () => {
  test('reconnectOnError handles timeouts', () => {
    const client = getRedisClient() as unknown as FakeRedis;
    const reconnectOnError = client.options.reconnectOnError as (err: Error) => boolean;

    assert.equal(reconnectOnError(new Error('ETIMEDOUT: timeout')), true);
    assert.equal(reconnectOnError(new Error('SOME_OTHER_ERROR')), false);
  });

  test('retryStrategy delays and stops after too many retries', () => {
    const client = getRedisClient() as unknown as FakeRedis;
    const retryStrategy = client.options.retryStrategy as (times: number) => number | null;

    assert.equal(retryStrategy(1), 100);
    assert.ok(logs.some((entry) => String(entry[0]).includes('Reconnecting in 100ms')));

    assert.equal(retryStrategy(11), null);
    assert.ok(errors.some((entry) => String(entry[0]).includes('Max retries reached')));
  });
});

describe('lib/redis event handlers', () => {
  test('logs connect/close and command errors', () => {
    const client = getRedisClient() as unknown as FakeRedis;

    client.emit('connect');
    assert.ok(logs.some((entry) => String(entry[0]).includes('[Redis] Connected')));

    client.emit('error', new Error('boom'));
    assert.ok(errors.some((entry) => String(entry[0]).includes('[Redis] Error:')));

    client.emit('close');
    assert.ok(warns.some((entry) => String(entry[0]).includes('[Redis] Connection closed')));
  });
});

describe('lib/redis pub/sub and cleanup', () => {
  test('creates pub/sub clients and closes all clients', async () => {
    const client = getRedisClient() as unknown as FakeRedis;
    const pub = getRedisPubClient() as unknown as FakeRedis;
    const sub = getRedisSubClient() as unknown as FakeRedis;

    assert.equal(FakeRedis.instances.length, 3);
    assert.equal(pub.options, undefined);
    assert.equal(sub.options, undefined);

    await closeRedisClient();

    assert.equal(client.quitCalls, 1);
    assert.equal(pub.quitCalls, 1);
    assert.equal(sub.quitCalls, 1);

    const newClient = getRedisClient() as unknown as FakeRedis;
    assert.notEqual(newClient, client);
  });
});

