import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';

import { WebSocketGateway } from '../lib/game-engine/WebSocketGateway';
import { PriceService } from '../lib/game-engine/PriceService';
import { WS_EVENTS } from '../lib/game-engine/constants';
import {
  calculateAdjustedProbability,
  calculateMultiplier,
  CENTER_ROW_INDEX,
  clampRowIndex,
  isHitByTickSeries,
  isValidMoneyAmount,
  MAX_MULTIPLIER,
  MAX_ROW_INDEX,
  MIN_MULTIPLIER,
  MIN_ROW_INDEX,
  roundMoney,
} from '../lib/shared/gameMath';

class FakePriceService extends EventEmitter {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

type FakeGameState = {
  roundId: string;
  status: string;
  asset: string;
  startPrice: number;
  currentPrice: number;
  currentRow: number;
  elapsed: number;
  roundStartTime: number;
};

class FakeGameEngine extends EventEmitter {
  public placeBetCalls: Array<{ userId: string; request: any }> = [];

  constructor(
    private state: FakeGameState | null,
    private config: { asset: string; bettingDuration: number; maxDuration: number }
  ) {
    super();
  }

  getState(): any {
    return this.state;
  }

  getConfig(): any {
    return this.config;
  }

  async placeBet(userId: string, request: any): Promise<void> {
    this.placeBetCalls.push({ userId, request });
    this.emit('bet:confirmed', {
      userId,
      orderId: request.orderId,
      betId: `bet-${request.orderId}`,
      multiplier: 1.2345,
      targetRow: request.targetRow,
      targetTime: request.targetTime,
      amount: request.amount,
    });
  }

  async stop(): Promise<void> {}
}

function waitForEvent<T = any>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function waitForEventWhere<T = any>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for event: ${event} (predicate)`));
    }, timeoutMs);

    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, handler);
    };

    socket.on(event, handler);
  });
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function makeFakePrisma(args: {
  user?: { id: string; balance: unknown; playBalance: unknown } | null;
  historyBets?: any[];
  roundBets?: any[];
}) {
  const prisma = {
    user: {
      async findUnique(_q: any) {
        return args.user ?? null;
      },
    },
    bet: {
      async findMany(q: any) {
        if (q?.where?.roundId) {
          return args.roundBets ?? [];
        }
        return args.historyBets ?? [];
      },
    },
  };
  return prisma;
}

async function setupGateway(args: {
  allowedOrigin: string;
  gameState: FakeGameState | null;
  prisma: any;
  verifyToken?: (token: string) => Promise<string | null>;
  verifyTokenFromCookie?: (cookieHeader: string | undefined) => Promise<string | null>;
  heartbeatIntervalMs?: number;
  stateSync?: { replayCurrentRoundBets?: boolean; historyLimit?: number };
}) {
  const httpServer = createServer();

  const fakePriceService = new FakePriceService();
  const fakeGameEngine = new FakeGameEngine(args.gameState, { asset: 'BTCUSDT', bettingDuration: 5, maxDuration: 60 });

  const gateway = new WebSocketGateway(httpServer, {} as any, args.prisma as any, {
    cors: { origin: [args.allowedOrigin], credentials: true },
    heartbeat: { intervalMs: args.heartbeatIntervalMs ?? 50 },
    stateSync: args.stateSync,
    deps: {
      gameEngine: fakeGameEngine as any,
      priceService: fakePriceService as any,
      verifyToken:
        args.verifyToken ??
        (async () => {
          return null;
        }),
      verifyTokenFromCookie: async (socket) => {
        const cookie = socket.request.headers.cookie as string | undefined;
        return (args.verifyTokenFromCookie ?? (async () => null))(cookie);
      },
    },
  });

  await gateway.start();

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://localhost:${address.port}`;

  return { httpServer, url, gateway, fakeGameEngine, fakePriceService };
}

test('rejects disallowed origin', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://allowed.local',
    gameState: null,
    prisma: makeFakePrisma({}),
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://bad.local' },
    reconnection: false,
    timeout: 1000,
  });

  t.after(() => socket.disconnect());

  const connectP = waitForEvent(socket, 'connect');
  const disconnectP = waitForEvent<string>(socket, 'disconnect');
  socket.connect();

  await connectP;
  const reason = await disconnectP;
  assert.equal(reason, 'io server disconnect');
  assert.equal(gateway.getStats().totalConnections, 0);
});

