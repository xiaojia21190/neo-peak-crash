import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { validateSameOrigin } from '../../../lib/utils/csrf';

async function withTempEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    if (value === undefined) delete (process.env as any)[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete (process.env as any)[key];
      else process.env[key] = value;
    }
  }
}

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('https://unit.test/api', { headers });
}

test('validateSameOrigin returns true for matching origin header', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest({ origin: 'https://app.example' });
    assert.equal(validateSameOrigin(request), true);
  });
});

test('validateSameOrigin returns true for matching referer header', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest({ referer: 'https://app.example/some/page' });
    assert.equal(validateSameOrigin(request), true);
  });
});

test('validateSameOrigin returns false for mismatched origin', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest({ origin: 'https://evil.example' });
    assert.equal(validateSameOrigin(request), false);
  });
});

test('validateSameOrigin returns false when headers missing in production', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest();
    assert.equal(validateSameOrigin(request), false);
  });
});

test('validateSameOrigin returns true when headers missing in development', async () => {
  await withTempEnv({ NODE_ENV: 'development', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest();
    assert.equal(validateSameOrigin(request), true);
  });
});

test('validateSameOrigin returns false for invalid origin URL', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest({ origin: 'not-a-url' });
    assert.equal(validateSameOrigin(request), false);
  });
});

test('validateSameOrigin returns false for invalid NEXTAUTH_URL env', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'not-a-url' }, () => {
    const request = makeRequest({ origin: 'https://app.example' });
    assert.equal(validateSameOrigin(request), false);
  });
});

test('validateSameOrigin prefers origin over referer', async () => {
  await withTempEnv({ NODE_ENV: 'production', NEXTAUTH_URL: 'https://app.example' }, () => {
    const request = makeRequest({
      origin: 'https://evil.example',
      referer: 'https://app.example/some/page',
    });
    assert.equal(validateSameOrigin(request), false);
  });
});

