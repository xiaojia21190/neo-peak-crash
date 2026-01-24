/**
 * Bets API
 * GET - 鑾峰彇鎶曟敞鍘嗗彶
 * POST/PUT - 宸茬鐢紙浣跨敤 WebSocket GameEngine锛? */

import { NextResponse } from "next/server";
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

type BetsDeps = {
  auth?: () => Promise<any>;
  getUserBetHistory?: typeof import("@/lib/services/user").getUserBetHistory;
  prismaClient?: typeof prisma;
};

// 鑾峰彇鎶曟敞鍘嗗彶
export async function GET(deps: BetsDeps = {}) {
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
    console.error("鑾峰彇鎶曟敞鍘嗗彶澶辫触:", error);
    return NextResponse.json(
      { error: "获取投注历史失败" },
      { status: 500 }
    );
  }
}

// 涓嬫敞 - 宸茬鐢紙璇蜂娇鐢?WebSocket GameEngine.placeBet锛?
export async function POST() {
  return NextResponse.json(
    { error: "此 API 已禁用，请使用 WebSocket GameEngine.placeBet()" },
    { status: 403 }
  );
}

// 缁撶畻 - 宸茬鐢紙鐢辨湇鍔＄娓告垙寮曟搸澶勭悊锛?
export async function PUT() {
  return NextResponse.json(
    { error: "此 API 已禁用，请使用 WebSocket GameEngine.placeBet()" },
    { status: 403 }
  );
}