test('anonymous connection: allowed but read-only, receives snapshot + legacy init + ping/pong', async (t) => {
  const gameState: FakeGameState = {
    roundId: 'r1',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 101,
    currentRow: 6.4,
    elapsed: 1.5,
    roundStartTime: 1000,
  };

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState,
    prisma: makeFakePrisma({}),
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  const roundStartP = waitForEvent<any>(socket, WS_EVENTS.ROUND_START);
  const roundRunningP = waitForEvent<any>(socket, WS_EVENTS.ROUND_RUNNING);
  const stateUpdateP = waitForEvent<any>(socket, WS_EVENTS.STATE_UPDATE);

  socket.connect();

  const auth = await authP;
  assert.equal(auth.payload.success, true);
  assert.equal(auth.payload.userId, null);
  assert.equal(auth.payload.isAnonymous, true);

  const snapshot = await snapshotP;
  assert.equal(snapshot.type, WS_EVENTS.STATE_SNAPSHOT);
  assert.equal(snapshot.payload.isAuthenticated, false);
  assert.equal(snapshot.payload.userId, null);
  assert.equal(snapshot.payload.user, null);
  assert.equal(snapshot.payload.game.roundId, 'r1');

  // 旧事件兼容
  const roundStart = await roundStartP;
  assert.equal(roundStart.payload.roundId, 'r1');
  const roundRunning = await roundRunningP;
  assert.equal(roundRunning.payload.roundId, 'r1');
  const stateUpdate = await stateUpdateP;
  assert.equal(stateUpdate.payload.currentRow, 6.4);

  // ping/pong
  const pongP = waitForEvent<any>(socket, WS_EVENTS.PONG);
  socket.emit(WS_EVENTS.PING);
  const pong = await pongP;
  assert.equal(typeof pong.timestamp, 'number');

  // read-only: place_bet with isPlayMode=false rejected (真金投注需要登录)
  const rejectedP = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, {
    orderId: 'o1',
    amount: 1,
    targetRow: 6.5,
    targetTime: 2.1,
    isPlayMode: false, // 真金投注需要登录
  });
  const rejected = await rejectedP;
  assert.equal(rejected.payload.code, 'UNAUTHORIZED');

  assert.equal(gateway.getStats().authenticatedUsers, 0);
});

test('authenticated via cookie: receives snapshot with balances + history and replays current round bets', async (t) => {
  const gameState: FakeGameState = {
    roundId: 'r1',
    status: 'BETTING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 6.5,
    elapsed: 0.2,
    roundStartTime: 1000,
  };

  const prisma = makeFakePrisma({
    user: { id: 'u1', balance: '10.50', playBalance: '20.25' },
    historyBets: [
      {
        id: 'hb1',
        orderId: 'h1',
        roundId: 'r0',
        amount: '2',
        multiplier: '1.5',
        targetRow: '6.5',
        targetTime: '1.1',
        rowIndex: 7,
        colIndex: 1,
        status: 'WON',
        isWin: true,
        payout: '3',
        isPlayMode: true,
        hitPrice: '50000.1',
        hitRow: '6.4',
        hitTime: '1.05',
        createdAt: new Date(1_000_000),
        settledAt: new Date(1_000_500),
      },
    ],
    roundBets: [
      {
        id: 'b1',
        orderId: 'o1',
        amount: '1',
        multiplier: '1.2',
        targetRow: '6.5',
        targetTime: '2.5',
        rowIndex: 6,
        colIndex: 3,
        status: 'PENDING',
        payout: '0',
        hitPrice: null,
        hitRow: null,
        hitTime: null,
        createdAt: new Date(2_000_000),
      },
      {
        id: 'b2',
        orderId: 'o2',
        amount: '1',
        multiplier: '1.2',
        targetRow: '6.5',
        targetTime: '2.6',
        rowIndex: 6,
        colIndex: 3,
        status: 'WON',
        payout: '2.4',
        hitPrice: '50000.2',
        hitRow: '6.3',
        hitTime: '2.55',
        createdAt: new Date(2_000_100),
      },
    ],
  });

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState,
    prisma,
    verifyTokenFromCookie: async (cookieHeader) => {
      return cookieHeader?.includes('next-auth.session-token=good') ? 'u1' : null;
    },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const confirmed: any[] = [];
  const settled: any[] = [];

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: {
      origin: 'http://localhost:3000',
      cookie: 'next-auth.session-token=good',
    },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  socket.on(WS_EVENTS.BET_CONFIRMED, (msg) => confirmed.push(msg));
  socket.on(WS_EVENTS.BET_SETTLED, (msg) => settled.push(msg));

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();

  const auth = await authP;
  assert.equal(auth.payload.success, true);
  assert.equal(auth.payload.userId, 'u1');

  const snapshot = await snapshotP;
  assert.equal(snapshot.payload.isAuthenticated, true);
  assert.equal(snapshot.payload.userId, 'u1');
  assert.equal(snapshot.payload.user.balance, 10.5);
  assert.equal(snapshot.payload.user.playBalance, 20.25);
  assert.equal(snapshot.payload.user.recentBets.length, 1);

  await waitUntil(() => confirmed.length === 2 && settled.length === 1);
  assert.deepEqual(
    confirmed.map((m) => m.payload.orderId),
    ['o1', 'o2']
  );
  assert.equal(settled[0].payload.orderId, 'o2');

  assert.equal(gateway.getStats().authenticatedUsers, 1);
});

