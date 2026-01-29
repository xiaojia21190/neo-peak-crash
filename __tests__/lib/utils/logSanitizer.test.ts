import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogParams, maskMiddle } from '../../../lib/utils/logSanitizer';

describe('Log Sanitizer', () => {
  describe('sanitizeLogParams', () => {
    test('removes sensitive fields completely', () => {
      const params = {
        name: 'test',
        sign: 'abc123secret',
        key: 'privatekey',
        secret: 'topsecret',
        password: 'mypassword',
        token: 'bearertoken',
      };

      const sanitized = sanitizeLogParams(params);

      assert.equal(sanitized.name, 'test');
      assert.equal(sanitized.sign, undefined);
      assert.equal(sanitized.key, undefined);
      assert.equal(sanitized.secret, undefined);
      assert.equal(sanitized.password, undefined);
      assert.equal(sanitized.token, undefined);
    });

    test('masks trade_no and out_trade_no partially', () => {
      const params = {
        trade_no: '1234567890abcdef',
        out_trade_no: 'ORDER2024010112345678',
      };

      const sanitized = sanitizeLogParams(params);

      assert.equal(sanitized.trade_no, '1234****cdef');
      assert.equal(sanitized.out_trade_no, 'ORDE****5678');
    });

    test('keeps short values unmasked for partial mask fields', () => {
      const params = {
        trade_no: '12345678', // exactly 8 chars
        out_trade_no: 'short',
      };

      const sanitized = sanitizeLogParams(params);

      // 8 chars or less should not be masked
      assert.equal(sanitized.trade_no, '12345678');
      assert.equal(sanitized.out_trade_no, 'short');
    });

    test('preserves non-sensitive fields', () => {
      const params = {
        pid: '12345',
        money: '100.00',
        trade_status: 'TRADE_SUCCESS',
        notify_url: 'https://example.com/notify',
      };

      const sanitized = sanitizeLogParams(params);

      assert.equal(sanitized.pid, '12345');
      assert.equal(sanitized.money, '100.00');
      assert.equal(sanitized.trade_status, 'TRADE_SUCCESS');
      assert.equal(sanitized.notify_url, 'https://example.com/notify');
    });

    test('handles case insensitive field names', () => {
      const params = {
        SIGN: 'should-be-removed',
        Sign: 'also-removed',
        SECRET: 'removed-too',
      };

      const sanitized = sanitizeLogParams(params);

      assert.equal(sanitized.SIGN, undefined);
      assert.equal(sanitized.Sign, undefined);
      assert.equal(sanitized.SECRET, undefined);
    });

    test('handles empty object', () => {
      const sanitized = sanitizeLogParams({});
      assert.deepEqual(sanitized, {});
    });
  });

  describe('maskMiddle', () => {
    test('masks middle of string with default visible chars', () => {
      assert.equal(maskMiddle('1234567890abcdef'), '1234****cdef');
    });

    test('masks with custom visible chars', () => {
      assert.equal(maskMiddle('1234567890abcdef', 2), '12****ef');
    });

    test('returns original for short strings', () => {
      assert.equal(maskMiddle('12345678'), '12345678');
      assert.equal(maskMiddle('short'), 'short');
    });

    test('handles empty string', () => {
      assert.equal(maskMiddle(''), '');
    });
  });
});
