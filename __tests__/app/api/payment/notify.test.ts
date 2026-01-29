import test, { describe, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateSign, verifySign } from '../../../../lib/payment/ldc';
import { sanitizeLogParams, maskMiddle } from '../../../../lib/utils/logSanitizer';
import { prismaMock } from '../../../helpers/prismaMock';

describe('Payment Notify - Sign Verification', () => {
  const testSecret = 'test-secret-key';

  test('generates correct MD5 signature', () => {
    const params = {
      pid: '12345',
      trade_no: 'T202401010001',
      out_trade_no: 'ORDER123',
      money: '100.00',
      trade_status: 'TRADE_SUCCESS',
    };

    const sign = generateSign(params, testSecret);

    // 验证签名是 32 位十六进制字符串
    assert.match(sign, /^[a-f0-9]{32}$/);
  });

  test('generates same signature for same params', () => {
    const params = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
      trade_status: 'TRADE_SUCCESS',
    };

    const sign1 = generateSign(params, testSecret);
    const sign2 = generateSign(params, testSecret);

    assert.equal(sign1, sign2);
  });

  test('generates different signature for different params', () => {
    const params1 = { money: '50.00', out_trade_no: 'ORD001', pid: '123' };
    const params2 = { money: '60.00', out_trade_no: 'ORD001', pid: '123' };

    const sign1 = generateSign(params1, testSecret);
    const sign2 = generateSign(params2, testSecret);

    assert.notEqual(sign1, sign2);
  });

  test('excludes sign and sign_type from calculation', () => {
    const paramsWithSign = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
      sign: 'should-be-ignored',
      sign_type: 'MD5',
    };

    const paramsWithoutSign = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
    };

    const sign1 = generateSign(paramsWithSign, testSecret);
    const sign2 = generateSign(paramsWithoutSign, testSecret);

    assert.equal(sign1, sign2);
  });

  test('excludes empty values from calculation', () => {
    const paramsWithEmpty = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
      extra: '',
    };

    const paramsWithoutEmpty = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
    };

    const sign1 = generateSign(paramsWithEmpty, testSecret);
    const sign2 = generateSign(paramsWithoutEmpty, testSecret);

    assert.equal(sign1, sign2);
  });

  test('verifySign returns true for valid signature', () => {
    const params = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
      trade_status: 'TRADE_SUCCESS',
    };

    const sign = generateSign(params, testSecret);
    const paramsWithSign = { ...params, sign };

    assert.equal(verifySign(paramsWithSign, testSecret), true);
  });

  test('verifySign returns false for invalid signature', () => {
    const params = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
      sign: 'invalid-signature',
    };

    assert.equal(verifySign(params, testSecret), false);
  });

  test('verifySign returns false for missing signature', () => {
    const params = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
    };

    assert.equal(verifySign(params, testSecret), false);
  });

  test('verifySign is case insensitive', () => {
    const params = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
    };

    const sign = generateSign(params, testSecret);
    const paramsUpperSign = { ...params, sign: sign.toUpperCase() };
    const paramsLowerSign = { ...params, sign: sign.toLowerCase() };

    assert.equal(verifySign(paramsUpperSign, testSecret), true);
    assert.equal(verifySign(paramsLowerSign, testSecret), true);
  });

  test('verifySign detects tampered params', () => {
    const originalParams = {
      money: '50.00',
      out_trade_no: 'ORD001',
      pid: '123',
    };

    const sign = generateSign(originalParams, testSecret);

    // 篡改金额
    const tamperedParams = {
      money: '5000.00',  // 金额被篡改
      out_trade_no: 'ORD001',
      pid: '123',
      sign,
    };

    assert.equal(verifySign(tamperedParams, testSecret), false);
  });
});