test('auth upgrade via WS auth: enables betting and forwards bet_confirmed', async (t) => {
  const gameState: FakeGameState = {
    roundId: 'r1',
    status: 'RUNNING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 101,
    currentRow: 6.4,
    elapsed: 1.5,
    roundStartTime: 1000,
  };

  const { httpServer, url, gateway, fakeGameEngine } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState,
    prisma: makeFakePrisma({ user: { id: 'u1', balance: 1, playBalance: 2 } }),
    verifyToken: async (token) => (token === 'good' ? 'u1' : null),
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const anonAuthP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await anonAuthP;

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.emit(WS_EVENTS.AUTH, { token: 'good' });
  const auth = await authP;
  assert.equal(auth.payload.success, true);
  assert.equal(auth.payload.userId, 'u1');

  const betConfirmedP = waitForEvent<any>(socket, WS_EVENTS.BET_CONFIRMED);
  socket.emit(WS_EVENTS.PLACE_BET, { orderId: 'o9', amount: 1, targetRow: 6.5, targetTime: 2.1, isPlayMode: true });
  const confirmed = await betConfirmedP;
  assert.equal(confirmed.payload.orderId, 'o9');
  assert.equal(fakeGameEngine.placeBetCalls.length, 1);
  assert.equal(fakeGameEngine.placeBetCalls[0]?.userId, 'u1');
});

test('no active round: snapshot has null round and legacy events are skipped', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: null,
    prisma: makeFakePrisma({}),
    stateSync: { replayCurrentRoundBets: false },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();

  await authP;
  const snapshot = await snapshotP;
  assert.equal(snapshot.payload.game.roundId, null);
  assert.equal(snapshot.payload.game.status, null);

  await assert.rejects(waitForEvent(socket, WS_EVENTS.ROUND_START, 200));
});

test('state_request: can disable history and does not call history bet query', async (t) => {
  const betFindManyCalls: any[] = [];
  const prisma = {
    user: { async findUnique() { return { id: 'u1', balance: 1, playBalance: 2 }; } },
    bet: {
      async findMany(q: any) {
        betFindManyCalls.push(q);
        if (!q?.where?.roundId) {
          throw new Error('history query should be skipped');
        }
        return [];
      },
    },
  };

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.1,
      roundStartTime: 1000,
    },
    prisma,
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: true, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();
  await authP;
  await snapshotP;

  const nextSnapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.emit(WS_EVENTS.STATE_REQUEST, { includeHistory: false, historyLimit: 0 });
  const nextSnapshot = await nextSnapshotP;
  assert.equal(nextSnapshot.payload.user.recentBets.length, 0);
  assert.equal(
    betFindManyCalls.some((q) => q?.where && !q.where.roundId),
    false
  );
});

test('historyLimit: clamps config + state_request override to 200', async (t) => {
  const betFindManyCalls: any[] = [];

  const prisma = {
    user: { async findUnique() { return { id: 'u1', balance: 1, playBalance: 2 }; } },
    bet: {
      async findMany(q: any) {
        betFindManyCalls.push(q);

        if (q?.where?.roundId) return [];

        const take = typeof q?.take === 'number' ? q.take : 0;
        return Array.from({ length: take }, (_v, i) => ({
          id: `b${i}`,
          orderId: `o${i}`,
          roundId: 'r0',
          amount: 1,
          multiplier: 1.5,
          targetRow: 6.5,
          targetTime: 1.1,
          rowIndex: 7,
          colIndex: 1,
          status: 'PENDING',
          isWin: false,
          payout: 0,
          isPlayMode: true,
          hitPrice: null,
          hitRow: null,
          hitTime: null,
          createdAt: new Date(0),
          settledAt: null,
        }));
      },
    },
  };

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.1,
      roundStartTime: 1000,
    },
    prisma,
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: false, historyLimit: 999 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();
  await authP;
  const snapshot = await snapshotP;

  assert.equal(betFindManyCalls[0]?.take, 200);
  assert.equal(snapshot.payload.user.recentBets.length, 200);

  const nextSnapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.emit(WS_EVENTS.STATE_REQUEST, { includeHistory: true, historyLimit: 999 });
  const nextSnapshot = await nextSnapshotP;

  assert.equal(betFindManyCalls[1]?.take, 200);
  assert.equal(nextSnapshot.payload.user.recentBets.length, 200);
});

