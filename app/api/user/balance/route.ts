/**
 * 用户余额 API
 * GET - 获取当前用户余额
 * POST - 重置游玩余额
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
let cachedFinancialService: { setPlayBalance: (userId: string, newBalance: number) => Promise<number> } | null = null;

async function getFinancialService() {
  if (!cachedFinancialService) {
    const { FinancialService } = await import("@/lib/services/financial");
    cachedFinancialService = new FinancialService(prisma);
  }
  return cachedFinancialService;
}

type BalanceDeps = {
  auth?: () => Promise<any>;
  getOrCreateUser?: typeof import("@/lib/services/user").getOrCreateUser;
  prismaClient?: typeof prisma;
  setPlayBalance?: (userId: string, newBalance: number) => Promise<number>;
};

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

// 获取用户余额
export async function GET(deps: BalanceDeps = {}) {
  try {
    const auth = deps.auth ?? (await import("@/lib/auth")).auth;
    const getOrCreateUser = deps.getOrCreateUser ?? (await import("@/lib/services/user")).getOrCreateUser;
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const username = (session.user as { username?: string }).username;

    // 获取或创建用户
    const user = await getOrCreateUser({
      id: userId,
      username: username || `user_${userId}`,
      name: session.user.name || undefined,
      avatar: session.user.image || undefined,
      trustLevel: (session.user as { trustLevel?: number }).trustLevel,
    });

    const statusError = await validateUserStatus(userId, deps.prismaClient ?? prisma);
    if (statusError) return statusError;

    return NextResponse.json({
      balance: user.balance,
      playBalance: user.playBalance,
      totalWins: user.totalWins,
      totalLosses: user.totalLosses,
      totalBets: user.totalBets,
      totalProfit: user.totalProfit,
    });
  } catch (error) {
    console.error("获取余额失败:", error);
    return NextResponse.json(
      { error: "获取余额失败" },
      { status: 500 }
    );
  }
}

// 更新用户余额
export async function POST(request: NextRequest, deps: BalanceDeps = {}) {
  try {
    const auth = deps.auth ?? (await import("@/lib/auth")).auth;
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const body = await request.json();
    const { action } = body;

    const statusError = await validateUserStatus(userId, deps.prismaClient ?? prisma);
    if (statusError) return statusError;

    // 验证参数
    if (!action) {
      return NextResponse.json(
        { error: "缺少 action 参数" },
        { status: 400 }
      );
    }

    // 重置游戏余额
    if (action === "reset_play_balance") {
      const financialService = deps.setPlayBalance ? null : await getFinancialService();
      const setPlayBalance = deps.setPlayBalance ?? financialService!.setPlayBalance.bind(financialService);
      const newBalance = await setPlayBalance(userId, 10000);
      return NextResponse.json({ playBalance: newBalance });
    }

    if (action === "update") {
      return NextResponse.json(
        { error: "此 API 已禁用。余额变更由服务端游戏引擎处理。" },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: "未知的操作" },
      { status: 400 }
    );
  } catch (error) {
    console.error("更新余额失败:", error);
    return NextResponse.json(
      { error: "更新余额失败" },
      { status: 500 }
    );
  }
}