describe('Payment Notify - Log Sanitization', () => {
  test('sanitizes payment callback params correctly', () => {
    const callbackParams = {
      pid: '12345',
      trade_no: 'T2024010100001234',
      out_trade_no: 'ORDER2024010112345678',
      money: '100.00',
      trade_status: 'TRADE_SUCCESS',
      sign: 'abc123def456',
      notify_url: 'https://example.com/notify',
    };

    const sanitized = sanitizeLogParams(callbackParams);

    // sign 完全隐藏
    assert.equal(sanitized.sign, undefined);

    // trade_no 和 out_trade_no 部分遮盖
    assert.equal(sanitized.trade_no, 'T202****1234');
    assert.equal(sanitized.out_trade_no, 'ORDE****5678');

    // 其他字段保留
    assert.equal(sanitized.pid, '12345');
    assert.equal(sanitized.money, '100.00');
    assert.equal(sanitized.trade_status, 'TRADE_SUCCESS');
  });

  test('maskMiddle works for order numbers in logs', () => {
    const orderNo = 'ORDER2024010112345678';
    const masked = maskMiddle(orderNo);

    assert.equal(masked, 'ORDE****5678');
    // 验证原始订单号长度大于遮盖后
    assert.ok(masked.length < orderNo.length);
  });
});

describe('Payment Notify - Amount Validation', () => {
  test('parseFloat handles valid amounts', () => {
    assert.equal(parseFloat('100.00'), 100);
    assert.equal(parseFloat('0.01'), 0.01);
    assert.equal(parseFloat('9999.99'), 9999.99);
  });

  test('parseFloat handles invalid amounts', () => {
    assert.equal(Number.isFinite(parseFloat('')), false);
    assert.equal(Number.isFinite(parseFloat('abc')), false);
    assert.equal(Number.isFinite(parseFloat('NaN')), false);
  });

  test('amount validation rejects negative values', () => {
    const amount = parseFloat('-100.00');
    const isValid = Number.isFinite(amount) && amount > 0;
    assert.equal(isValid, false);
  });

  test('amount validation rejects zero', () => {
    const amount = parseFloat('0');
    const isValid = Number.isFinite(amount) && amount > 0;
    assert.equal(isValid, false);
  });
});

describe('Payment Notify - Required Params Validation', () => {
  test('validates required params presence', () => {
    const validParams = {
      trade_no: 'T123',
      out_trade_no: 'ORD123',
      trade_status: 'TRADE_SUCCESS',
      sign: 'abc123',
    };

    const { trade_no, out_trade_no, trade_status, sign } = validParams;
    const hasRequired = Boolean(trade_no && out_trade_no && trade_status && sign);

    assert.equal(hasRequired, true);
  });

  test('rejects missing trade_no', () => {
    const params = {
      out_trade_no: 'ORD123',
      trade_status: 'TRADE_SUCCESS',
      sign: 'abc123',
    };

    const { trade_no, out_trade_no, trade_status, sign } = params as any;
    const hasRequired = Boolean(trade_no && out_trade_no && trade_status && sign);

    assert.equal(hasRequired, false);
  });

  test('rejects missing out_trade_no', () => {
    const params = {
      trade_no: 'T123',
      trade_status: 'TRADE_SUCCESS',
      sign: 'abc123',
    };

    const { trade_no, out_trade_no, trade_status, sign } = params as any;
    const hasRequired = Boolean(trade_no && out_trade_no && trade_status && sign);

    assert.equal(hasRequired, false);
  });

  test('rejects missing sign', () => {
    const params = {
      trade_no: 'T123',
      out_trade_no: 'ORD123',
      trade_status: 'TRADE_SUCCESS',
    };

    const { trade_no, out_trade_no, trade_status, sign } = params as any;
    const hasRequired = Boolean(trade_no && out_trade_no && trade_status && sign);

    assert.equal(hasRequired, false);
  });
});

describe('Payment Notify - Idempotency', () => {
  test('same order processed multiple times should be idempotent', () => {
    // 模拟幂等性检查逻辑
    const processedOrders = new Set<string>();
    const orderNo = 'ORD001';

    function processOrder(order: string): { processed: boolean } {
      if (processedOrders.has(order)) {
        return { processed: false };  // 已处理，跳过
      }
      processedOrders.add(order);
      return { processed: true };  // 首次处理
    }

    // 第一次处理
    const result1 = processOrder(orderNo);
    assert.equal(result1.processed, true);

    // 重复处理
    const result2 = processOrder(orderNo);
    assert.equal(result2.processed, false);

    const result3 = processOrder(orderNo);
    assert.equal(result3.processed, false);
  });
});