test('forwards GameEngine and PriceService events (including anon routing)', async (t) => {
  const { httpServer, url, gateway, fakeGameEngine, fakePriceService } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'RUNNING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 101,
      currentRow: 6.4,
      elapsed: 1.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({ user: { id: 'u1', balance: 1, playBalance: 2 } }),
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();
  await authP;
  await snapshotP;

  // round:start
  const roundStartP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.ROUND_START,
    (msg) => msg?.payload?.roundId === 'r2'
  );
  fakeGameEngine.emit('round:start', {
    roundId: 'r2',
    asset: 'BTCUSDT',
    startPrice: 200,
    startTime: 2000,
    bettingDuration: 5,
    maxDuration: 60,
  });
  await roundStartP;

  // round:running
  const roundRunningP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.ROUND_RUNNING,
    (msg) => msg?.payload?.roundId === 'r2'
  );
  fakeGameEngine.emit('round:running', { roundId: 'r2' });
  await roundRunningP;

  // state:update
  const stateUpdateP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.STATE_UPDATE,
    (msg) => msg?.payload?.elapsed === 99
  );
  fakeGameEngine.emit('state:update', { elapsed: 99, currentPrice: 123, currentRow: 6.1 });
  await stateUpdateP;

  // round:end
  const roundEndP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.ROUND_END,
    (msg) => msg?.payload?.roundId === 'r2'
  );
  fakeGameEngine.emit('round:end', {
    roundId: 'r2',
    endPrice: 150,
    reason: 'crash',
    stats: { totalBets: 1, totalWins: 0, totalPayout: 0 },
  });
  await roundEndP;

  // round:cancelled
  const roundCancelledP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.ROUND_CANCELLED,
    (msg) => msg?.payload?.roundId === 'r3'
  );
  fakeGameEngine.emit('round:cancelled', { roundId: 'r3', reason: 'manual', refundedBets: 1 });
  await roundCancelledP;

  // bet:settled + bet:refunded (authenticated routing)
  const settledP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.BET_SETTLED,
    (msg) => msg?.payload?.betId === 'bs1'
  );
  fakeGameEngine.emit('bet:settled', {
    userId: 'u1',
    betId: 'bs1',
    orderId: 'o1',
    isWin: false,
    payout: 0,
    hitDetails: { hitPrice: 1, hitRow: 2, hitTime: 3 },
  });
  await settledP;

  const refundedP = waitForEventWhere<any>(
    socket,
    WS_EVENTS.BET_REFUNDED,
    (msg) => msg?.payload?.betId === 'br1'
  );
  fakeGameEngine.emit('bet:refunded', { userId: 'u1', betId: 'br1', orderId: 'o2', amount: 1, reason: 'x' });
  await refundedP;

  // price update + critical failure
  const priceP = waitForEventWhere<any>(socket, WS_EVENTS.PRICE_UPDATE, (msg) => msg?.payload?.price === 999);
  fakePriceService.emit('price', { price: 999, timestamp: 12345 });
  const price = await priceP;
  assert.equal(price.payload.rowIndex, 6.4);
  fakePriceService.emit('critical_failure');
});

test('autoAuth failure: verifyTokenFromCookie throws -> downgraded to anonymous', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'RUNNING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 101,
      currentRow: 6.4,
      elapsed: 1.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
    verifyTokenFromCookie: async () => {
      throw new Error('boom');
    },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  const auth = await authP;
  assert.equal(auth.payload.isAnonymous, true);
});

test('placeBet input validation and error mapping', async (t) => {
  const { httpServer, url, gateway, fakeGameEngine } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'RUNNING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 101,
      currentRow: 6.4,
      elapsed: 1.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({ user: { id: 'u1', balance: { toNumber: () => 5 }, playBalance: { toNumber: () => 10 } } }),
    verifyToken: async (token) => (token === 'good' ? 'u1' : null),
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const anonAuthP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await anonAuthP;

  // invalid payload (non-object)
  const invalid1P = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, null);
  assert.equal((await invalid1P).payload.code, 'INVALID_REQUEST');

  // upgrade auth
  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.emit(WS_EVENTS.AUTH, { token: 'good' });
  await authP;

  // missing orderId
  const invalid2P = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, { amount: 1, targetRow: 6.5, targetTime: 2.1 });
  assert.equal((await invalid2P).payload.code, 'INVALID_REQUEST');

  // wrong field types
  const invalid3P = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, { orderId: 'o1', amount: '1', targetRow: 6.5, targetTime: 2.1 });
  assert.equal((await invalid3P).payload.code, 'INVALID_REQUEST');

  // gameEngine throws -> INTERNAL_ERROR
  (fakeGameEngine as any).placeBet = async () => {
    throw new Error('boom');
  };
  const errP = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, { orderId: 'o2', amount: 1, targetRow: 6.5, targetTime: 2.1 });
  assert.equal((await errP).payload.code, 'INTERNAL_ERROR');
});

