import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { verifyNextAuthCookie, verifyNextAuthToken } from '../../../lib/game-engine/wsAuth';

type JwtMocks = {
  decode: (args: any) => Promise<any>;
  getToken: (args: any) => Promise<any>;
};

const jwtMockUrl = (() => {
  const source = `
    export async function decode(args) {
      const impl = globalThis.__nextAuthJwtMock?.decode;
      if (typeof impl !== 'function') throw new Error('decode mock not configured');
      return impl(args);
    }

    export async function getToken(args) {
      const impl = globalThis.__nextAuthJwtMock?.getToken;
      if (typeof impl !== 'function') throw new Error('getToken mock not configured');
      return impl(args);
    }
  `;

  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
})();

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next-auth/jwt') {
      return { url: jwtMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const originalEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
};

const originalConsoleError = console.error;

after(() => {
  hooks.deregister();

  delete (globalThis as any).__nextAuthJwtMock;
  console.error = originalConsoleError;

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
});

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret';
  delete (process.env as any).NEXTAUTH_SECRET;

  (globalThis as any).__nextAuthJwtMock = {
    decode: async () => {
      throw new Error('Unexpected decode call');
    },
    getToken: async () => {
      throw new Error('Unexpected getToken call');
    },
  } satisfies JwtMocks;

  console.error = () => {};
});

describe('lib/game-engine/wsAuth verifyNextAuthToken', () => {
  test('null for empty token', async () => {
    const prisma = {
      user: {
        findUnique: async () => {
          throw new Error('Should not query prisma for empty token');
        },
      },
    } as any;

    assert.equal(await verifyNextAuthToken({ token: '', prisma }), null);
  });

  test('null when AUTH_SECRET missing', async () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;

    const prisma = {
      user: {
        findUnique: async () => {
          throw new Error('Should not query prisma when secret missing');
        },
      },
    } as any;

    assert.equal(await verifyNextAuthToken({ token: 'token', prisma }), null);
  });

  test('userId on valid decode', async () => {
    const decodeCalls: any[] = [];

    (globalThis as any).__nextAuthJwtMock.decode = async (args: any) => {
      decodeCalls.push(args);
      return { id: 'user-1' };
    };

    const prismaCalls: any[] = [];
    const prisma = {
      user: {
        findUnique: async (args: any) => {
          prismaCalls.push(args);
          return { id: 'user-1' };
        },
      },
    } as any;

    const userId = await verifyNextAuthToken({ token: 'jwt-token', prisma });
    assert.equal(userId, 'user-1');

    assert.deepEqual(decodeCalls, [{ token: 'jwt-token', secret: 'test-auth-secret', salt: '' }]);
    assert.equal(prismaCalls.length, 1);
    assert.equal(prismaCalls[0]?.where?.id, 'user-1');
  });

  test('null when user not in DB', async () => {
    (globalThis as any).__nextAuthJwtMock.decode = async () => ({ id: 'missing-user' });

    const prisma = {
      user: {
        findUnique: async () => null,
      },
    } as any;

    assert.equal(await verifyNextAuthToken({ token: 'jwt-token', prisma }), null);
  });

  test('null on decode error', async () => {
    (globalThis as any).__nextAuthJwtMock.decode = async () => {
      throw new Error('decode failed');
    };

    let findUniqueCalls = 0;
    const prisma = {
      user: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return { id: 'user-1' };
        },
      },
    } as any;

    assert.equal(await verifyNextAuthToken({ token: 'jwt-token', prisma }), null);
    assert.equal(findUniqueCalls, 0);
  });
});

describe('lib/game-engine/wsAuth verifyNextAuthCookie', () => {
  test('null for missing cookie header', async () => {
    const req = { headers: {} } as any;
    const prisma = {} as any;

    assert.equal(await verifyNextAuthCookie({ req, prisma }), null);
  });

  test('null when no session token', async () => {
    const req = { headers: { cookie: 'foo=bar' } } as any;
    const prisma = {} as any;

    assert.equal(await verifyNextAuthCookie({ req, prisma }), null);
  });

  test('userId on valid cookie', async () => {
    const getTokenCalls: any[] = [];
    (globalThis as any).__nextAuthJwtMock.getToken = async (args: any) => {
      getTokenCalls.push(args);
      return { id: 'user-2' };
    };

    const prisma = {
      user: {
        findUnique: async () => ({ id: 'user-2' }),
      },
    } as any;

    const req = { headers: { cookie: 'authjs.session-token=abc' } } as any;
    const userId = await verifyNextAuthCookie({ req, prisma });

    assert.equal(userId, 'user-2');
    assert.equal(getTokenCalls.length, 1);
    assert.equal(getTokenCalls[0]?.secret, 'test-auth-secret');
    assert.equal(getTokenCalls[0]?.req, req);
  });

  test('null on getToken error', async () => {
    (globalThis as any).__nextAuthJwtMock.getToken = async () => {
      throw new Error('getToken failed');
    };

    let findUniqueCalls = 0;
    const prisma = {
      user: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return { id: 'user-2' };
        },
      },
    } as any;

    const req = { headers: { cookie: 'authjs.session-token=abc' } } as any;
    assert.equal(await verifyNextAuthCookie({ req, prisma }), null);
    assert.equal(findUniqueCalls, 0);
  });
});

