/**
 * 资金流水账本服务
 * 记录所有资金变动，支持审计和对账
 */

import type { PrismaClient, Prisma } from '@prisma/client';

export type LedgerEntryType = 'DEPOSIT' | 'BET' | 'WIN' | 'REFUND';

export interface CreateLedgerEntryParams {
  userId: string;
  type: LedgerEntryType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  relatedBetId?: string;
  relatedTransactionId?: string;
  remark?: string;
}

/**
 * 创建资金流水记录
 */
export async function createLedgerEntry(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: CreateLedgerEntryParams
): Promise<void> {
  const {
    userId,
    type,
    amount,
    balanceBefore,
    balanceAfter,
    relatedBetId,
    relatedTransactionId,
    remark,
  } = params;

  // 验证余额计算正确性
  const expectedBalance = balanceBefore + amount;
  const diff = Math.abs(expectedBalance - balanceAfter);
  if (diff > 0.01) {
    console.warn(
      `[Ledger] Balance mismatch: ${balanceBefore} + ${amount} = ${expectedBalance}, but got ${balanceAfter}`
    );
  }

  // 创建流水记录（使用 Transaction 表的扩展字段）
  await (prisma as any).transaction.create({
    data: {
      userId,
      type: mapLedgerTypeToTransactionType(type),
      amount,
      status: 'COMPLETED',
      remark: remark || buildRemark(type, relatedBetId, balanceBefore, balanceAfter),
      completedAt: new Date(),
    },
  });
}

/**
 * 映射流水类型到 Transaction 枚举
 */
function mapLedgerTypeToTransactionType(type: LedgerEntryType): string {
  switch (type) {
    case 'DEPOSIT':
      return 'RECHARGE';
    case 'BET':
      return 'BET_LOSE'; // 下注时扣款，记为 BET_LOSE
    case 'WIN':
      return 'BET_WIN';
    case 'REFUND':
      return 'RECHARGE'; // 退款记为充值
    default:
      return 'RECHARGE';
  }
}

/**
 * 构建流水备注
 */
function buildRemark(
  type: LedgerEntryType,
  relatedBetId?: string,
  balanceBefore?: number,
  balanceAfter?: number
): string {
  const parts: string[] = [];

  switch (type) {
    case 'DEPOSIT':
      parts.push('充值');
      break;
    case 'BET':
      parts.push('下注扣款');
      if (relatedBetId) parts.push(`betId:${relatedBetId}`);
      break;
    case 'WIN':
      parts.push('投注赢钱');
      if (relatedBetId) parts.push(`betId:${relatedBetId}`);
      break;
    case 'REFUND':
      parts.push('退款');
      if (relatedBetId) parts.push(`betId:${relatedBetId}`);
      break;
  }

  if (balanceBefore !== undefined && balanceAfter !== undefined) {
    parts.push(`${balanceBefore.toFixed(2)} → ${balanceAfter.toFixed(2)}`);
  }

  return parts.join(' | ');
}

/**
 * 查询用户流水
 */
export async function getUserLedger(
  prisma: PrismaClient,
  userId: string,
  options?: {
    type?: LedgerEntryType;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }
): Promise<any[]> {
  const where: any = { userId };

  if (options?.type) {
    where.type = mapLedgerTypeToTransactionType(options.type);
  }

  if (options?.startDate || options?.endDate) {
    where.createdAt = {};
    if (options.startDate) where.createdAt.gte = options.startDate;
    if (options.endDate) where.createdAt.lte = options.endDate;
  }

  return (prisma as any).transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: options?.limit || 100,
  });
}