test('cors: accepts origin as a single string', async (t) => {
  const httpServer = createServer();
  const prisma = makeFakePrisma({});
  const fakePriceService = new FakePriceService();
  const fakeGameEngine = new FakeGameEngine(null, { asset: 'BTCUSDT', bettingDuration: 5, maxDuration: 60 });

  const gateway = new WebSocketGateway(httpServer, {} as any, prisma as any, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    heartbeat: { intervalMs: 50 },
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
    deps: {
      gameEngine: fakeGameEngine as any,
      priceService: fakePriceService as any,
      verifyToken: async () => null,
      verifyTokenFromCookie: async () => null,
    },
  });

  await gateway.start();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://localhost:${address.port}`;

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await authP;

  // idempotent heartbeat start
  (gateway as any).startHeartbeat();
});

test('cors: uses WS_CORS_ORIGIN default when cors config is omitted', async (t) => {
  const prevCorsOrigin = process.env.WS_CORS_ORIGIN;
  process.env.WS_CORS_ORIGIN = 'http://localhost:3000';

  const httpServer = createServer();
  const prisma = makeFakePrisma({});
  const fakePriceService = new FakePriceService();
  const fakeGameEngine = new FakeGameEngine(null, { asset: 'BTCUSDT', bettingDuration: 5, maxDuration: 60 });

  const gateway = new WebSocketGateway(httpServer, {} as any, prisma as any, {
    heartbeat: { intervalMs: 50 },
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
    deps: {
      gameEngine: fakeGameEngine as any,
      priceService: fakePriceService as any,
      verifyToken: async () => null,
      verifyTokenFromCookie: async () => null,
    },
  });

  await gateway.start();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://localhost:${address.port}`;

  t.after(async () => {
    if (prevCorsOrigin == null) delete process.env.WS_CORS_ORIGIN;
    else process.env.WS_CORS_ORIGIN = prevCorsOrigin;
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await authP;
});

test('auth: rejects invalid token payload', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.1,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
    verifyToken: async () => 'u1',
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const anonAuthP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await anonAuthP;

  const authResultP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.emit(WS_EVENTS.AUTH, { token: 123 as any });
  const authResult = await authResultP;
  assert.equal(authResult.payload.success, false);
});

test('auth: switching user id cleans up previous user room tracking', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.1,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({ user: { id: 'u2', balance: 1, playBalance: 2 } }),
    verifyToken: async (token) => (token === 'u2' ? 'u2' : null),
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();
  await authP;
  await snapshotP;

  const switchAuthP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.emit(WS_EVENTS.AUTH, { token: 'u2' });
  const switchAuth = await switchAuthP;
  assert.equal(switchAuth.payload.success, true);
  assert.equal(switchAuth.payload.userId, 'u2');

  const connectedUsers: Map<string, Set<string>> = (gateway as any).connectedUsers;
  assert.equal(connectedUsers.has('u1'), false);
  assert.equal(connectedUsers.has('u2'), true);
});

