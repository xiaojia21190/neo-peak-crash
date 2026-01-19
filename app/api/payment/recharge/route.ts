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
    const baseUrl = process.env.NEXTAUTH_URL;
    if (!baseUrl) {
      return NextResponse.json(
        { success: false, error: 'NEXTAUTH_URL is not configured' },
        { status: 500 }
      );
    }
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

    // 从支付表单参数中获取订单号
    const orderNo = result.paymentForm?.params.out_trade_no;

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
        balanceBefore: 0, // 充值订单创建时暂不知道余额，回调时更新
        balanceAfter: 0,
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
