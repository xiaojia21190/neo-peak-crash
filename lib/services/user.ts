/**
 * 用户服务 - 处理用户相关的数据库操作
 */

import prisma from "@/lib/prisma";
import { FinancialService } from "./financial";

// 创建财务服务单例
const financialService = new FinancialService(prisma);

export interface UserData {
  id: string;
  username: string;
  name?: string | null;
  avatar?: string | null;
  trustLevel: number;
  balance: number;
  playBalance: number;
  totalWins: number;
  totalLosses: number;
  totalBets: number;
  totalProfit: number;
}

/**
 * 获取或创建用户
 */
export async function getOrCreateUser(userData: {
  id: string;
  username: string;
  name?: string;
  avatar?: string;
  trustLevel?: number;
  active?: boolean;
  silenced?: boolean;
}): Promise<UserData> {
  const user = await prisma.user.upsert({
    where: { id: userData.id },
    update: {
      username: userData.username,
      name: userData.name,
      avatar: userData.avatar,
      trustLevel: userData.trustLevel ?? 0,
      active: userData.active ?? true,
      silenced: userData.silenced ?? false,
      lastLoginAt: new Date(),
    },
    create: {
      id: userData.id,
      username: userData.username,
      name: userData.name,
      avatar: userData.avatar,
      trustLevel: userData.trustLevel ?? 0,
      active: userData.active ?? true,
      silenced: userData.silenced ?? false,
      balance: 0,
      playBalance: 10000, // 初始游戏余额
    },
  });

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    trustLevel: user.trustLevel,
    balance: Number(user.balance),
    playBalance: Number(user.playBalance),
    totalWins: user.totalWins,
    totalLosses: user.totalLosses,
    totalBets: user.totalBets,
    totalProfit: Number(user.totalProfit),
  };
}

/**
 * 获取用户余额
 */
export async function getUserBalance(userId: string): Promise<{
  balance: number;
  playBalance: number;
} | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { balance: true, playBalance: true },
  });

  if (!user) return null;

  return {
    balance: Number(user.balance),
    playBalance: Number(user.playBalance),
  };
}

/**
 * 原子性余额变动操作，自动记录流水
 *
 * 现已委托给 FinancialService 处理，这里保留为兼容层
 * 新代码应直接使用 FinancialService
 */
export async function updateUserBalanceWithLedger(params: {
  userId: string;
  amount: number;
  type: "RECHARGE" | "WITHDRAW" | "BET" | "WIN" | "REFUND";
  relatedBetId?: string;
  remark?: string;
  orderNo?: string;
  tradeNo?: string;
}): Promise<{ balanceBefore: number; balanceAfter: number }> {
  // 委托给 FinancialService 处理
  const result = await financialService.changeBalance({
    userId: params.userId,
    amount: params.amount,
    type: params.type,
    isPlayMode: false, // 此函数只处理真实余额
    relatedBetId: params.relatedBetId,
    remark: params.remark,
    orderNo: params.orderNo,
    tradeNo: params.tradeNo,
  });

  return {
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
  };
}

/**
 * 更新用户余额（旧版本，保留兼容性）
 * @deprecated 使用 updateUserBalanceWithLedger 代替
 */
export async function updateUserBalance(
  userId: string,
  amount: number,
  isPlayMode: boolean
): Promise<{ balance: number; playBalance: number } | null> {
  const field = isPlayMode ? "playBalance" : "balance";

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      [field]: {
        increment: amount,
      },
    },
    select: { balance: true, playBalance: true },
  });

  return {
    balance: Number(user.balance),
    playBalance: Number(user.playBalance),
  };
}

/**
 * 重置游戏模式余额
 */
export async function resetPlayBalance(userId: string): Promise<number> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      playBalance: 10000,
    },
    select: { playBalance: true },
  });

  return Number(user.playBalance);
}

/**
 * 记录投注
 */
