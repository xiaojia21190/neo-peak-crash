/**
 * 创建充值订单 API
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createGameRechargeOrder } from "@/lib/payment/ldc";

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
    const { amount } = body;

    // 验证金额
    if (!amount || amount < 1 || amount > 10000) {
      return NextResponse.json(
        { success: false, error: "充值金额无效（1-10000）" },
        { status: 400 }
      );
    }

    // 获取回调地址
    const baseUrl = process.env.NEXTAUTH_URL || request.nextUrl.origin;
    const notifyUrl = `${baseUrl}/api/payment/notify`;
    const returnUrl = `${baseUrl}/?recharge=success`;

    // 创建支付订单
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
