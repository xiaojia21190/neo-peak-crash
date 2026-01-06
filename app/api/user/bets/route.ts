/**
 * 投注 API
 * POST - 创建投注
 * PUT - 结算投注
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  recordBet,
  settleBet,
  updateUserStats,
  updateUserBalance,
  getUserBalance,
  getUserBetHistory,
} from "@/lib/services/user";

// 获取投注历史
export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401 }
      );
    }

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

// 创建投注
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
    const { amount, multiplier, rowIndex, colIndex, asset, roundHash, isPlayMode } = body;

    // 验证参数
    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json(
        { error: "无效的投注金额" },
        { status: 400 }
      );
    }

    if (typeof multiplier !== "number" || multiplier <= 0) {
      return NextResponse.json(
        { error: "无效的倍率" },
        { status: 400 }
      );
    }

    // 检查余额
    const balance = await getUserBalance(userId);
    if (!balance) {
      return NextResponse.json(
        { error: "用户不存在" },
        { status: 404 }
      );
    }

    const currentBalance = isPlayMode ? balance.playBalance : balance.balance;
    if (currentBalance < amount) {
      return NextResponse.json(
        { error: "余额不足" },
        { status: 400 }
      );
    }

    // 扣除投注金额
    await updateUserBalance(userId, -amount, isPlayMode);

    // 记录投注
    const betId = await recordBet({
      userId,
      amount,
      multiplier,
      rowIndex,
      colIndex,
      asset: asset || "BTCUSDT",
      roundHash,
      isPlayMode: isPlayMode ?? false,
    });

    return NextResponse.json({
      betId,
      message: "投注成功",
    });
  } catch (error) {
    console.error("创建投注失败:", error);
    return NextResponse.json(
      { error: "创建投注失败" },
      { status: 500 }
    );
  }
}

// 结算投注
export async function PUT(request: NextRequest) {
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
    const { betId, isWin, payout, isPlayMode } = body;

    // 验证参数
    if (!betId) {
      return NextResponse.json(
        { error: "缺少 betId" },
        { status: 400 }
      );
    }

    // 结算投注
    await settleBet(betId, isWin, payout || 0);

    // 如果赢了，增加余额
    if (isWin && payout > 0) {
      await updateUserBalance(userId, payout, isPlayMode);
    }

    // 更新用户统计（计算盈亏）
    const profitAmount = isWin ? payout : 0;
    await updateUserStats(userId, isWin, profitAmount);

    // 获取最新余额
    const balance = await getUserBalance(userId);

    return NextResponse.json({
      message: isWin ? "恭喜中奖！" : "未中奖",
      balance: balance?.balance ?? 0,
      playBalance: balance?.playBalance ?? 0,
    });
  } catch (error) {
    console.error("结算投注失败:", error);
    return NextResponse.json(
      { error: "结算投注失败" },
      { status: 500 }
    );
  }
}
