import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const ldcModule = import('../../../lib/payment/ldc');

async function loadLdc() {
  const mod: any = await ldcModule;
  return mod.default ?? mod;
}

const originalEnv = {
  LDC_CLIENT_ID: process.env.LDC_CLIENT_ID,
  LDC_CLIENT_SECRET: process.env.LDC_CLIENT_SECRET,
  LDC_GATEWAY: process.env.LDC_GATEWAY,
};

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
});

beforeEach(() => {
  if (originalEnv.LDC_CLIENT_ID === undefined) delete process.env.LDC_CLIENT_ID;
  else process.env.LDC_CLIENT_ID = originalEnv.LDC_CLIENT_ID;

  if (originalEnv.LDC_CLIENT_SECRET === undefined) delete process.env.LDC_CLIENT_SECRET;
  else process.env.LDC_CLIENT_SECRET = originalEnv.LDC_CLIENT_SECRET;

  if (originalEnv.LDC_GATEWAY === undefined) delete process.env.LDC_GATEWAY;
  else process.env.LDC_GATEWAY = originalEnv.LDC_GATEWAY;
});

describe('lib/payment/ldc createPayment', () => {
  test('returns error when LDC_CLIENT_SECRET is missing', async () => {
    process.env.LDC_CLIENT_ID = 'pid';
    delete process.env.LDC_CLIENT_SECRET;

    const { createPayment } = await loadLdc();
    const result = createPayment('trade-1', 12.34, 'Product', 'https://notify', 'https://return');
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('LDC_CLIENT_ID'));
  });

  test('returns error when LDC_CLIENT_ID is missing', async () => {
    delete process.env.LDC_CLIENT_ID;
    process.env.LDC_CLIENT_SECRET = 'secret';

    const { createPayment } = await loadLdc();
    const result = createPayment('trade-2', 12.34, 'Product', 'https://notify', 'https://return');
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('LDC_CLIENT_SECRET'));
  });

  test('creates signed payment form when configured', async () => {
    process.env.LDC_CLIENT_ID = 'pid';
    process.env.LDC_CLIENT_SECRET = 'secret';
    process.env.LDC_GATEWAY = 'https://credit.example.com/';

    const { createPayment, generateSign } = await loadLdc();
    const result = createPayment('trade-3', 10, 'Product', 'https://notify', 'https://return');
    assert.equal(result.success, true);
    assert.ok(result.paymentForm);
    assert.equal(result.paymentForm?.actionUrl, 'https://credit.example.com/epay/submit.php');

    const params = result.paymentForm!.params;
    assert.equal(params.pid, 'pid');
    assert.equal(params.type, 'ldc');
    assert.equal(params.out_trade_no, 'trade-3');
    assert.equal(params.money, '10.00');
    assert.equal(params.notify_url, 'https://notify');
    assert.equal(params.return_url, 'https://return');
    assert.equal(params.device, 'pc');
    assert.equal(params.sign_type, 'MD5');
    assert.match(params.sign, /^[a-f0-9]{32}$/);

    const expected = generateSign(params, 'secret');
    assert.equal(params.sign, expected);
  });
});

describe('lib/payment/ldc generateSign edge cases', () => {
  test('sorts parameters and ignores sign/sign_type/empty values', async () => {
    const secret = 'k';
    const params = {
      b: '2',
      a: '1',
      empty: '',
      sign: 'ignored',
      sign_type: 'MD5',
    };

    const expectedQuery = 'a=1&b=2';
    const expected = crypto.createHash('md5').update(expectedQuery + secret).digest('hex');
    const { generateSign } = await loadLdc();
    assert.equal(generateSign(params, secret), expected);
  });

  test('handles empty parameter set after filtering', async () => {
    const secret = 'k';
    const params = {
      sign: 'ignored',
      sign_type: 'MD5',
      empty: '',
    };

    const expected = crypto.createHash('md5').update(secret).digest('hex');
    const { generateSign } = await loadLdc();
    assert.equal(generateSign(params, secret), expected);
  });
});
