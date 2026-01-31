/**
 * Bets API
 * GET - 获取投注历史
 * POST/PUT - 已禁用（使用 WebSocket GameEngine）
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function validateUserStatus(userId: string, prismaClient = prisma) {
  const userStatus = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { active: true, silenced: true },
  });

  if (!userStatus) {
    return NextResponse.json(
      { error: "用户不存在" },
      { status: 404 }
    );
  }

  if (!userStatus.active) {
    return NextResponse.json(
      { error: "账号已被封禁" },
      { status: 403 }
    );
  }

  if (userStatus.silenced) {
    return NextResponse.json(
      { error: "账号已被禁言" },
      { status: 403 }
    );
  }

  return null;
}

export type BetsDeps = {
  auth?: () => Promise<any>;
  getUserBetHistory?: typeof import("@/lib/services/user").getUserBetHistory;
  prismaClient?: typeof prisma;
};

/**
 * Internal handler with dependency injection support for testing
 */
export async function handleGetBets(_request: NextRequest, deps: BetsDeps = {}) {
  try {
    const auth = deps.auth ?? (await import("@/lib/auth")).auth;
    const getUserBetHistory = deps.getUserBetHistory ?? (await import("@/lib/services/user")).getUserBetHistory;
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401 }
      );
    }

    const statusError = await validateUserStatus(session.user.id, deps.prismaClient ?? prisma);
    if (statusError) return statusError;

    const history = await getUserBetHistory(session.user.id);
    return NextResponse.json({ bets: history });
  } catch (error) {
    console.error("获取投注历史失败:", error);
    return NextResponse.json(
      { error: "获取投注历史失败" },
      { status: 500 }
    );
  }
}

/**
 * Next.js Route Handler - GET /api/user/bets
 */
export async function GET(request: NextRequest) {
  return handleGetBets(request);
}

/**
 * Next.js Route Handler - POST /api/user/bets (disabled)
 */
export async function POST() {
  return NextResponse.json(
    { error: "此 API 已禁用，请使用 WebSocket GameEngine.placeBet()" },
    { status: 403 }
  );
}

/**
 * Next.js Route Handler - PUT /api/user/bets (disabled)
 */
export async function PUT() {
  return NextResponse.json(
    { error: "此 API 已禁用，请使用 WebSocket GameEngine.placeBet()" },
    { status: 403 }
  );
}
