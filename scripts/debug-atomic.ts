import { EventEmitter } from 'node:events';
import { GameEngine } from '../lib/game-engine/GameEngine';
import { RiskManager } from '../lib/game-engine/RiskManager';
import type { PriceUpdate, ServerBet } from '../lib/game-engine/types';

class FakeRedis {
  hashes = new Map<string, Record<string, string>>();
  strings = new Map<string, string>();
  dels: string[] = [];
  zadds: Array<{ key: string; score: number; member: string }> = [];

  async hset(key: string, data: Record<string, string>) {
    this.hashes.set(key, data);
    return 1;
  }

  async get(key: string) {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async del(key: string) {
    this.dels.push(key);
    this.hashes.delete(key);
    this.strings.delete(key);
    return 1;
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

  async zadd(key: string, score: number, member: string) {
    this.zadds.push({ key, score, member });
    return 1;
  }
}

class FakePrisma {
  rounds = new Map<string, any>();
  bets = new Map<string, any>();
  users = new Map<string, any>();
  betsByOrderId = new Map<string, any>();
  private betSeq = 0;

  seedUser(row: { id: string; active?: boolean; silenced?: boolean; balance?: number; playBalance?: number }) {
    this.users.set(row.id, {
      id: row.id,
      active: row.active ?? true,
      silenced: row.silenced ?? false,
      balance: row.balance ?? 100,
      playBalance: row.playBalance ?? 0,
    });
  }

  round = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const round = this.rounds.get(id);
      if (!round) return null;
      if (!args.select) return round;
      const result: any = {};
      if (args.select.status) result.status = round.status;
      return result;
    },
  };

  bet = {
    findUnique: async (args: any) => {
      const orderId = args?.where?.orderId as string | undefined;
      if (!orderId) return null;
      return this.betsByOrderId.get(orderId) ?? null;
    },
    create: async (args: any) => {
      if (args?.data?.orderId && this.betsByOrderId.has(args.data.orderId)) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      this.betSeq += 1;
      const bet = { id: `bet-${this.betSeq}`, ...args.data };
      this.bets.set(bet.id, bet);
      if (bet.orderId) this.betsByOrderId.set(bet.orderId, bet);
      return bet;
    },
  };

  user = {
    findUnique: async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) return null;
      const user = this.users.get(id);
      if (!user) return null;
      if (!args.select) return user;
      const result: any = {};
      if (args.select.active) result.active = user.active;
      if (args.select.silenced) result.silenced = user.silenced;
      if (args.select.balance) result.balance = user.balance;
      if (args.select.playBalance) result.playBalance = user.playBalance;
      return result;
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakePriceService extends EventEmitter {
  private price: PriceUpdate | null;
  constructor(price: PriceUpdate | null) {
    super();
    this.price = price;
  }

  getLatestPrice() {
    return this.price;
  }
}

class FakeLockManager {
  async acquireBetLock(_orderId?: string, _ttlMs?: number) {
    return 'bet-token';
  }
  async releaseBetLock(_orderId?: string, _token?: string) {
    return true;
  }
}

class FakeFinancialService {
  async conditionalChangeBalance(_params: any) {
    return { success: true };
  }
}

class FakeHousePoolService {
  balances = new Map<string, number>();
  constructor() {
    this.balances.set('BTCUSDT', 100000);
  }
  async getBalance(asset: string) {
    return this.balances.has(asset) ? this.balances.get(asset)! : null;
  }
  async initialize(asset: string, initialBalance: number) {
    if (!this.balances.has(asset)) this.balances.set(asset, initialBalance);
    return this.balances.get(asset)!;
  }
  async applyDelta(params: { asset: string; amount: number }) {
    const current = this.balances.get(params.asset) ?? 0;
    const next = current + params.amount;
    this.balances.set(params.asset, next);
    return { balance: next, version: 1 };
  }
}

function makeValidRequest(overrides: Partial<{ orderId: string; targetRow: number; targetTime: number; amount: number; isPlayMode: boolean }> = {}) {
  return {
    orderId: 'order-1',
    targetRow: 5,
    targetTime: 2,
    amount: 10,
    isPlayMode: false,
    ...overrides,
  };
}

async function main() {
  process.env.RATE_LIMIT_REDIS_ENABLED = 'false';
  const redis = new FakeRedis();
  const prisma = new FakePrisma();
  const priceService = new FakePriceService({
    asset: 'BTCUSDT',
    price: 100,
    timestamp: Date.now(),
    source: 'bybit',
  });

  const engine = new GameEngine(redis as any, prisma as any, priceService as any, {
    asset: 'BTCUSDT',
    bettingDuration: 0,
    maxDuration: 10,
    minBetAmount: 1,
    maxBetAmount: 100,
    maxBetsPerUser: 10,
    maxBetsPerSecond: 5,
    hitTolerance: 1,
    tickInterval: 100,
  });

  (engine as any).lockManager = new FakeLockManager();
  (engine as any).financialService = new FakeFinancialService();
  (engine as any).housePoolService = new FakeHousePoolService();
  (engine as any).startTickLoop = () => {};
  (engine as any).checkRateLimit = async () => true;

  const roundId = 'round-atomic-1';
  const now = Date.now();
  (engine as any).state = {
    roundId,
    status: 'BETTING',
    asset: 'BTCUSDT',
    startPrice: 100,
    currentPrice: 100,
    currentRow: 5,
    elapsed: 1,
    roundStartTime: now - 1000,
    activeBets: new Map<string, ServerBet>(),
  };
  prisma.rounds.set(roundId, { id: roundId, status: 'BETTING' });
  prisma.seedUser({ id: 'user-1' });

  (engine as any).riskManager = new RiskManager({ maxRoundPayout: 11 });

  const [first, second] = await Promise.allSettled([
    engine.placeBet('user-1', makeValidRequest({ orderId: 'order-atomic-1' })),
    engine.placeBet('user-1', makeValidRequest({ orderId: 'order-atomic-2' })),
  ]);

  console.log('first', first.status, first.status === 'fulfilled' ? first.value : String(first.reason?.code ?? first.reason));
  console.log('second', second.status, second.status === 'fulfilled' ? second.value : String(second.reason?.code ?? second.reason));
  console.log('betsByOrderId', Array.from(prisma.betsByOrderId.keys()));
  console.log('activeBets size', (engine as any).state.activeBets.size);
  console.log('activeBets keys', Array.from((engine as any).state.activeBets.keys()));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

