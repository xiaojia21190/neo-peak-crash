/**
 * Linux DO Credit 支付回调处理
 * 接收支付成功通知
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySign, type NotifyParams } from "@/lib/payment/ldc";

// 简单的内存存储（生产环境应使用数据库）
// 这里用于演示，实际应该持久化到数据库
const paymentRecords = new Map<string, {
  userId: string;
  amount: number;
  status: string;
  paidAt?: Date;
}>();

export async function GET(request: NextRequest) {
  return handleNotify(request);
}

export async function POST(request: NextRequest) {
  return handleNotify(request);
}

async function handleNotify(request: NextRequest) {
  try {
    // 获取参数（支持 GET 和 POST）
    let params: Record<string, string> = {};

    if (request.method === "GET") {
      const searchParams = request.nextUrl.searchParams;
      searchParams.forEach((value, key) => {
        params[key] = value;
      });
    } else {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        params[key] = String(value);
      });
    }

    console.log("收到支付回调:", JSON.stringify(params, null, 2));

    // 验证必要参数
    const { trade_no, out_trade_no, trade_status, money, sign } = params;

    if (!trade_no || !out_trade_no || !trade_status || !sign) {
      console.error("缺少必要参数");
      return new NextResponse("fail", { status: 400 });
    }

    // 验证签名
    const secret = process.env.LDC_CLIENT_SECRET;
    if (!secret) {
      console.error("LDC_CLIENT_SECRET 未配置");
      return new NextResponse("fail", { status: 500 });
    }

    const isValid = verifySign(params, secret);
    if (!isValid) {
      console.error("签名验证失败");
      return new NextResponse("fail", { status: 400 });
    }

    // 处理支付成功
    if (trade_status === "TRADE_SUCCESS") {
      console.log(`支付成功: 订单号=${out_trade_no}, 金额=${money}`);

      // 解析订单号获取用户ID
      // 订单号格式: GAME_{userId}_{timestamp}_{random}
      const parts = out_trade_no.split("_");
      if (parts.length >= 2 && parts[0] === "GAME") {
        const userId = parts[1];
        const amount = parseFloat(money);

        // 记录支付（实际应该更新数据库中的用户余额）
        paymentRecords.set(out_trade_no, {
          userId,
          amount,
          status: "paid",
          paidAt: new Date(),
        });

        console.log(`用户 ${userId} 充值 ${amount} LDC 成功`);
      }
    }

    // 返回 success 表示处理成功
    return new NextResponse("success");
  } catch (error) {
    console.error("处理支付回调失败:", error);
    return new NextResponse("fail", { status: 500 });
  }
}

// 导出支付记录查询（供其他模块使用）
export function getPaymentRecord(tradeNo: string) {
  return paymentRecords.get(tradeNo);
}
