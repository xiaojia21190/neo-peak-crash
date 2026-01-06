/**
 * 用户余额 API
 * GET - 获取当前用户余额
 * POST - 更新余额（投注/结算）
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getOrCreateUser,
  getUserBalance,
  updateUserBalance,
  resetPlayBalance,
} from "@/lib/services/user";

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
    const { action, amount, isPlayMode } = body;

    // 验证参数
    if (!action) {
      return NextResponse.json(
        { error: "缺少 action 参数" },
        { status: 400 }
      );
    }

    // 重置游戏余额
    if (action === "reset_play_balance") {
      const newBalance = await resetPlayBalance(userId);
      return NextResponse.json({ playBalance: newBalance });
    }

    // 更新余额
    if (action === "update") {
      if (typeof amount !== "number") {
        return NextResponse.json(
          { error: "无效的金额" },
          { status: 400 }
        );
      }

      // 检查当前余额
      const currentBalance = await getUserBalance(userId);
      if (!currentBalance) {
        return NextResponse.json(
          { error: "用户不存在" },
          { status: 404 }
        );
      }

      const currentValue = isPlayMode
        ? currentBalance.playBalance
        : currentBalance.balance;

      // 如果是扣款，检查余额是否足够
      if (amount < 0 && currentValue + amount < 0) {
        return NextResponse.json(
          { error: "余额不足" },
          { status: 400 }
        );
      }

      const result = await updateUserBalance(userId, amount, isPlayMode);

      if (!result) {
        return NextResponse.json(
          { error: "更新余额失败" },
          { status: 500 }
        );
      }

      return NextResponse.json({
        balance: result.balance,
        playBalance: result.playBalance,
      });
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