test('getGameEngine/getPriceService: throws before start when deps missing', async (t) => {
  const httpServer = createServer();
  const gateway = new WebSocketGateway(httpServer, {} as any, makeFakePrisma({}) as any, {
    cors: { origin: ['http://localhost:3000'], credentials: true },
    // deps intentionally omitted
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  assert.throws(() => gateway.getGameEngine());
  assert.throws(() => gateway.getPriceService());
});

test('origin allowlist supports wildcard * (requires origin header)', async (t) => {
  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: '*',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.1,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://any-origin.local' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  const auth = await authP;
  assert.equal(auth.payload.success, true);
});

test('reconnect replay: skips bets without orderId and emits bet_refunded', async (t) => {
  const prisma = makeFakePrisma({
    user: { id: 'u1', balance: 1, playBalance: 2 },
    historyBets: [],
    roundBets: [
      {
        id: 'b-no-order',
        orderId: null,
        amount: '1',
        multiplier: '1.2',
        targetRow: '6.5',
        targetTime: '2.5',
        rowIndex: 6,
        colIndex: 3,
        status: 'REFUNDED',
        payout: '0',
        hitPrice: null,
        hitRow: null,
        hitTime: null,
        createdAt: new Date(2_000_000),
      },
      {
        id: 'b-refund',
        orderId: 'o-refund',
        amount: '1',
        multiplier: '1.2',
        targetRow: '6.5',
        targetTime: '2.6',
        rowIndex: 6,
        colIndex: 3,
        status: 'REFUNDED',
        payout: '0',
        hitPrice: null,
        hitRow: null,
        hitTime: null,
        createdAt: new Date(2_000_100),
      },
    ],
  });

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.2,
      roundStartTime: 1000,
    },
    prisma,
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: true, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const confirmed: any[] = [];
  const refunded: any[] = [];
  socket.on(WS_EVENTS.BET_CONFIRMED, (msg) => confirmed.push(msg));
  socket.on(WS_EVENTS.BET_REFUNDED, (msg) => refunded.push(msg));

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await authP;

  await waitUntil(() => confirmed.length === 1 && refunded.length === 1);
  assert.equal(confirmed[0].payload.orderId, 'o-refund');
  assert.equal(refunded[0].payload.orderId, 'o-refund');
});

test('anon routing: bet events sent to socket.id room when userId starts with anon-', async (t) => {
  const { httpServer, url, gateway, fakeGameEngine } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'RUNNING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 101,
      currentRow: 6.4,
      elapsed: 1.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await authP;
  assert.ok(socket.id);

  const userId = `anon-${socket.id}`;
  const confirmedP = waitForEventWhere<any>(socket, WS_EVENTS.BET_CONFIRMED, (msg) => msg?.payload?.orderId === 'a1');
  fakeGameEngine.emit('bet:confirmed', {
    userId,
    orderId: 'a1',
    betId: 'ab1',
    multiplier: 1.1,
    targetRow: 6.5,
    targetTime: 2.1,
    amount: 1,
  });
  await confirmedP;

  const settledP = waitForEventWhere<any>(socket, WS_EVENTS.BET_SETTLED, (msg) => msg?.payload?.betId === 'ab2');
  fakeGameEngine.emit('bet:settled', { userId, betId: 'ab2', orderId: 'a2', isWin: false, payout: 0 });
  await settledP;

  const refundedP = waitForEventWhere<any>(socket, WS_EVENTS.BET_REFUNDED, (msg) => msg?.payload?.betId === 'ab3');
  fakeGameEngine.emit('bet:refunded', { userId, betId: 'ab3', orderId: 'a3', amount: 1, reason: 'x' });
  await refundedP;
});

test('anonymous play mode: allows placing bets with isPlayMode=true', async (t) => {
  const { httpServer, url, gateway, fakeGameEngine } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  const auth = await authP;
  assert.equal(auth.payload.isAnonymous, true);
  assert.ok(socket.id);

  // 匿名用户发送试玩模式下注
  const confirmedP = waitForEvent<any>(socket, WS_EVENTS.BET_CONFIRMED);
  socket.emit(WS_EVENTS.PLACE_BET, {
    orderId: 'play-order-1',
    amount: 10,
    targetRow: 6.5,
    targetTime: 2.5,
    isPlayMode: true,  // 试玩模式
  });

  const confirmed = await confirmedP;
  assert.equal(confirmed.payload.orderId, 'play-order-1');
  assert.equal(confirmed.payload.amount, 10);

  // 验证 GameEngine.placeBet 被调用，userId 为 anon-{socketId}
  assert.equal(fakeGameEngine.placeBetCalls.length, 1);
  assert.equal(fakeGameEngine.placeBetCalls[0].userId, `anon-${socket.id}`);
  assert.equal(fakeGameEngine.placeBetCalls[0].request.isPlayMode, true);
});

test('anonymous real money: rejects placing bets with isPlayMode=false', async (t) => {
  const { httpServer, url, gateway, fakeGameEngine } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.5,
      roundStartTime: 1000,
    },
    prisma: makeFakePrisma({}),
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const authP = waitForEvent<any>(socket, WS_EVENTS.AUTH_RESULT);
  socket.connect();
  await authP;

  // 匿名用户发送真金模式下注（应被拒绝）
  const rejectedP = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, {
    orderId: 'real-order-1',
    amount: 10,
    targetRow: 6.5,
    targetTime: 2.5,
    isPlayMode: false,  // 真金模式
  });

  const rejected = await rejectedP;
  assert.equal(rejected.payload.orderId, 'real-order-1');
  assert.equal(rejected.payload.code, 'UNAUTHORIZED');
  assert.ok(rejected.payload.message.includes('登录'));

  // 验证 GameEngine.placeBet 未被调用
  assert.equal(fakeGameEngine.placeBetCalls.length, 0);
});

test('toNumber: handles Decimal-like objects and exceptions', async (t) => {
  const prisma = makeFakePrisma({
    user: {
      id: 'u1',
      balance: { toNumber() { throw new Error('bad'); } },
      playBalance: { toNumber() { return 7; } },
    },
    historyBets: [],
    roundBets: [],
  });

  const { httpServer, url, gateway } = await setupGateway({
    allowedOrigin: 'http://localhost:3000',
    gameState: {
      roundId: 'r1',
      status: 'BETTING',
      asset: 'BTCUSDT',
      startPrice: 100,
      currentPrice: 100,
      currentRow: 6.5,
      elapsed: 0.2,
      roundStartTime: 1000,
    },
    prisma,
    verifyTokenFromCookie: async () => 'u1',
    stateSync: { replayCurrentRoundBets: false, historyLimit: 0 },
  });

  t.after(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const socket = clientIo(url, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: 'http://localhost:3000', cookie: 'next-auth.session-token=good' },
    reconnection: false,
  });
  t.after(() => socket.disconnect());

  const snapshotP = waitForEvent<any>(socket, WS_EVENTS.STATE_SNAPSHOT);
  socket.connect();
  const snapshot = await snapshotP;
  assert.equal(snapshot.payload.user.balance, 0);
  assert.equal(snapshot.payload.user.playBalance, 7);
});

