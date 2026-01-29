/**
 * 创建充值订单 API
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createGameRechargeOrder } from "@/lib/payment/ldc";
import prisma from "@/lib/prisma";
import { getRedisClient } from "@/lib/redis";
import { allowSlidingWindowRequest } from "@/lib/services/rateLimit";
import { validateSameOrigin } from "@/lib/utils/csrf";

// 充值频率限制配置（支持环境变量覆盖）
const RECHARGE_RATE_LIMIT_WINDOW_MS = parseInt(process.env.RECHARGE_RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const RECHARGE_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RECHARGE_RATE_LIMIT_MAX ?? '5', 10);
const DAILY_RECHARGE_LIMIT = parseInt(process.env.DAILY_RECHARGE_LIMIT ?? '50000', 10);

function buildRechargeRateLimitKey(userId: string): string {
  return `rate:recharge:${userId}`;
}

type RechargeDeps = {
  auth?: typeof auth;
  prismaClient?: typeof prisma;
  getRedisClient?: typeof getRedisClient;
  allowSlidingWindowRequest?: typeof allowSlidingWindowRequest;
  createGameRechargeOrder?: typeof createGameRechargeOrder;
  validateSameOrigin?: typeof validateSameOrigin;
};

export async function POST(request: NextRequest, deps: RechargeDeps = {}) {
  try {
    const validateOrigin = deps.validateSameOrigin ?? validateSameOrigin;
    if (!validateOrigin(request)) {
      return NextResponse.json(
        { success: false, error: "Forbidden: Cross-origin request" },
        { status: 403 }
      );
    }

    // 验证登录状态
    const authFn = deps.auth ?? auth;
    const session = await authFn();
    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "请先登录" },
        { status: 401 }
      );
    }

    const userId = session.user.id;
    const prismaClient = deps.prismaClient ?? prisma;

    // 检查用户状态（封禁用户无法充值）
    const userStatus = await prismaClient.user.findUnique({
      where: { id: userId },
      select: { active: true },
    });

    if (!userStatus) {
      return NextResponse.json(
        { success: false, error: "用户不存在" },
        { status: 404 }
      );
    }

    if (!userStatus.active) {
      return NextResponse.json(
        { success: false, error: "账号已被封禁，无法充值" },
        { status: 403 }
      );
    }

    // Rate limit 检查
    const redisClientFactory = deps.getRedisClient ?? getRedisClient;
    const redis = redisClientFactory();
    const allowRequest = deps.allowSlidingWindowRequest ?? allowSlidingWindowRequest;
    const allowed = await allowRequest({
      redis,
      key: buildRechargeRateLimitKey(userId),
      windowMs: RECHARGE_RATE_LIMIT_WINDOW_MS,
      maxRequests: RECHARGE_RATE_LIMIT_MAX_REQUESTS,
    });

    if (!allowed) {
      return NextResponse.json(
        { success: false, error: "充值请求过于频繁，请稍后再试" },
        { status: 429 }
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

    // 检查每日充值上限（预检查，事务中会再次验证）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayRechargeTotal = await prismaClient.transaction.aggregate({
      where: {
        userId,
        type: "RECHARGE",
        status: { in: ["PENDING", "COMPLETED"] },
        createdAt: { gte: todayStart },
      },
      _sum: { amount: true },
    });

    const currentTotal = Number(todayRechargeTotal._sum.amount ?? 0);
    if (currentTotal + amount > DAILY_RECHARGE_LIMIT) {
      return NextResponse.json(
        { success: false, error: `今日充值已达上限（${DAILY_RECHARGE_LIMIT}元）` },
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
    const createRechargeOrder = deps.createGameRechargeOrder ?? createGameRechargeOrder;
    const result = createRechargeOrder(
      userId,
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

    // 使用事务创建交易记录（原子操作防止竞态超限）
    try {
      await prismaClient.$transaction(async (tx) => {
        // 事务内再次检查每日上限
        const txTotal = await tx.transaction.aggregate({
          where: {
            userId,
            type: "RECHARGE",
            status: { in: ["PENDING", "COMPLETED"] },
            createdAt: { gte: todayStart },
          },
          _sum: { amount: true },
        });

        const txCurrentTotal = Number(txTotal._sum.amount ?? 0);
        if (txCurrentTotal + amount > DAILY_RECHARGE_LIMIT) {
          throw new Error('DAILY_LIMIT_EXCEEDED');
        }

        // 创建 PENDING 状态的交易记录
        await tx.transaction.create({
          data: {
            userId,
            type: "RECHARGE",
            amount,
            status: "PENDING",
            orderNo,
            balanceBefore: 0,
            balanceAfter: 0,
          },
        });
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === 'DAILY_LIMIT_EXCEEDED') {
        return NextResponse.json(
          { success: false, error: `今日充值已达上限（${DAILY_RECHARGE_LIMIT}元）` },
          { status: 400 }
        );
      }
      throw txError;
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
