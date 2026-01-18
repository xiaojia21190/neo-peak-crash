/**
 * Linux DO Credit 支付回调处理
 * 接收支付成功通知
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySign } from "@/lib/payment/ldc";
import prisma from "@/lib/prisma";

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
      console.log(`支付成功: 订单号=${out_trade_no}, 金额=${money}`);

      const amount = parseFloat(money);
      if (!Number.isFinite(amount) || amount <= 0) {
        console.error("无效的金额:", money);
        return new NextResponse("fail", { status: 400 });
      }

      // 使用事务确保幂等性和数据一致性
      try {
        await prisma.$transaction(async (tx) => {
          // 加载预创建的订单
          const existingTransaction = await tx.transaction.findUnique({
            where: { orderNo: out_trade_no },
          });

          if (!existingTransaction) {
            console.error(`订单 ${out_trade_no} 不存在，拒绝充值`);
            throw new Error("订单不存在");
          }

          // 幂等性检查：如果已完成，跳过
          if (existingTransaction.status === "COMPLETED") {
            console.log(`订单 ${out_trade_no} 已处理，跳过`);
            return;
          }

          // 验证订单金额是否匹配
          if (Number(existingTransaction.amount) !== amount) {
            console.error(`订单 ${out_trade_no} 金额不匹配: 预期=${existingTransaction.amount}, 实际=${amount}`);
            throw new Error("订单金额不匹配");
          }

          // 验证用户存在
          const user = await tx.user.findUnique({
            where: { id: existingTransaction.userId },
          });

          if (!user) {
            console.error(`用户 ${existingTransaction.userId} 不存在`);
            throw new Error("用户不存在");
          }

          // 更新订单状态为已完成
          await tx.transaction.update({
            where: { orderNo: out_trade_no },
            data: {
              status: "COMPLETED",
              tradeNo: trade_no,
              completedAt: new Date(),
            },
          });

          // 更新用户余额
          await tx.user.update({
            where: { id: existingTransaction.userId },
            data: {
              balance: { increment: amount },
            },
          });

          console.log(`用户 ${existingTransaction.userId} 充值 ${amount} LDC 成功`);
        });
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
