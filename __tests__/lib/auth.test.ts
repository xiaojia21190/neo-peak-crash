import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const baseUrl = 'http://localhost:3000';

const originalEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  LINUXDO_CLIENT_ID: process.env.LINUXDO_CLIENT_ID,
  LINUXDO_CLIENT_SECRET: process.env.LINUXDO_CLIENT_SECRET,
  LINUXDO_AUTHORIZATION_URL: process.env.LINUXDO_AUTHORIZATION_URL,
  LINUXDO_TOKEN_URL: process.env.LINUXDO_TOKEN_URL,
  LINUXDO_USERINFO_URL: process.env.LINUXDO_USERINFO_URL,
};

process.env.AUTH_SECRET = 'test-auth-secret';
process.env.NEXTAUTH_URL = baseUrl;
process.env.LINUXDO_CLIENT_ID = 'test-client-id';
process.env.LINUXDO_CLIENT_SECRET = 'test-client-secret';
process.env.LINUXDO_AUTHORIZATION_URL = 'https://oauth.example/authorize';
process.env.LINUXDO_TOKEN_URL = 'https://oauth.example/token';
process.env.LINUXDO_USERINFO_URL = 'https://oauth.example/user';

const authModule = import('../../lib/auth');

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
});

function getSetCookies(res: Response): string[] {
  const headers = res.headers as any;
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();

  const raw = res.headers.get('set-cookie');
  if (!raw) return [];
  return [raw];
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function startLinuxDoOAuth() {
  const mod: any = await authModule;
  const { handlers } = mod.default ?? mod;

  const csrfRes = await handlers.GET(new NextRequest(`${baseUrl}/api/auth/csrf`));
  assert.equal(csrfRes.status, 200);
  const { csrfToken } = await csrfRes.json();
  const csrfCookieHeader = cookieHeaderFromSetCookies(getSetCookies(csrfRes));

  const signinBody = new URLSearchParams({
    csrfToken,
    callbackUrl: baseUrl,
  });

  const signinRes = await handlers.POST(
    new NextRequest(`${baseUrl}/api/auth/signin/linux-do`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: csrfCookieHeader,
      },
      body: signinBody,
    })
  );

  assert.equal(signinRes.status, 302);
  const location = signinRes.headers.get('location');
  assert.ok(location);

  const state = new URL(location).searchParams.get('state');
  assert.ok(state);

  const signinCookieHeader = cookieHeaderFromSetCookies(getSetCookies(signinRes));
  const cookieHeader = [csrfCookieHeader, signinCookieHeader].filter(Boolean).join('; ');

  return { handlers, state, cookieHeader };
}

describe('lib/auth oauth callback error handling', () => {
  test('rejects invalid state', async () => {
    const { handlers, cookieHeader } = await startLinuxDoOAuth();

    const response = await handlers.GET(
      new NextRequest(`${baseUrl}/api/auth/callback/linux-do?code=abc&state=INVALID`, {
        headers: { cookie: cookieHeader },
      })
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${baseUrl}/api/auth/error?error=Configuration`);
  });

  test('handles token exchange failure', async () => {
    const { handlers, state, cookieHeader } = await startLinuxDoOAuth();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === process.env.LINUXDO_TOKEN_URL) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await handlers.GET(
        new NextRequest(
          `${baseUrl}/api/auth/callback/linux-do?code=abc&state=${encodeURIComponent(state)}`,
          {
            headers: { cookie: cookieHeader },
          }
        )
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `${baseUrl}/api/auth/error?error=Configuration`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('handles userinfo failure', async () => {
    const { handlers, state, cookieHeader } = await startLinuxDoOAuth();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === process.env.LINUXDO_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url) === process.env.LINUXDO_USERINFO_URL) {
        return new Response('upstream failed', { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await handlers.GET(
        new NextRequest(
          `${baseUrl}/api/auth/callback/linux-do?code=abc&state=${encodeURIComponent(state)}`,
          {
            headers: { cookie: cookieHeader },
          }
        )
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `${baseUrl}/api/auth/error?error=Configuration`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('lib/auth oauth success path', () => {
  test('sets session cookie after successful callback', async () => {
    const { handlers, state, cookieHeader } = await startLinuxDoOAuth();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === process.env.LINUXDO_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url) === process.env.LINUXDO_USERINFO_URL) {
        return new Response(
          JSON.stringify({
            id: 123,
            username: 'alice',
            avatar_template: 'https://avatar/{size}.png',
            trust_level: 2,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await handlers.GET(
        new NextRequest(
          `${baseUrl}/api/auth/callback/linux-do?code=abc&state=${encodeURIComponent(state)}`,
          {
            headers: { cookie: cookieHeader },
          }
        )
      );

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), baseUrl);

      const setCookies = getSetCookies(response);
      const sessionCookie = setCookies.find((cookie) => cookie.startsWith('authjs.session-token='));
      assert.ok(sessionCookie);

      const sessionRes = await handlers.GET(
        new NextRequest(`${baseUrl}/api/auth/session`, {
          headers: { cookie: sessionCookie!.split(';')[0] },
        })
      );

      assert.equal(sessionRes.status, 200);
      const session = await sessionRes.json();
      assert.equal(session.user?.provider, 'linux-do');
      assert.equal(session.user?.username, 'alice');
      assert.equal(session.user?.trustLevel, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
