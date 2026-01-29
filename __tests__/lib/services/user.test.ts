import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prismaMock } from '../../helpers/prismaMock';
import { FinancialService } from '../../../lib/services/financial';

const prisma = prismaMock;
const originalPrisma = (globalThis as any).prisma;
(globalThis as any).prisma = prisma as any;

const userServiceModule = import('../../../lib/services/user');

const originalChangeBalance = FinancialService.prototype.changeBalance;
const originalGetBalance = FinancialService.prototype.getBalance;
const originalSetPlayBalance = FinancialService.prototype.setPlayBalance;

const changeCalls: any[] = [];

FinancialService.prototype.changeBalance = async function (params: any) {
  changeCalls.push(params);
  const user = prisma.users.get(params.userId);
  if (!user) throw new Error('Missing user');

  const field = params.isPlayMode ? 'playBalance' : 'balance';
  const before = user[field];
  const after = before + params.amount;
  user[field] = after;
  return { balanceBefore: before, balanceAfter: after };
};

FinancialService.prototype.getBalance = async function (userId: string) {
  const user = prisma.users.get(userId);
  if (!user) return null;
  return { balance: user.balance, playBalance: user.playBalance };
};

FinancialService.prototype.setPlayBalance = async function (userId: string, newPlayBalance: number) {
  const user = prisma.users.get(userId);
  if (!user) throw new Error('Missing user');
  user.playBalance = newPlayBalance;
  return newPlayBalance;
};

after(() => {
  if (originalPrisma === undefined) {
    delete (globalThis as any).prisma;
  } else {
    (globalThis as any).prisma = originalPrisma;
  }

  FinancialService.prototype.changeBalance = originalChangeBalance;
  FinancialService.prototype.getBalance = originalGetBalance;
  FinancialService.prototype.setPlayBalance = originalSetPlayBalance;
});

test('keeps active flag when login omits active', async () => {
  const { getOrCreateUser } = await userServiceModule;
  prisma.seedUser({
    id: 'user-1',
    username: 'banned',
    active: false,
    silenced: false,
  });

  await getOrCreateUser({ id: 'user-1', username: 'banned' });
  assert.equal(prisma.users.get('user-1')?.active, false);
});

test('keeps silenced flag when login omits silenced', async () => {
  const { getOrCreateUser } = await userServiceModule;
  prisma.seedUser({
    id: 'user-2',
    username: 'silenced',
    active: true,
    silenced: true,
  });

  await getOrCreateUser({ id: 'user-2', username: 'silenced' });
  assert.equal(prisma.users.get('user-2')?.silenced, true);
});

test('creates users with default moderation flags', async () => {
  const { getOrCreateUser } = await userServiceModule;

  await getOrCreateUser({ id: 'user-3', username: 'newbie' });
  assert.equal(prisma.users.get('user-3')?.active, true);
  assert.equal(prisma.users.get('user-3')?.silenced, false);
});

test('updates moderation flags when explicitly provided', async () => {
  const { getOrCreateUser } = await userServiceModule;
  prisma.seedUser({
    id: 'user-4',
    username: 'normal',
    active: true,
    silenced: false,
  });

  await getOrCreateUser({
    id: 'user-4',
    username: 'normal',
    active: false,
    silenced: true,
  });

  assert.equal(prisma.users.get('user-4')?.active, false);
  assert.equal(prisma.users.get('user-4')?.silenced, true);
});

test('getUserBalance returns user balances', async () => {
  const { getUserBalance } = await userServiceModule;
  prisma.seedUser({
    id: 'user-balance',
    username: 'balance',
    balance: 12.5,
    playBalance: 99,
  });

  const balances = await getUserBalance('user-balance');
  assert.deepEqual(balances, { balance: 12.5, playBalance: 99 });
  assert.equal(await getUserBalance('missing-user'), null);
});

test('getBetById enforces ownership', async () => {
  const { getBetById } = await userServiceModule;

  const bet = prisma.seedBet({
    userId: 'user-bet',
    amount: 10,
    multiplier: 2,
    rowIndex: 1,
    colIndex: 2,
    asset: 'BTCUSDT',
    isPlayMode: false,
  });

  const record = await getBetById(bet.id, 'user-bet');
  assert.equal(record?.id, bet.id);
  assert.equal(record?.userId, 'user-bet');
  assert.equal(Number(record?.amount), 10);
  assert.equal(Number(record?.multiplier), 2);
  assert.equal(record?.isPlayMode, false);
  assert.equal(record?.settledAt, null);

  assert.equal(await getBetById(bet.id, 'other-user'), null);
});

