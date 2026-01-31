import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerEntry, getUserLedger } from '../../../lib/services/ledger';

class FakePrisma {
  calls: { create?: any; findMany?: any } = {};

  transaction = {
    create: async (args: any) => {
      this.calls.create = args;
      return { id: 'txn-1' };
    },
    findMany: async (args: any) => {
      this.calls.findMany = args;
      return [{ id: 'txn-1' }];
    },
  };
}

const ARROW = '\u2192';
const LABELS = {
  DEPOSIT: '\u5145\u503c',
  BET: '\u4e0b\u6ce8\u6263\u6b3e',
  WIN: '\u6295\u6ce8\u8d62\u94b1',
  REFUND: '\u9000\u6b3e',
} as const;

const ENTRY_CASES: Array<{
  ledgerType: 'DEPOSIT' | 'BET' | 'WIN' | 'REFUND';
  txType: string;
  label: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  supportsBetId: boolean;
}> = [
  {
    ledgerType: 'DEPOSIT',
    txType: 'RECHARGE',
    label: LABELS.DEPOSIT,
    amount: 50,
    balanceBefore: 100,
    balanceAfter: 150,
    supportsBetId: false,
  },
  {
    ledgerType: 'BET',
    txType: 'BET_LOSE',
    label: LABELS.BET,
    amount: -20,
    balanceBefore: 50,
    balanceAfter: 30,
    supportsBetId: true,
  },
  {
    ledgerType: 'WIN',
    txType: 'BET_WIN',
    label: LABELS.WIN,
    amount: 15,
    balanceBefore: 30,
    balanceAfter: 45,
    supportsBetId: true,
  },
  {
    ledgerType: 'REFUND',
    txType: 'RECHARGE',
    label: LABELS.REFUND,
    amount: 10,
    balanceBefore: 45,
    balanceAfter: 55,
    supportsBetId: true,
  },
];

function formatBalances(balanceBefore: number, balanceAfter: number) {
  return `${balanceBefore.toFixed(2)} ${ARROW} ${balanceAfter.toFixed(2)}`;
}

function buildExpectedRemark(options: {
  label: string;
  supportsBetId: boolean;
  relatedBetId?: string;
  balanceBefore?: number;
  balanceAfter?: number;
}) {
  const parts: string[] = [options.label];
  if (options.supportsBetId && options.relatedBetId) {
    parts.push(`betId:${options.relatedBetId}`);
  }
  if (options.balanceBefore !== undefined && options.balanceAfter !== undefined) {
    parts.push(formatBalances(options.balanceBefore, options.balanceAfter));
  }
  return parts.join(' | ');
}

for (const entry of ENTRY_CASES) {
  for (const includeBetId of [true, false]) {
    for (const includeBalances of [true, false]) {
      const scenarioName = [
        `createLedgerEntry ${entry.ledgerType}`,
        includeBetId ? 'with betId' : 'without betId',
        includeBalances ? 'with balances' : 'without balances',
      ].join(' ');

      test(scenarioName, async () => {
        const prisma = new FakePrisma();
        const relatedBetId = includeBetId ? 'bet-1' : undefined;

        const balanceBefore = includeBalances ? entry.balanceBefore : (undefined as any);
        const balanceAfter = includeBalances ? entry.balanceAfter : (undefined as any);

        await createLedgerEntry(prisma as any, {
          userId: 'user-1',
          type: entry.ledgerType,
          amount: entry.amount,
          balanceBefore,
          balanceAfter,
          relatedBetId,
        });

        assert.ok(prisma.calls.create?.data);
        assert.equal(prisma.calls.create.data.userId, 'user-1');
        assert.equal(prisma.calls.create.data.type, entry.txType);
        assert.equal(prisma.calls.create.data.amount, entry.amount);
        assert.equal(prisma.calls.create.data.status, 'COMPLETED');
        assert.ok(prisma.calls.create.data.completedAt instanceof Date);

        const expectedRemark = buildExpectedRemark({
          label: entry.label,
          supportsBetId: entry.supportsBetId,
          relatedBetId,
          balanceBefore: includeBalances ? entry.balanceBefore : undefined,
          balanceAfter: includeBalances ? entry.balanceAfter : undefined,
        });
        assert.equal(prisma.calls.create.data.remark, expectedRemark);
      });
    }
  }
}

test('createLedgerEntry warns when balance mismatch exceeds 0.01', async () => {
  const prisma = new FakePrisma();
  const originalWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args: any[]) => {
    warns.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    await createLedgerEntry(prisma as any, {
      userId: 'user-1',
      type: 'DEPOSIT',
      amount: 10,
      balanceBefore: 0,
      balanceAfter: 10.02,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warns.length, 1);
  assert.ok(warns[0]?.includes('[Ledger] Balance mismatch'));
  assert.ok(warns[0]?.includes('but got 10.02'));
});

test('createLedgerEntry maps unknown ledger types to RECHARGE', async () => {
  const prisma = new FakePrisma();

  await createLedgerEntry(prisma as any, {
    userId: 'user-1',
    type: 'UNKNOWN' as any,
    amount: 1,
    balanceBefore: 0,
    balanceAfter: 1,
    remark: 'custom',
  });

  assert.equal(prisma.calls.create?.data?.type, 'RECHARGE');
  assert.equal(prisma.calls.create?.data?.remark, 'custom');
});

test('getUserLedger without options uses default filters', async () => {
  const prisma = new FakePrisma();

  const result = await getUserLedger(prisma as any, 'user-1');

  assert.equal(result.length, 1);
  assert.deepEqual(prisma.calls.findMany?.where, { userId: 'user-1' });
  assert.deepEqual(prisma.calls.findMany?.orderBy, { createdAt: 'desc' });
  assert.equal(prisma.calls.findMany?.take, 100);
});

test('getUserLedger applies type filter mapping', async () => {
  const prisma = new FakePrisma();

  await getUserLedger(prisma as any, 'user-1', { type: 'BET' });

  assert.equal(prisma.calls.findMany?.where?.userId, 'user-1');
  assert.equal(prisma.calls.findMany?.where?.type, 'BET_LOSE');
});

test('getUserLedger applies start/end date filters', async () => {
  const prisma = new FakePrisma();
  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date('2025-02-01T00:00:00Z');

  await getUserLedger(prisma as any, 'user-1', { startDate, endDate });

  assert.equal(prisma.calls.findMany?.where?.userId, 'user-1');
  assert.equal(prisma.calls.findMany?.where?.createdAt?.gte, startDate);
  assert.equal(prisma.calls.findMany?.where?.createdAt?.lte, endDate);
});

test('getUserLedger respects limit option', async () => {
  const prisma = new FakePrisma();

  await getUserLedger(prisma as any, 'user-1', { limit: 5 });

  assert.equal(prisma.calls.findMany?.take, 5);
});

