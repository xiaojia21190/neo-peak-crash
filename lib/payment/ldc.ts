/**
 * Linux DO Credit 支付集成
 * 基于 EasyPay 兼容协议
 * 文档: https://credit.linux.do
 */

import crypto from "crypto";

/**
 * 获取 API 端点 URL
 */
function getApiUrl(): string {
  const proxyUrl = process.env.LDC_PROXY_URL;
  if (proxyUrl) {
    return proxyUrl.replace(/\/+$/, "");
  }

  let gateway = process.env.LDC_GATEWAY || "https://credit.linux.do/epay";
  gateway = gateway.replace(/\/+$/, "");
  if (!gateway.includes("/epay")) {
    gateway = gateway + "/epay";
  }
  return `${gateway}/api.php`;
}

/**
 * 获取支付网关 URL
 */
function getGatewayUrl(): string {
  let gateway = process.env.LDC_GATEWAY || "https://credit.linux.do/epay";
  gateway = gateway.replace(/\/+$/, "");
  if (!gateway.includes("/epay")) {
    gateway = gateway + "/epay";
  }
  return gateway;
}

interface PaymentParams {
  pid: string;
  type: string;
  out_trade_no: string;
  name: string;
  money: string;
  notify_url?: string;
  return_url?: string;
  device?: string;
}

/**
 * 生成签名
 * 按照 EasyPay 协议：参数按 ASCII 排序后拼接，MD5(拼接字符串 + key)
 */
export function generateSign(params: Record<string, string>, secret: string): string {
  // 过滤空值和 sign/sign_type 参数
  const filtered = Object.entries(params)
    .filter(([key, value]) => value !== "" && key !== "sign" && key !== "sign_type")
    .sort(([a], [b]) => a.localeCompare(b));

  // 拼接参数
  const queryString = filtered.map(([key, value]) => `${key}=${value}`).join("&");

  // MD5 签名
  return crypto.createHash("md5").update(queryString + secret).digest("hex");
}

/**
 * 验证回调签名
 */
export function verifySign(params: Record<string, string>, secret: string): boolean {
  const receivedSign = params.sign;
  if (!receivedSign) return false;

  const calculatedSign = generateSign(params, secret);
  return receivedSign.toLowerCase() === calculatedSign.toLowerCase();
}

export interface NotifyParams {
  pid: string;
  trade_no: string;
  out_trade_no: string;
  type: string;
  name: string;
  money: string;
  trade_status: string;
  sign: string;
  sign_type: string;
}

export interface CreatePaymentResult {
  success: boolean;
  paymentUrl?: string;
  paymentForm?: {
    actionUrl: string;
    params: Record<string, string>;
  };
  error?: string;
}

/**
 * 创建支付订单
 * 返回支付表单参数，由前端提交跳转
 */
export function createPayment(
  tradeNo: string,
  amount: number,
  productName: string,
  notifyUrl: string,
  returnUrl: string
): CreatePaymentResult {
  const pid = process.env.LDC_CLIENT_ID;
  const secret = process.env.LDC_CLIENT_SECRET;

  if (!pid || !secret) {
    return {
      success: false,
      error: "支付配置未设置：请在 .env 文件中配置 LDC_CLIENT_ID 和 LDC_CLIENT_SECRET",
    };
  }

  const gateway = getGatewayUrl();

  const params: PaymentParams = {
    pid,
    type: "ldc", // LDC 积分支付
    out_trade_no: tradeNo,
    name: productName,
    money: amount.toFixed(2),
    notify_url: notifyUrl,
    return_url: returnUrl,
    device: "pc",
  };

  // 生成签名
  const sign = generateSign(params as unknown as Record<string, string>, secret);

  return {
    success: true,
    paymentForm: {
      actionUrl: `${gateway}/submit.php`,
      params: {
        ...params,
        sign,
        sign_type: "MD5",
      } as unknown as Record<string, string>,
    },
  };
}

export interface OrderQueryResult {
  success: boolean;
  status?: "TRADE_SUCCESS" | "TRADE_CLOSED" | "WAIT_BUYER_PAY";
  tradeNo?: string;
  money?: string;
  error?: string;
}

/**
 * 查询订单状态
 */
export async function queryPaymentOrder(
  tradeNo: string
): Promise<OrderQueryResult> {
  const pid = process.env.LDC_CLIENT_ID;
  const secret = process.env.LDC_CLIENT_SECRET;

  if (!pid || !secret) {
    return { success: false, error: "支付配置未设置" };
  }

  const apiUrl = getApiUrl();
  const params = new URLSearchParams({
    act: "order",
    pid,
    key: secret,
    trade_no: tradeNo,
  });

  const url = `${apiUrl}?${params}`;
  console.log("LDC 订单查询请求:", url.replace(secret, "***"));

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const text = await response.text();

    try {
      const result = JSON.parse(text);

      if (result.code === 1 || result.status === 1) {
        return {
          success: true,
          status: result.trade_status || "TRADE_SUCCESS",
          tradeNo: result.trade_no,
          money: result.money,
        };
      }

      return {
        success: false,
        error: result.msg || "查询失败",
      };
    } catch {
      return {
        success: false,
        error: "解析响应失败",
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `网络请求失败: ${error}`,
    };
  }
}

/**
 * 获取用户 LDC 余额
 * 注意：这需要用户授权，通常通过 OAuth 获取
 */
export async function getUserBalance(userId: string): Promise<{
  success: boolean;
  balance?: number;
  error?: string;
}> {
  // LDC 目前没有直接查询用户余额的 API
  // 余额信息通常在支付时由 LDC 平台验证
  // 这里返回一个占位实现
  return {
    success: true,
    balance: 0, // 实际余额需要用户在 LDC 平台查看
  };
}

/**
 * 生成充值链接
 * 跳转到 LDC 平台进行充值
 */
export function getRechargeUrl(): string {
  return "https://credit.linux.do";
}

/**
 * 生成游戏内充值订单
 */
export function createGameRechargeOrder(
  userId: string,
  amount: number,
  notifyUrl: string,
  returnUrl: string
): CreatePaymentResult {
  const tradeNo = `GAME_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  return createPayment(
    tradeNo,
    amount,
    "Neon Peak Crash 游戏充值",
    notifyUrl,
    returnUrl
  );
}