export async function recordBet(data: {
  userId: string;
  amount: number;
  multiplier: number;
  rowIndex: number;
  colIndex: number;
  asset: string;
  isPlayMode: boolean;
}): Promise<string> {
  const bet = await prisma.bet.create({
    data: {
      userId: data.userId,
      amount: data.amount,
      multiplier: data.multiplier,
      rowIndex: data.rowIndex,
      colIndex: data.colIndex,
      asset: data.asset,
      isPlayMode: data.isPlayMode,
    },
  });

  return bet.id;
}

/**
 * 获取投注记录（含所有权验证）
 */
export async function getBetById(betId: string, userId: string) {
  return prisma.bet.findFirst({
    where: { id: betId, userId },
    select: {
      id: true,
      userId: true,
      amount: true,
      multiplier: true,
      isPlayMode: true,
      settledAt: true,
    },
  });
}

/**
 * 结算投注（带所有权验证）
 * 返回投注记录用于后续处理
 */
export async function settleBetSecure(
  betId: string,
  userId: string,
  isWin: boolean
): Promise<{
  success: boolean;
  bet?: {
    amount: number;
    multiplier: number;
    isPlayMode: boolean;
    payout: number;
  };
  error?: string;
}> {
  // 查找投注并验证所有权
  const bet = await prisma.bet.findFirst({
    where: { id: betId, userId },
  });

  if (!bet) {
    return { success: false, error: "投注记录不存在或无权访问" };
  }

  if (bet.settledAt) {
    return { success: false, error: "投注已结算" };
  }

  // 服务端计算 payout，不信任客户端
  const payout = isWin ? Number(bet.amount) * Number(bet.multiplier) : 0;

  // 更新投注记录
  await prisma.bet.update({
    where: { id: betId },
    data: {
      isWin,
      payout,
      settledAt: new Date(),
    },
  });

  return {
    success: true,
    bet: {
      amount: Number(bet.amount),
      multiplier: Number(bet.multiplier),
      isPlayMode: bet.isPlayMode,
      payout,
    },
  };
}

/**
 * 结算投注（旧版本，保留兼容性）
 * @deprecated 使用 settleBetSecure 代替
 */
export async function settleBet(
  betId: string,
  isWin: boolean,
  payout: number
): Promise<void> {
  await prisma.bet.update({
    where: { id: betId },
    data: {
      isWin,
      payout: payout,
      settledAt: new Date(),
    },
  });
}

/**
 * 更新用户统计
 */
export async function updateUserStats(
  userId: string,
  isWin: boolean,
  profitAmount: number
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      totalBets: { increment: 1 },
      totalWins: isWin ? { increment: 1 } : undefined,
      totalLosses: !isWin ? { increment: 1 } : undefined,
      totalProfit: { increment: profitAmount },
    },
  });
}

interface BetRecord {
  id: string;
  amount: { toNumber?: () => number } | number;
  multiplier: { toNumber?: () => number } | number;
  isWin: boolean;
  payout: { toNumber?: () => number } | number;
  asset: string;
  isPlayMode: boolean;
  createdAt: Date;
}

/**
 * 获取用户投注历史
 */
export async function getUserBetHistory(
  userId: string,
  limit: number = 50
): Promise<Array<{
  id: string;
  amount: number;
  multiplier: number;
  isWin: boolean;
  payout: number;
  asset: string;
  isPlayMode: boolean;
  createdAt: Date;
}>> {
  const bets = await prisma.bet.findMany({
    where: { userId, settledAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      amount: true,
      multiplier: true,
      isWin: true,
      payout: true,
      asset: true,
      isPlayMode: true,
      createdAt: true,
    },
  });

  return bets.map((bet: BetRecord) => ({
    id: bet.id,
    amount: Number(bet.amount),
    multiplier: Number(bet.multiplier),
    isWin: bet.isWin,
    payout: Number(bet.payout),
    asset: bet.asset,
    isPlayMode: bet.isPlayMode,
    createdAt: bet.createdAt,
  }));
}

/**
 * 充值 - 增加用户余额
 */
export async function rechargeBalance(
  userId: string,
  amount: number,
  orderNo: string,
  tradeNo?: string
): Promise<number> {
  const { balanceAfter } = await updateUserBalanceWithLedger({
    userId,
    amount,
    type: "RECHARGE",
    orderNo,
    tradeNo,
  });
  return balanceAfter;
}
