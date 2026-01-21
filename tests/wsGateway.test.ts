import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';

import { WebSocketGateway } from '../lib/game-engine/WebSocketGateway';
import { WS_EVENTS } from '../lib/game-engine/constants';

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

  // read-only: place_bet rejected
  const rejectedP = waitForEvent<any>(socket, WS_EVENTS.BET_REJECTED);
  socket.emit(WS_EVENTS.PLACE_BET, {
    orderId: 'o1',
    amount: 1,
    targetRow: 6.5,
    targetTime: 2.1,
    isPlayMode: true,
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