test('settleBetSecure enforces ownership and settlement state', async () => {
  const { settleBetSecure } = await userServiceModule;

  const bet = prisma.seedBet({
    userId: 'user-settle',
    amount: 5,
    multiplier: 3,
    rowIndex: 0,
    colIndex: 0,
    asset: 'BTCUSDT',
    isPlayMode: false,
  });

  const wrongUser = await settleBetSecure(bet.id, 'other-user', true);
  assert.equal(wrongUser.success, false);

  const first = await settleBetSecure(bet.id, 'user-settle', true);
  assert.equal(first.success, true);
  assert.equal(first.bet?.payout, 15);

  const stored = prisma.bets.get(bet.id);
  assert.equal(stored?.isWin, true);
  assert.equal(stored?.payout, 15);
  assert.ok(stored?.settledAt instanceof Date);

  const second = await settleBetSecure(bet.id, 'user-settle', true);
  assert.equal(second.success, false);
});

test('updateUserStats increments totals', async () => {
  const { updateUserStats } = await userServiceModule;
  prisma.seedUser({
    id: 'user-stats',
    username: 'stats',
    totalBets: 0,
    totalWins: 0,
    totalLosses: 0,
    totalProfit: 0,
  });

  await updateUserStats('user-stats', true, 7);
  const user = prisma.users.get('user-stats');
  assert.equal(user?.totalBets, 1);
  assert.equal(user?.totalWins, 1);
  assert.equal(user?.totalLosses, 0);
  assert.equal(user?.totalProfit, 7);
});

test('getUserBetHistory returns settled bets sorted by createdAt', async () => {
  const { getUserBetHistory } = await userServiceModule;

  const now = Date.now();
  prisma.seedBet({
    id: 'bet-old',
    userId: 'user-history',
    amount: 1,
    multiplier: 2,
    rowIndex: 0,
    colIndex: 0,
    asset: 'BTCUSDT',
    isPlayMode: false,
    payout: 2,
    isWin: true,
    createdAt: new Date(now - 5000),
    settledAt: new Date(now - 4000),
  });
  prisma.seedBet({
    id: 'bet-new',
    userId: 'user-history',
    amount: 2,
    multiplier: 3,
    rowIndex: 0,
    colIndex: 0,
    asset: 'BTCUSDT',
    isPlayMode: false,
    payout: 6,
    isWin: true,
    createdAt: new Date(now - 1000),
    settledAt: new Date(now - 500),
  });

  const history = await getUserBetHistory('user-history', 1);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.id, 'bet-new');
  assert.equal(history[0]?.payout, 6);
});

test('updateUserBalanceWithLedger updates balances via FinancialService', async () => {
  const { updateUserBalanceWithLedger, resetPlayBalance, rechargeBalance } = await userServiceModule;

  changeCalls.length = 0;

  prisma.seedUser({
    id: 'user-funds',
    username: 'funds',
    balance: 100,
    playBalance: 50,
  });

  const ledger = await updateUserBalanceWithLedger({
    userId: 'user-funds',
    amount: -10,
    type: 'BET',
  });
  assert.deepEqual(ledger, { balanceBefore: 100, balanceAfter: 90 });
  assert.equal(prisma.users.get('user-funds')?.balance, 90);
  assert.equal(changeCalls.length, 1);
  assert.equal(changeCalls[0]?.type, 'BET');
  assert.equal(changeCalls[0]?.isPlayMode, false);

  const win = await updateUserBalanceWithLedger({
    userId: 'user-funds',
    amount: 5,
    type: 'WIN',
  });
  assert.deepEqual(win, { balanceBefore: 90, balanceAfter: 95 });
  assert.equal(prisma.users.get('user-funds')?.balance, 95);

  assert.equal(await resetPlayBalance('user-funds'), 10000);
  assert.equal(prisma.users.get('user-funds')?.playBalance, 10000);

  const afterRecharge = await rechargeBalance('user-funds', 10, 'order-recharge', 'trade-recharge');
  assert.equal(afterRecharge, 105);
});
