/**
 * 用户余额 API
 * GET - 获取当前用户余额
 * POST - 重置游玩余额
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getOrCreateUser } from "@/lib/services/user";
import prisma from "@/lib/prisma";
import { FinancialService } from "@/lib/services/financial";

const financialService = new FinancialService(prisma);

// 获取用户余额
export async function GET() {
  try {
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
export async function POST(request: NextRequest) {
  try {
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

    // 验证参数
    if (!action) {
      return NextResponse.json(
        { error: "缺少 action 参数" },
        { status: 400 }
      );
    }

    // 重置游戏余额
    if (action === "reset_play_balance") {
      const newBalance = await financialService.setPlayBalance(userId, 10000);
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
