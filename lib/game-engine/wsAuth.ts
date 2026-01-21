import type { PrismaClient } from '@prisma/client';
import type { IncomingMessage } from 'http';

function getAuthSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

function getSessionTokenFromCookieHeader(cookieHeader: string): string | null {
  const cookies = parseCookies(cookieHeader);
  return (
    cookies['authjs.session-token'] ||
    cookies['__Secure-authjs.session-token'] ||
    cookies['next-auth.session-token'] ||
    cookies['__Secure-next-auth.session-token'] ||
    null
  );
}

export async function verifyNextAuthToken(args: { token: string; prisma: PrismaClient }): Promise<string | null> {
  try {
    if (!args.token) return null;

    const secret = getAuthSecret();
    if (!secret) {
      console.error('[WSGateway] AUTH_SECRET not configured');
      return null;
    }

    const { decode } = await import('next-auth/jwt');
    const decoded = await decode({
      token: args.token,
      secret,
      salt: '',
    });

    if (!decoded?.id) {
      return null;
    }

    const user = await args.prisma.user.findUnique({
      where: { id: decoded.id as string },
      select: { id: true },
    });

    return user?.id ?? null;
  } catch (error) {
    console.error('[WSGateway] Token verification failed:', error);
    return null;
  }
}

export async function verifyNextAuthCookie(args: { req: IncomingMessage; prisma: PrismaClient }): Promise<string | null> {
  try {
    const cookieHeader = args.req.headers.cookie;
    if (!cookieHeader) return null;

    const sessionToken = getSessionTokenFromCookieHeader(cookieHeader);
    if (!sessionToken) return null;

    const secret = getAuthSecret();
    if (!secret) {
      console.error('[WSGateway] AUTH_SECRET not configured');
      return null;
    }

    const { getToken } = await import('next-auth/jwt');
    const decoded = await getToken({
      req: args.req as any,
      secret,
    });

    if (!decoded?.id) {
      return null;
    }

    const user = await args.prisma.user.findUnique({
      where: { id: decoded.id as string },
      select: { id: true },
    });

    return user?.id ?? null;
  } catch (error) {
    console.error('[WSGateway] Cookie verification failed:', error);
    return null;
  }
}