test('gameMath: clampRowIndex clamps values into range', () => {
  assert.equal(clampRowIndex(MIN_ROW_INDEX - 1), MIN_ROW_INDEX);
  assert.equal(clampRowIndex(MAX_ROW_INDEX + 1), MAX_ROW_INDEX);
  assert.equal(clampRowIndex(6.5), 6.5);
});

test('gameMath: roundMoney + isValidMoneyAmount handle cents precision', () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(isValidMoneyAmount(1.23), true);
  assert.equal(isValidMoneyAmount(1.234), false);
});

test('gameMath: isHitByTickSeries detects hits and misses', () => {
  const ticks = [
    { elapsed: 0, row: 6.5 },
    { elapsed: 1, row: 7 },
    { elapsed: 2, row: 7.5 },
  ];

  assert.equal(isHitByTickSeries({ ticks, targetTime: 1, targetRow: 6.8 }), true);
  assert.equal(isHitByTickSeries({ ticks, targetTime: 1, targetRow: 10 }), false);
  assert.equal(isHitByTickSeries({ ticks: [], targetTime: 1, targetRow: 6.8 }), false);
});

test('gameMath: calculateAdjustedProbability + calculateMultiplier stay bounded', () => {
  const pCenterNow = calculateAdjustedProbability(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0);
  const pFarLater = calculateAdjustedProbability(CENTER_ROW_INDEX + 4, CENTER_ROW_INDEX, 1);
  assert.ok(pCenterNow >= 0 && pCenterNow <= 1);
  assert.ok(pFarLater >= 0 && pFarLater <= 1);
  assert.ok(pFarLater < pCenterNow);

  const mCenter = calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 1);
  const mFar = calculateMultiplier(CENTER_ROW_INDEX + 4, CENTER_ROW_INDEX, 1);
  assert.ok(mCenter >= MIN_MULTIPLIER && mCenter <= MAX_MULTIPLIER);
  assert.ok(mFar >= MIN_MULTIPLIER && mFar <= MAX_MULTIPLIER);
  assert.ok(mFar > mCenter);

  assert.equal(
    calculateAdjustedProbability(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 1, { model: { sigma: 0 } }),
    0
  );
  assert.equal(
    calculateAdjustedProbability(CENTER_ROW_INDEX + 100, CENTER_ROW_INDEX, 1, { model: { sigma: 0.1 } }),
    0
  );
});

class FakeRedisPipeline {
  constructor(private calls: Array<{ op: string; args: any[] }>) {}

  lpush(...args: any[]) {
    this.calls.push({ op: 'lpush', args });
    return this;
  }

  ltrim(...args: any[]) {
    this.calls.push({ op: 'ltrim', args });
    return this;
  }

  async exec() {
    return [];
  }
}

class FakeRedis {
  public calls: Array<{ op: string; args: any[] }> = [];

  pipeline() {
    return new FakeRedisPipeline(this.calls);
  }
}

class FakeWebSocket extends EventEmitter {
  public readyState = 0;
  public sent: any[] = [];

  constructor(
    public url: string,
    public options: any
  ) {
    super();
  }

  send(data: any) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }
}

function makeTradeMessage(args: { topic: string; price: number; ts: number }) {
  return JSON.stringify({
    topic: args.topic,
    data: [{ p: String(args.price), T: String(args.ts) }],
  });
}

test('PriceService: starts, subscribes, and sends periodic ping using injected WS', async (t) => {
  const redis = new FakeRedis();
  const sockets: FakeWebSocket[] = [];

  const service = new PriceService(
    {
      asset: 'BTC',
      wsFactory: (url, options) => {
        const ws = new FakeWebSocket(url, options);
        sockets.push(ws);
        return ws as any;
      },
      connectTimeoutMs: 50,
      pingIntervalMs: 10,
      priceSampleMs: 10,
    },
    redis as any
  );

  t.after(async () => {
    await service.stop();
  });

  const connectedP = withTimeout(
    new Promise<void>((resolve) => service.once('connected', () => resolve())),
    2000,
    'PriceService connected'
  );

  const startP = withTimeout(service.start(), 2000, 'PriceService start');
  assert.equal(sockets.length, 1);

  const ws = sockets[0];
  assert.ok(ws instanceof FakeWebSocket);
  ws.readyState = 1;
  ws.emit('open');

  await startP;
  await connectedP;

  const subscribe = JSON.parse(ws.sent[0]);
  assert.equal(subscribe.op, 'subscribe');
  assert.equal(subscribe.args[0], 'publicTrade.BTCUSDT');

  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ws.sent.some((msg) => JSON.parse(msg).op === 'ping'));

  ws.emit('error', new Error('boom'));
});

