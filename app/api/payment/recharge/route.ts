/**
 * 创建充值订单 API
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createGameRechargeOrder } from "@/lib/payment/ldc";
import prisma from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    // 验证登录状态
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "请先登录" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { amount: rawAmount } = body;

    // 验证金额 - 确保是有效的数字
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
      return NextResponse.json(
        { success: false, error: "充值金额无效（1-10000）" },
        { status: 400 }
      );
    }

    // 获取回调地址
    const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
    const notifyUrl = `${baseUrl}/api/payment/notify`;
    const returnUrl = `${baseUrl}/?recharge=success`;

    // 创建支付订单（获取订单号）
    const result = createGameRechargeOrder(
      session.user.id,
      amount,
      notifyUrl,
      returnUrl
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    // 从支付表单中提取订单号
    const orderNoMatch = result.paymentForm?.match(/name="out_trade_no"\s+value="([^"]+)"/);
    const orderNo = orderNoMatch ? orderNoMatch[1] : null;

    if (!orderNo) {
      return NextResponse.json(
        { success: false, error: "无法获取订单号" },
        { status: 500 }
      );
    }

    // 预先创建 PENDING 状态的交易记录
    await prisma.transaction.create({
      data: {
        userId: session.user.id,
        type: "RECHARGE",
        amount,
        status: "PENDING",
        orderNo,
      },
    });

    return NextResponse.json({
      success: true,
      paymentForm: result.paymentForm,
    });
  } catch (error) {
    console.error("创建充值订单失败:", error);
    return NextResponse.json(
      { success: false, error: "服务器错误" },
      { status: 500 }
    );
  }
}
