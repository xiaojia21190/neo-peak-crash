import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSign } from '../../../lib/payment/ldc';
import { prismaMock } from '../../helpers/prismaMock';

const originalPrisma = (globalThis as any).prisma;
(globalThis as any).prisma = prismaMock as any;

const originalSecret = process.env.LDC_CLIENT_SECRET;
const originalPid = process.env.LDC_CLIENT_ID;

const routeModule = import('../../../app/api/payment/notify/route');

after(() => {
  if (originalPrisma === undefined) {
    delete (globalThis as any).prisma;
  } else {
    (globalThis as any).prisma = originalPrisma;
  }

  if (originalSecret === undefined) delete process.env.LDC_CLIENT_SECRET;
  else process.env.LDC_CLIENT_SECRET = originalSecret;

  if (originalPid === undefined) delete process.env.LDC_CLIENT_ID;
  else process.env.LDC_CLIENT_ID = originalPid;
});

function buildSignedParams(
  params: Record<string, string>,
  secret: string
): Record<string, string> {
  const withMeta = { ...params, sign_type: 'MD5' };
  const sign = generateSign(withMeta, secret);
  return { ...withMeta, sign };
}

function buildGetRequest(params: Record<string, string>) {
  return {
    method: 'GET',
    nextUrl: { searchParams: new URLSearchParams(params) },
  } as any;
}

test('payment notify rejects missing required params', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  const { GET } = await routeModule;
  const response = await GET(buildGetRequest({ out_trade_no: 'order-req', trade_status: 'TRADE_SUCCESS', sign: 'x' }));

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'fail');
});

test('payment notify rejects invalid signature', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  const { GET } = await routeModule;
  const response = await GET(
    buildGetRequest({
      pid: 'pid',
      trade_no: 'trade-bad-sign',
      out_trade_no: 'order-bad-sign',
      trade_status: 'TRADE_SUCCESS',
      money: '10.00',
      sign: 'invalid',
    })
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'fail');
});

test('payment notify validates callback amount against pending order amount', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  prismaMock.seedTransaction({
    orderNo: 'order-mismatch',
    userId: 'user-mismatch',
    amount: 12,
    status: 'PENDING',
    type: 'RECHARGE',
  });

  const { GET } = await routeModule;
  const params = buildSignedParams(
    {
      pid: 'pid',
      trade_no: 'trade-mismatch',
      out_trade_no: 'order-mismatch',
      trade_status: 'TRADE_SUCCESS',
      money: '10.00',
    },
    'secret'
  );

  const response = await GET(buildGetRequest(params));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'fail');
});

test('payment notify completes pending order when amount matches', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  prismaMock.seedUser({
    id: 'user-ok',
    username: 'user-ok',
    balance: 0,
  });
  prismaMock.seedTransaction({
    orderNo: 'order-ok',
    userId: 'user-ok',
    amount: 10,
    status: 'PENDING',
    type: 'RECHARGE',
  });

  const { GET } = await routeModule;
  const params = buildSignedParams(
    {
      pid: 'pid',
      trade_no: 'trade-ok',
      out_trade_no: 'order-ok',
      trade_status: 'TRADE_SUCCESS',
      money: '10.00',
    },
    'secret'
  );

  const response = await GET(buildGetRequest(params));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
  assert.equal(prismaMock.users.get('user-ok')?.balance, 10);
  assert.equal(prismaMock.transactions.get('order-ok')?.status, 'COMPLETED');
});

test('payment notify is idempotent for completed orders', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  prismaMock.seedUser({
    id: 'user-done',
    username: 'user-done',
    balance: 20,
  });
  prismaMock.seedTransaction({
    orderNo: 'order-done',
    userId: 'user-done',
    amount: 10,
    status: 'COMPLETED',
    type: 'RECHARGE',
    balanceBefore: 10,
    balanceAfter: 20,
    tradeNo: 'trade-done',
  });

  const { GET } = await routeModule;
  const params = buildSignedParams(
    {
      pid: 'pid',
      trade_no: 'trade-done',
      out_trade_no: 'order-done',
      trade_status: 'TRADE_SUCCESS',
      money: '10.00',
    },
    'secret'
  );

  const response = await GET(buildGetRequest(params));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
  assert.equal(prismaMock.users.get('user-done')?.balance, 20);
});

test('payment notify returns success for non-success trade status', async () => {
  process.env.LDC_CLIENT_SECRET = 'secret';
  process.env.LDC_CLIENT_ID = 'pid';

  const { GET } = await routeModule;
  const params = buildSignedParams(
    {
      pid: 'pid',
      trade_no: 'trade-wait',
      out_trade_no: 'order-wait',
      trade_status: 'WAIT_BUYER_PAY',
      money: '10.00',
    },
    'secret'
  );

  const response = await GET(buildGetRequest(params));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
});