test('PriceService: throttles high-frequency trades to sampling interval', async (t) => {
  const redis = new FakeRedis();
  const sockets: FakeWebSocket[] = [];
  const service = new PriceService(
    {
      asset: 'BTC',
      wsFactory: (url, options) => {
        const ws = new FakeWebSocket(url, options);
        sockets.push(ws);
        return ws as any;
      },
      connectTimeoutMs: 50,
      priceSampleMs: 25,
    },
    redis as any
  );

  t.after(async () => {
    await service.stop();
  });

  const startP = withTimeout(service.start(), 2000, 'PriceService start (throttle)');
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  ws.readyState = 1;
  ws.emit('open');
  await startP;

  const emitted: Array<{ price: number; at: number }> = [];
  service.on('price', (payload: any) => {
    emitted.push({ price: payload.price, at: Date.now() });
  });

  let price = 100;
  const send = () => {
    price += 1;
    ws.emit('message', makeTradeMessage({ topic: 'publicTrade.BTCUSDT', price, ts: price }));
  };

  send();
  const tradeTimer = setInterval(send, 5);
  await new Promise((r) => setTimeout(r, 120));
  clearInterval(tradeTimer);

  // allow trailing emit
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(emitted.length >= 3, `expected >= 3 emits, got ${emitted.length}`);
  for (let i = 1; i < emitted.length; i++) {
    const delta = emitted[i].at - emitted[i - 1].at;
    assert.ok(delta >= 15, `emit interval too small: ${delta}ms`);
    assert.ok(emitted[i].price >= emitted[i - 1].price);
  }
  assert.equal(emitted[emitted.length - 1].price, price);
});

test('PriceService: degraded start on connect close before open (no throw)', async (t) => {
  const redis = new FakeRedis();
  const sockets: FakeWebSocket[] = [];

  const service = new PriceService(
    {
      asset: 'BTC',
      allowStartWithoutConnection: true,
      wsFactory: (url, options) => {
        const ws = new FakeWebSocket(url, options);
        sockets.push(ws);
        return ws as any;
      },
      connectTimeoutMs: 50,
    },
    redis as any
  );

  t.after(async () => {
    await service.stop();
  });

  const startP = withTimeout(service.start(), 2000, 'PriceService degraded start (close)');
  assert.equal(sockets.length, 1);
  sockets[0].emit('close', 1006, Buffer.from('closed'));
  await startP;
});

test('PriceService: degraded start on connect timeout schedules reconnect', async (t) => {
  const redis = new FakeRedis();
  const sockets: FakeWebSocket[] = [];

  const service = new PriceService(
    {
      asset: 'BTC',
      allowStartWithoutConnection: true,
      wsFactory: (url, options) => {
        const ws = new FakeWebSocket(url, options);
        sockets.push(ws);
        return ws as any;
      },
      connectTimeoutMs: 10,
    },
    redis as any
  );

  t.after(async () => {
    await service.stop();
  });

  await withTimeout(service.start(), 2000, 'PriceService degraded start (timeout)');
  assert.equal(sockets.length, 1);
  await waitUntil(() => Boolean((service as any).reconnectTimer));
});

test('PriceService: health check emits critical when price is stale', async (t) => {
  const redis = new FakeRedis();
  const service = new PriceService({ asset: 'BTC' }, redis as any);

  t.after(async () => {
    await service.stop();
  });

  (service as any).lastPrice = { asset: 'BTC', price: 1, timestamp: 1, source: 'bybit' };
  (service as any).lastPriceTime = Date.now() - 15_000;

  const criticalP = withTimeout(
    new Promise((resolve) => service.once('price_critical', resolve)),
    3000,
    'PriceService price_critical'
  );
  (service as any).startHealthCheck();
  await criticalP;

  assert.equal(service.getLatestPrice(), null);
  assert.ok(service.getPriceStaleness() > 10_000);
});

test('PriceService: normalizeMessageData handles common ws payload types', async () => {
  const redis = new FakeRedis();
  const service = new PriceService({ asset: 'BTC' }, redis as any);

  const normalize = (service as any).normalizeMessageData.bind(service) as (data: any) => string;
  assert.equal(normalize('x'), 'x');
  assert.equal(normalize(Buffer.from('y')), 'y');
  assert.equal(normalize([Buffer.from('a'), Buffer.from('b')]), 'ab');
  assert.equal(normalize(new Uint8Array([99]).buffer), 'c');
});

test('PriceService: scheduleReconnect emits critical_failure when max attempts reached', async () => {
  const redis = new FakeRedis();
  const service = new PriceService({ asset: 'BTC', maxReconnectAttempts: 0 }, redis as any);

  const criticalP = withTimeout(
    new Promise((resolve) => service.once('critical_failure', resolve)),
    2000,
    'PriceService critical_failure'
  );
  (service as any).scheduleReconnect();
  await criticalP;
});
