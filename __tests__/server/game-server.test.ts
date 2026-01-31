import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler, recoverOrphanedRounds } from '../../server/game-server';

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

async function runHandler(
  handler: (req: any, res: any) => void,
  opts: { url: string; headers?: Record<string, string> }
): Promise<CapturedResponse> {
  return await new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};

    const res = {
      writeHead(code: number, resHeaders?: Record<string, string>) {
        statusCode = code;
        if (resHeaders) {
          Object.assign(headers, resHeaders);
        }
      },
      end(body?: unknown) {
        resolve({ statusCode, headers, body: body === undefined ? '' : String(body) });
      },
    };

    const req = { url: opts.url, headers: opts.headers ?? {} };
    handler(req, res);
  });
}

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

let logs: unknown[][] = [];
let warns: unknown[][] = [];
let errors: unknown[][] = [];

beforeEach(() => {
  logs = [];
  warns = [];
  errors = [];

  console.log = (...args: unknown[]) => { logs.push(args); };
  console.warn = (...args: unknown[]) => { warns.push(args); };
  console.error = (...args: unknown[]) => { errors.push(args); };
});

after(() => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
});

describe('server/game-server createRequestHandler', () => {
  test('/health returns 200 with status/timestamp/uptime', async () => {
    const handler = createRequestHandler({ gateway: null, adminToken: 'secret' });
    const response = await runHandler(handler, { url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'application/json');

    const parsed = JSON.parse(response.body) as { status: string; timestamp: string; uptime: number };
    assert.equal(parsed.status, 'ok');
    assert.equal(Number.isNaN(Date.parse(parsed.timestamp)), false);
    assert.equal(typeof parsed.uptime, 'number');
  });

  test('/stats without auth returns 401', async () => {
    const handler = createRequestHandler({
      gateway: { getStats: () => ({ totalConnections: 1 }) },
      adminToken: 'secret',
    });
    const response = await runHandler(handler, { url: '/stats' });

    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['WWW-Authenticate'], 'Bearer');
    assert.deepEqual(JSON.parse(response.body), { error: 'Unauthorized' });
  });

  test('/stats with wrong token returns 401', async () => {
    const handler = createRequestHandler({
      gateway: { getStats: () => ({ totalConnections: 1 }) },
      adminToken: 'secret',
    });
    const response = await runHandler(handler, {
      url: '/stats',
      headers: { authorization: 'Bearer wrong' },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['WWW-Authenticate'], 'Bearer');
    assert.deepEqual(JSON.parse(response.body), { error: 'Unauthorized' });
  });

  test('/stats with correct token returns 200 with gateway stats', async () => {
    const handler = createRequestHandler({
      gateway: { getStats: () => ({ totalConnections: 3, authenticatedUsers: 2 }) },
      adminToken: 'secret',
    });
    const response = await runHandler(handler, {
      url: '/stats',
      headers: { authorization: 'Bearer secret' },
    });

    assert.equal(response.statusCode, 200);
    const parsed = JSON.parse(response.body) as {
      totalConnections: number;
      authenticatedUsers: number;
      timestamp: string;
    };
    assert.equal(parsed.totalConnections, 3);
    assert.equal(parsed.authenticatedUsers, 2);
    assert.equal(Number.isNaN(Date.parse(parsed.timestamp)), false);
  });

  test('/stats returns 503 when gateway not ready', async () => {
    const handler = createRequestHandler({
      gateway: null,
      adminToken: 'secret',
    });
    const response = await runHandler(handler, {
      url: '/stats',
      headers: { authorization: 'Bearer secret' },
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'Gateway not ready' });
  });

  test('/stats returns 500 when ADMIN_TOKEN not configured', async () => {
    const handler = createRequestHandler({
      gateway: { getStats: () => ({ totalConnections: 1 }) },
      adminToken: undefined,
    });
    const response = await runHandler(handler, { url: '/stats' });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), { error: 'ADMIN_TOKEN is not configured' });
  });

  test('unknown path returns 404', async () => {
    const handler = createRequestHandler({ gateway: null, adminToken: 'secret' });
    const response = await runHandler(handler, { url: '/nope' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'Not Found');
  });
});