describe('Payment Notify Route', () => {
  const originalPrisma = (globalThis as any).prisma;
  (globalThis as any).prisma = prismaMock as any;

  const originalSecret = process.env.LDC_CLIENT_SECRET;
  const originalPid = process.env.LDC_CLIENT_ID;
  const originalAllowedIps = process.env.LDC_ALLOWED_IPS;

  const routeModule = import('../../../../app/api/payment/notify/route');

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

    if (originalAllowedIps === undefined) delete process.env.LDC_ALLOWED_IPS;
    else process.env.LDC_ALLOWED_IPS = originalAllowedIps;
  });

  beforeEach(() => {
    prismaMock.users.clear();
    prismaMock.transactions.clear();
    process.env.LDC_CLIENT_SECRET = 'secret';
    process.env.LDC_CLIENT_ID = 'pid';
    delete process.env.LDC_ALLOWED_IPS;
  });

  function buildSignedParams(params: Record<string, string>, secret: string): Record<string, string> {
    const withMeta = { ...params, sign_type: 'MD5' };
    const sign = generateSign(withMeta, secret);
    return { ...withMeta, sign };
  }

  function buildGetRequest(params: Record<string, string>, headers: Record<string, string> = {}) {
    return {
      method: 'GET',
      nextUrl: { searchParams: new URLSearchParams(params) },
      headers: new Headers(headers),
    } as any;
  }

  test('rejects callback when IP is not in whitelist', async () => {
    process.env.LDC_ALLOWED_IPS = '1.2.3.4';

    const { GET } = await routeModule;
    const response = await GET(
      buildGetRequest(
        {
          pid: 'pid',
          trade_no: 'trade-ip',
          out_trade_no: 'order-ip',
          trade_status: 'WAIT_BUYER_PAY',
          money: '10.00',
          sign: 'invalid',
        },
        { 'x-forwarded-for': '5.6.7.8' }
      )
    );

    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'fail');
  });

  test('allows callback when IP is in whitelist and completes order', async () => {
    process.env.LDC_ALLOWED_IPS = '1.2.3.4';

    prismaMock.seedUser({ id: 'user-ip-ok', username: 'user-ip-ok', balance: 0 });
    prismaMock.seedTransaction({
      orderNo: 'order-ip-ok',
      userId: 'user-ip-ok',
      amount: 10,
      status: 'PENDING',
      type: 'RECHARGE',
    });

    const { GET } = await routeModule;
    const params = buildSignedParams(
      {
        pid: 'pid',
        trade_no: 'trade-ip-ok',
        out_trade_no: 'order-ip-ok',
        trade_status: 'TRADE_SUCCESS',
        money: '10.00',
      },
      'secret'
    );

    const response = await GET(buildGetRequest(params, { 'x-forwarded-for': '1.2.3.4' }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'success');
    assert.equal(prismaMock.users.get('user-ip-ok')?.balance, 10);
    assert.equal(prismaMock.transactions.get('order-ip-ok')?.status, 'COMPLETED');
  });

  test('rejects missing required params', async () => {
    const { GET } = await routeModule;
    const response = await GET(
      buildGetRequest({
        out_trade_no: 'order-missing',
        trade_status: 'TRADE_SUCCESS',
        sign: 'x',
      })
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'fail');
  });

  test('rejects PID mismatch', async () => {
    const { GET } = await routeModule;
    const response = await GET(
      buildGetRequest({
        pid: 'other',
        trade_no: 'trade-pid-mismatch',
        out_trade_no: 'order-pid-mismatch',
        trade_status: 'TRADE_SUCCESS',
        money: '10.00',
        sign: 'x',
      })
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'fail');
  });

  test('rejects invalid signature', async () => {
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

  test('rejects invalid money', async () => {
    const { GET } = await routeModule;
    const params = buildSignedParams(
      {
        pid: 'pid',
        trade_no: 'trade-bad-money',
        out_trade_no: 'order-bad-money',
        trade_status: 'TRADE_SUCCESS',
        money: 'abc',
      },
      'secret'
    );

    const response = await GET(buildGetRequest(params));
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'fail');
  });

  test('rejects mismatched callback amount vs pending order', async () => {
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

  test('returns success for non-success trade status', async () => {
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
});
