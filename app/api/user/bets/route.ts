/**
 * 投注 API
 * POST - 创建投注
 * PUT - 结算投注
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  recordBet,
  settleBetSecure,
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

// 创建投注 - 已禁用，投注由 WebSocket GameEngine 处理
export async function POST(request: NextRequest) {
  return NextResponse.json(
    { error: "此 API 已禁用。请通过 WebSocket 连接使用 GameEngine.placeBet() 下注。" },
    { status: 403 }
  );
}

/* 原实现已禁用 - 会导致扣款但引擎不结算
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

    // 使用事务原子性地扣除余额并创建投注
    const betId = await prisma.$transaction(async (tx) => {
      const balanceField = isPlayMode ? "playBalance" : "balance";

      // 原子条件更新：仅在余额充足时扣款
      const updateResult = await tx.user.updateMany({
        where: {
          id: userId,
          [balanceField]: { gte: amount },
        },
        data: {
          [balanceField]: { decrement: amount },
        },
      });

      if (updateResult.count === 0) {
        throw new Error("余额不足");
      }

      // 创建投注记录
      const bet = await tx.bet.create({
        data: {
          userId,
          amount,
          multiplier,
          rowIndex,
          colIndex,
          asset: asset || "BTCUSDT",
          roundHash,
          isPlayMode: isPlayMode ?? false,
        },
      });

      return bet.id;
    });

    return NextResponse.json({
      betId,
      message: "投注成功",
    });
  } catch (error) {
    console.error("创建投注失败:", error);

    // 区分余额不足和其他错误
    const errorMessage = error instanceof Error && error.message === "余额不足"
      ? "余额不足"
      : "创建投注失败";

    return NextResponse.json(
      { error: errorMessage },
      { status: error instanceof Error && error.message === "余额不足" ? 400 : 500 }
    );
  }
}
*/

// 结算投注 - 已禁用，投注结算由服务端游戏引擎自动处理
// 此端点存在严重安全风险，客户端不应控制投注结果
export async function PUT(request: NextRequest) {
  return NextResponse.json(
    { error: "此 API 已禁用。投注结算由服务端游戏引擎自动处理。" },
    { status: 403 }
  );
}

/* 原实现已禁用 - 存在安全漏洞
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
    const { betId, isWin } = body;

    // 验证参数
    if (!betId) {
      return NextResponse.json(
        { error: "缺少 betId" },
        { status: 400 }
      );
    }

    if (typeof isWin !== "boolean") {
      return NextResponse.json(
        { error: "缺少 isWin 参数" },
        { status: 400 }
      );
    }

    // 使用安全的结算方法（验证所有权 + 服务端计算 payout）
    const result = await settleBetSecure(betId, userId, isWin);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      );
    }

    const bet = result.bet!;

    // 如果赢了，增加余额（使用服务端计算的 payout）
    if (isWin && bet.payout > 0) {
      await updateUserBalance(userId, bet.payout, bet.isPlayMode);
    }

    // 更新用户统计（净利润：赢时 payout - amount，输时 -amount）
    const profitAmount = isWin ? bet.payout - bet.amount : -bet.amount;
    await updateUserStats(userId, isWin, profitAmount);

    // 获取最新余额
    const balance = await getUserBalance(userId);

    return NextResponse.json({
      message: isWin ? "恭喜中奖！" : "未中奖",
      payout: bet.payout,
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
*/
