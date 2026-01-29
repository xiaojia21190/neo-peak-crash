/**
 * Linux DO Credit 支付回调处理
 * 接收支付成功通知
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySign } from "@/lib/payment/ldc";
import prisma from "@/lib/prisma";
import { FinancialService } from "@/lib/services/financial";
import { sanitizeLogParams, maskMiddle } from "@/lib/utils/logSanitizer";

const financialService = new FinancialService(prisma);

export async function GET(request: NextRequest) {
  return handleNotify(request);
}

export async function POST(request: NextRequest) {
  return handleNotify(request);
}

async function handleNotify(request: NextRequest) {
  try {
    const allowedIpsEnv = process.env.LDC_ALLOWED_IPS;
    const allowedIps = allowedIpsEnv
      ? allowedIpsEnv
          .split(",")
          .map((ip) => ip.trim())
          .filter(Boolean)
      : [];

    if (allowedIps.length > 0) {
      const forwardedFor = request.headers.get("x-forwarded-for");
      const candidate =
        forwardedFor?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip")?.trim() ||
        request.headers.get("cf-connecting-ip")?.trim() ||
        null;

      if (!candidate || !allowedIps.includes(candidate)) {
        console.error(`Unauthorized IP: ${candidate ?? "unknown"}`);
        return new NextResponse("fail", { status: 403 });
      }
    }

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

    const logParams = sanitizeLogParams(params);

    console.log("收到支付回调:", JSON.stringify(logParams, null, 2));

    // 验证必要参数
    const { trade_no, out_trade_no, trade_status, money, sign, pid } = params;

    if (!trade_no || !out_trade_no || !trade_status || !sign) {
      console.error("缺少必要参数");
      return new NextResponse("fail", { status: 400 });
    }

    // 验证签名
    const secret = process.env.LDC_CLIENT_SECRET;
    const configPid = process.env.LDC_CLIENT_ID;

    if (!secret || !configPid) {
      console.error("LDC 配置未设置");
      return new NextResponse("fail", { status: 500 });
    }

    // 验证 pid 匹配
    if (pid && pid !== configPid) {
      console.error("PID 不匹配");
      return new NextResponse("fail", { status: 400 });
    }

    const isValid = verifySign(params, secret);
    if (!isValid) {
      console.error("签名验证失败");
      return new NextResponse("fail", { status: 400 });
    }

    // 处理支付成功
    if (trade_status === "TRADE_SUCCESS") {
      console.log(`支付成功: 订单号=${maskMiddle(out_trade_no)}, 金额=${money}`);

      const amount = parseFloat(money);
      if (!Number.isFinite(amount) || amount <= 0) {
        console.error("无效的金额:", money);
        return new NextResponse("fail", { status: 400 });
      }

      // 金额交叉验证：从数据库读取 PENDING 订单原始金额，避免回调金额被篡改
      const toCents = (value: number) => Math.round((value + Number.EPSILON) * 100);
      const pendingOrder = await prisma.transaction.findFirst({
        where: {
          orderNo: out_trade_no,
          status: "PENDING",
          type: "RECHARGE",
        },
        select: { amount: true },
      });

      if (pendingOrder) {
        const expectedAmount = Number(pendingOrder.amount);
        if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
          console.error(`订单金额异常: 订单号=${maskMiddle(out_trade_no)}, amount=${pendingOrder.amount}`);
          return new NextResponse("fail", { status: 400 });
        }

        if (toCents(expectedAmount) !== toCents(amount)) {
          console.error(
            `回调金额不匹配: 订单号=${maskMiddle(out_trade_no)}, expected=${expectedAmount}, actual=${amount}`
          );
          return new NextResponse("fail", { status: 400 });
        }
      }

      try {
        const result = await financialService.completeRechargeOrder({
          orderNo: out_trade_no,
          tradeNo: trade_no,
          amount,
        });

        if (!result.processed) {
          console.log(`订单 ${maskMiddle(out_trade_no)} 已处理，幂等跳过`);
        } else {
          console.log(`订单 ${maskMiddle(out_trade_no)} 充值成功: ${result.balanceBefore} -> ${result.balanceAfter}`);
        }
      } catch (dbError) {
        console.error("数据库操作失败:", dbError);
        return new NextResponse("fail", { status: 500 });
      }
    }

    // 返回 success 表示处理成功
    return new NextResponse("success");
  } catch (error) {
    console.error("处理支付回调失败:", error);
    return new NextResponse("fail", { status: 500 });
  }
}