describe('server/game-server recoverOrphanedRounds', () => {
  test('no orphaned rounds (no-op)', async () => {
    const roundUpdates: any[] = [];
    const betQueries: any[] = [];
    const updateManyCalls: any[] = [];
    let transactionCalls = 0;
    let changeBalanceCalls = 0;
    let applyDeltaCalls = 0;

    const prisma = {
      round: {
        findMany: async () => [],
        update: async (args: any) => { roundUpdates.push(args); },
      },
      bet: {
        findMany: async (args: any) => { betQueries.push(args); return []; },
      },
      $transaction: async (fn: any) => {
        transactionCalls += 1;
        return fn({
          bet: {
            updateMany: async (args: any) => { updateManyCalls.push(args); return { count: 1 }; },
          },
        });
      },
    };

    const financialService = {
      changeBalance: async () => { changeBalanceCalls += 1; },
    };
    const housePoolService = {
      applyDelta: async () => { applyDeltaCalls += 1; },
    };

    await recoverOrphanedRounds({ prisma, financialService, housePoolService });

    assert.equal(roundUpdates.length, 0);
    assert.equal(betQueries.length, 0);
    assert.equal(transactionCalls, 0);
    assert.equal(changeBalanceCalls, 0);
    assert.equal(applyDeltaCalls, 0);
  });

  test('single orphaned round with pending bets (cancels round + refunds)', async () => {
    const roundUpdates: any[] = [];
    const updateManyCalls: any[] = [];
    const changeBalanceCalls: any[] = [];
    const applyDeltaCalls: any[] = [];
    let transactionCalls = 0;

    const orphanedRound = { id: 'round-1', status: 'BETTING', startedAt: new Date() };
    const bets = [
      { id: 'bet-1', orderId: 'order-1', userId: 'user-1', amount: 10, isPlayMode: true, asset: 'BTC' },
      { id: 'bet-2', orderId: 'order-2', userId: 'user-2', amount: 20, isPlayMode: false, asset: 'BTC' },
    ];

    const prisma = {
      round: {
        findMany: async () => [orphanedRound],
        update: async (args: any) => { roundUpdates.push(args); },
      },
      bet: {
        findMany: async () => bets,
      },
      $transaction: async (fn: any) => {
        transactionCalls += 1;
        return fn({
          bet: {
            updateMany: async (args: any) => { updateManyCalls.push(args); return { count: 1 }; },
          },
        });
      },
    };

    const financialService = {
      changeBalance: async (args: any) => { changeBalanceCalls.push(args); },
    };
    const housePoolService = {
      applyDelta: async (args: any) => { applyDeltaCalls.push(args); },
    };

    await recoverOrphanedRounds({ prisma, financialService, housePoolService });

    assert.equal(roundUpdates.length, 1);
    assert.equal(roundUpdates[0].where.id, orphanedRound.id);
    assert.equal(roundUpdates[0].data.status, 'CANCELLED');
    assert.ok(roundUpdates[0].data.endedAt instanceof Date);

    assert.equal(transactionCalls, 2);
    assert.equal(updateManyCalls.length, 2);
    assert.equal(changeBalanceCalls.length, 2);
    assert.equal(applyDeltaCalls.length, 1);
    assert.deepEqual(applyDeltaCalls[0], { asset: 'BTC', amount: -20 });

    assert.equal(changeBalanceCalls[0].type, 'REFUND');
    assert.equal(changeBalanceCalls[0].relatedBetId, 'bet-1');
    assert.equal(changeBalanceCalls[0].isPlayMode, true);

    assert.equal(changeBalanceCalls[1].type, 'REFUND');
    assert.equal(changeBalanceCalls[1].relatedBetId, 'bet-2');
    assert.equal(changeBalanceCalls[1].isPlayMode, false);
  });

  test('orphaned round with no pending bets (only cancels)', async () => {
    const roundUpdates: any[] = [];
    let transactionCalls = 0;
    let changeBalanceCalls = 0;
    let applyDeltaCalls = 0;

    const orphanedRound = { id: 'round-1', status: 'RUNNING', startedAt: new Date() };

    const prisma = {
      round: {
        findMany: async () => [orphanedRound],
        update: async (args: any) => { roundUpdates.push(args); },
      },
      bet: {
        findMany: async () => [],
      },
      $transaction: async () => {
        transactionCalls += 1;
      },
    };

    const financialService = {
      changeBalance: async () => { changeBalanceCalls += 1; },
    };
    const housePoolService = {
      applyDelta: async () => { applyDeltaCalls += 1; },
    };

    await recoverOrphanedRounds({ prisma, financialService, housePoolService });

    assert.equal(roundUpdates.length, 1);
    assert.equal(transactionCalls, 0);
    assert.equal(changeBalanceCalls, 0);
    assert.equal(applyDeltaCalls, 0);
  });

  test('error during refund logs error and continues', async () => {
    const updateManyCalls: any[] = [];
    const applyDeltaCalls: any[] = [];
    const changeBalanceCalls: any[] = [];
    let transactionCalls = 0;

    const orphanedRound = { id: 'round-1', status: 'SETTLING', startedAt: new Date() };
    const bets = [
      { id: 'bet-1', orderId: 'order-1', userId: 'user-1', amount: 10, isPlayMode: false, asset: 'BTC' },
      { id: 'bet-2', orderId: 'order-2', userId: 'user-2', amount: 20, isPlayMode: false, asset: 'BTC' },
    ];

    const prisma = {
      round: {
        findMany: async () => [orphanedRound],
        update: async () => undefined,
      },
      bet: {
        findMany: async () => bets,
      },
      $transaction: async (fn: any) => {
        transactionCalls += 1;
        return fn({
          bet: {
            updateMany: async (args: any) => { updateManyCalls.push(args); return { count: 1 }; },
          },
        });
      },
    };

    const financialService = {
      changeBalance: async (args: any) => {
        changeBalanceCalls.push(args);
        if (args.relatedBetId === 'bet-1') {
          throw new Error('boom');
        }
      },
    };
    const housePoolService = {
      applyDelta: async (args: any) => { applyDeltaCalls.push(args); },
    };

    await recoverOrphanedRounds({ prisma, financialService, housePoolService });

    assert.equal(transactionCalls, 2);
    assert.equal(updateManyCalls.length, 2);
    assert.equal(changeBalanceCalls.length, 2);
    assert.equal(applyDeltaCalls.length, 1);

    assert.ok(errors.some((entry) => String(entry[0]).includes('Failed to refund bet bet-1')));
  });

  test('bet already refunded (updateMany.count === 0) skips refund', async () => {
    let changeBalanceCalls = 0;
    let applyDeltaCalls = 0;
    const updateManyCalls: any[] = [];

    const orphanedRound = { id: 'round-1', status: 'RUNNING', startedAt: new Date() };
    const bets = [
      { id: 'bet-1', orderId: 'order-1', userId: 'user-1', amount: 10, isPlayMode: false, asset: 'BTC' },
    ];

    const prisma = {
      round: {
        findMany: async () => [orphanedRound],
        update: async () => undefined,
      },
      bet: {
        findMany: async () => bets,
      },
      $transaction: async (fn: any) => {
        return fn({
          bet: {
            updateMany: async (args: any) => {
              updateManyCalls.push(args);
              return { count: 0 };
            },
          },
        });
      },
    };

    const financialService = {
      changeBalance: async () => { changeBalanceCalls += 1; },
    };
    const housePoolService = {
      applyDelta: async () => { applyDeltaCalls += 1; },
    };

    await recoverOrphanedRounds({ prisma, financialService, housePoolService });

    assert.equal(updateManyCalls.length, 1);
    assert.equal(changeBalanceCalls, 0);
    assert.equal(applyDeltaCalls, 0);
  });
});

