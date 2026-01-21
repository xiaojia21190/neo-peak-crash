/**
 * Financial Service - Centralized ledger and balance operations
 *
 * This service is the SINGLE SOURCE OF TRUTH for all financial operations.
 * It consolidates ledger logic previously duplicated across GameEngine and user services.
 *
 * Architectural Decision:
 * - All balance changes MUST go through this service
 * - Automatic transaction logging for audit trail
 * - Balance validation and consistency checks
 * - Supports both real balance and play balance
 *
 * @module FinancialService
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { roundMoney } from '../shared/gameMath';

export type FinancialOperationType =
  | 'RECHARGE'   // User deposits funds
  | 'WITHDRAW'   // User withdraws funds
  | 'BET'        // Deduct bet amount
  | 'WIN'        // Credit winnings
  | 'REFUND';    // Refund bet amount

export interface BalanceChangeParams {
  userId: string;
  amount: number;
  type: FinancialOperationType;
  isPlayMode?: boolean;
  relatedBetId?: string;
  remark?: string;
  orderNo?: string;
  tradeNo?: string;
}

export interface BalanceChangeResult {
  balanceBefore: number;
  balanceAfter: number;
  transactionId?: string;
}

export interface BatchBalanceChangeParams {
  userId: string;
  changes: Array<{
    amount: number;
    type: FinancialOperationType;
    relatedBetId?: string;
    remark?: string;
  }>;
  isPlayMode?: boolean;
}

export interface BatchBalanceChangeResult {
  balanceBefore: number;
  balanceAfter: number;
  transactionIds: string[];
}

function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100) * Math.sign(amount);
}

function centsToNumber(cents: number): number {
  return cents / 100;
}

function isRecordNotFoundError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2025';
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code === 'P2025'
  );
}

/**
 * FinancialService - Handles all balance and ledger operations
 *
 * This class provides atomic financial operations with automatic transaction logging.
 * It ensures data consistency and provides a clear audit trail.
 */
export class FinancialService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Change user balance with automatic ledger recording
   *
   * This is the core method for all balance changes. It:
   * 1. Validates the operation
   * 2. Updates the balance atomically
   * 3. Records the transaction for audit
   * 4. Returns before/after balance
   *
   * @param params - Balance change parameters
   * @param tx - Optional Prisma transaction client (for nested transactions)
   * @returns Balance before and after the change
   */
  async changeBalance(
    params: BalanceChangeParams,
    tx?: Prisma.TransactionClient
  ): Promise<BalanceChangeResult> {
    const isPlayMode = params.isPlayMode ?? false;

    // Anonymous users only support play mode
    const isAnonymous = params.userId.startsWith('anon-');
    if (isAnonymous && !isPlayMode) {
      throw new Error('Anonymous users can only use play mode');
    }

    // For anonymous users in play mode, skip database operations
    if (isAnonymous && isPlayMode) {
      return { balanceBefore: 0, balanceAfter: 0 };
    }

    if (tx) {
      return this.changeBalanceInTx(params, tx);
    }

    return this.prisma.$transaction((innerTx) => this.changeBalanceInTx(params, innerTx));
  }

  private async changeBalanceInTx(
    params: BalanceChangeParams,
    tx: Prisma.TransactionClient
  ): Promise<BalanceChangeResult> {
    const isPlayMode = params.isPlayMode ?? false;
    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    const amount = roundMoney(params.amount);
    const amountCents = toCents(amount);
    const relatedBetId = normalizeOptionalString(params.relatedBetId);
    const remark = normalizeOptionalString(params.remark);
    const orderNo = normalizeOptionalString(params.orderNo);
    const tradeNo = normalizeOptionalString(params.tradeNo);

    // Single statement update (row-locked) + use resulting value to derive before/after.
    let updatedUser: any;
    try {
      updatedUser = await tx.user.update({
        where: { id: params.userId },
        data: { [balanceField]: { increment: amount } },
        select: { [balanceField]: true },
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new Error(`User ${params.userId} not found`);
      }
      throw error;
    }

    const balanceAfterCents = toCents(Number(updatedUser[balanceField]));
    const balanceBeforeCents = balanceAfterCents - amountCents;

    const balanceBefore = centsToNumber(balanceBeforeCents);
    const balanceAfter = centsToNumber(balanceAfterCents);

    // Record transaction (only for real balance, not play mode)
    let transactionId: string | undefined;
    if (!isPlayMode) {
      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          amount,
          balanceBefore,
          balanceAfter,
          relatedBetId,
          remark: remark || this.buildRemark(params.type, relatedBetId),
          orderNo,
          tradeNo,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      transactionId = transaction.id;
    }

    return { balanceBefore, balanceAfter, transactionId };
  }

  /**
   * Batch balance changes for the same user
   *
   * This optimizes multiple balance changes for a single user by:
   * 1. Fetching balance once
   * 2. Calculating cumulative change
   * 3. Single balance update
   * 4. Batch transaction records
   *
   * Used primarily for settlement operations where a user has multiple winning bets.
   *
   * @param params - Batch balance change parameters
   * @param tx - Optional Prisma transaction client
   * @returns Cumulative balance change result
   */
  async batchChangeBalance(
    params: BatchBalanceChangeParams,
    tx?: Prisma.TransactionClient
  ): Promise<BatchBalanceChangeResult> {
    const isPlayMode = params.isPlayMode ?? false;

    // Anonymous users in play mode skip database
    const isAnonymous = params.userId.startsWith('anon-');
    if (isAnonymous && isPlayMode) {
      return { balanceBefore: 0, balanceAfter: 0, transactionIds: [] };
    }
    if (isAnonymous && !isPlayMode) {
      throw new Error('Anonymous users can only use play mode');
    }

    if (tx) {
      return this.batchChangeBalanceInTx(params, tx);
    }

    return this.prisma.$transaction((innerTx) => this.batchChangeBalanceInTx(params, innerTx));
  }

  private async batchChangeBalanceInTx(
    params: BatchBalanceChangeParams,
    tx: Prisma.TransactionClient
  ): Promise<BatchBalanceChangeResult> {
    const isPlayMode = params.isPlayMode ?? false;
    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    const normalizedChanges = params.changes.map((change) => ({
      ...change,
      amount: roundMoney(change.amount),
      relatedBetId: normalizeOptionalString(change.relatedBetId),
      remark: normalizeOptionalString(change.remark),
    }));

    const totalChangeCents = normalizedChanges.reduce((sum, change) => sum + toCents(change.amount), 0);
    const totalChange = centsToNumber(totalChangeCents);

    let updatedUser: any;
    try {
      updatedUser = await tx.user.update({
        where: { id: params.userId },
        data: { [balanceField]: { increment: totalChange } },
        select: { [balanceField]: true },
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new Error(`User ${params.userId} not found`);
      }
      throw error;
    }

    const balanceAfterCents = toCents(Number(updatedUser[balanceField]));
    const balanceBeforeCents = balanceAfterCents - totalChangeCents;

    const balanceBefore = centsToNumber(balanceBeforeCents);
    const balanceAfter = centsToNumber(balanceAfterCents);

    // Record transactions (only for real balance)
    const transactionIds: string[] = [];
    if (!isPlayMode && normalizedChanges.length > 0) {
      let runningCents = balanceBeforeCents;
      const completedAt = new Date();

      for (const change of normalizedChanges) {
        const beforeCents = runningCents;
        const changeCents = toCents(change.amount);
        const afterCents = beforeCents + changeCents;
        runningCents = afterCents;

        const transaction = await tx.transaction.create({
          data: {
            userId: params.userId,
            type: change.type,
            amount: change.amount,
            balanceBefore: centsToNumber(beforeCents),
            balanceAfter: centsToNumber(afterCents),
            relatedBetId: change.relatedBetId,
            remark: change.remark || this.buildRemark(change.type, change.relatedBetId),
            status: 'COMPLETED',
            completedAt,
          },
        });
        transactionIds.push(transaction.id);
      }
    }

    return { balanceBefore, balanceAfter, transactionIds };
  }

  /**
   * Conditional balance change (e.g., deduct only if sufficient balance)
   *
   * This method uses updateMany to ensure atomic conditional updates.
   * It's commonly used for bet placement where we need to verify sufficient balance.
   *
   * @param params - Balance change parameters
   * @param tx - Optional Prisma transaction client
   * @returns Success status and balance info
   */
  async conditionalChangeBalance(
    params: BalanceChangeParams & { minBalance?: number },
    tx?: Prisma.TransactionClient
  ): Promise<{ success: boolean; result?: BalanceChangeResult; error?: string }> {
    const isPlayMode = params.isPlayMode ?? false;

    // Anonymous users in play mode always succeed
    const isAnonymous = params.userId.startsWith('anon-');
    if (isAnonymous && isPlayMode) {
      return { success: true, result: { balanceBefore: 0, balanceAfter: 0 } };
    }
    if (isAnonymous && !isPlayMode) {
      return { success: false, error: 'Anonymous users can only use play mode' };
    }

    const amount = roundMoney(params.amount);
    if (amount >= 0) {
      try {
        const result = tx
          ? await this.changeBalanceInTx({ ...params, amount }, tx)
          : await this.changeBalance({ ...params, amount });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message || 'Unknown error' };
      }
    }

    if (tx) {
      return this.conditionalChangeBalanceInTx({ ...params, amount }, tx);
    }
    return this.prisma.$transaction((innerTx) =>
      this.conditionalChangeBalanceInTx({ ...params, amount }, innerTx)
    );
  }

  private async conditionalChangeBalanceInTx(
    params: BalanceChangeParams & { minBalance?: number },
    tx: Prisma.TransactionClient
  ): Promise<{ success: boolean; result?: BalanceChangeResult; error?: string }> {
    const isPlayMode = params.isPlayMode ?? false;
    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    const amount = roundMoney(params.amount);
    const amountCents = toCents(amount);
    const requiredBalance = roundMoney(params.minBalance !== undefined ? params.minBalance : -amount);
    const relatedBetId = normalizeOptionalString(params.relatedBetId);
    const remark = normalizeOptionalString(params.remark);
    const orderNo = normalizeOptionalString(params.orderNo);
    const tradeNo = normalizeOptionalString(params.tradeNo);

    const updateResult = await tx.user.updateMany({
      where: { id: params.userId, [balanceField]: { gte: requiredBalance } },
      data: { [balanceField]: { increment: amount } },
    });

    if (updateResult.count !== 1) {
      const userExists = await tx.user.findUnique({ where: { id: params.userId }, select: { id: true } });
      if (!userExists) {
        return { success: false, error: 'User not found' };
      }
      return { success: false, error: 'Insufficient balance' };
    }

    const userAfter = await tx.user.findUnique({
      where: { id: params.userId },
      select: { [balanceField]: true },
    });
    if (!userAfter) {
      return { success: false, error: 'User not found' };
    }

    const balanceAfterCents = toCents(Number((userAfter as any)[balanceField]));
    const balanceBeforeCents = balanceAfterCents - amountCents;
    const balanceBefore = centsToNumber(balanceBeforeCents);
    const balanceAfter = centsToNumber(balanceAfterCents);

    let transactionId: string | undefined;
    if (!isPlayMode) {
      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          amount,
          balanceBefore,
          balanceAfter,
          relatedBetId,
          remark: remark || this.buildRemark(params.type, relatedBetId),
          orderNo,
          tradeNo,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      transactionId = transaction.id;
    }

    return { success: true, result: { balanceBefore, balanceAfter, transactionId } };
  }

  /**
   * Complete a pending recharge order atomically (idempotent).
   *
   * The order is created as a PENDING Transaction earlier (by orderNo).
   * This method credits the user's balance and updates the existing transaction record
   * to COMPLETED with accurate balanceBefore/After.
   */
  async completeRechargeOrder(
    params: { orderNo: string; tradeNo: string; amount: number },
    tx?: Prisma.TransactionClient
  ): Promise<{ processed: boolean; balanceBefore?: number; balanceAfter?: number }> {
    const orderNo = normalizeOptionalString(params.orderNo);
    const tradeNo = normalizeOptionalString(params.tradeNo);
    const amount = roundMoney(params.amount);

    if (!orderNo) throw new Error('orderNo is required');
    if (!tradeNo) throw new Error('tradeNo is required');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');

    if (tx) {
      return this.completeRechargeOrderInTx({ orderNo, tradeNo, amount }, tx);
    }

    try {
      return await this.prisma.$transaction((innerTx) =>
        this.completeRechargeOrderInTx({ orderNo, tradeNo, amount }, innerTx)
      );
    } catch (error) {
      if (error instanceof RechargeAlreadyProcessedError) {
        return { processed: false };
      }
      throw error;
    }
  }

  private async completeRechargeOrderInTx(
    params: { orderNo: string; tradeNo: string; amount: number },
    tx: Prisma.TransactionClient
  ): Promise<{ processed: boolean; balanceBefore?: number; balanceAfter?: number }> {
    const order = await tx.transaction.findUnique({ where: { orderNo: params.orderNo } });

    if (!order) {
      throw new Error(`Order ${params.orderNo} not found`);
    }

    if (order.type !== 'RECHARGE') {
      throw new Error(`Order ${params.orderNo} is not a RECHARGE transaction`);
    }

    // Idempotency fast path
    if (order.status === 'COMPLETED') {
      return {
        processed: false,
        balanceBefore: Number(order.balanceBefore),
        balanceAfter: Number(order.balanceAfter),
      };
    }

    if (order.status !== 'PENDING') {
      throw new Error(`Order ${params.orderNo} is not pending`);
    }

    const expectedAmountCents = toCents(Number(order.amount));
    const actualAmountCents = toCents(params.amount);
    if (expectedAmountCents !== actualAmountCents) {
      throw new Error(`Amount mismatch for order ${params.orderNo}`);
    }

    let updatedUser: any;
    try {
      updatedUser = await tx.user.update({
        where: { id: order.userId },
        data: { balance: { increment: params.amount } },
        select: { balance: true },
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        throw new Error(`User ${order.userId} not found`);
      }
      throw error;
    }

    const balanceAfterCents = toCents(Number(updatedUser.balance));
    const balanceBeforeCents = balanceAfterCents - actualAmountCents;
    const balanceBefore = centsToNumber(balanceBeforeCents);
    const balanceAfter = centsToNumber(balanceAfterCents);

    const updated = await tx.transaction.updateMany({
      where: { orderNo: params.orderNo, status: 'PENDING' },
      data: {
        status: 'COMPLETED',
        tradeNo: params.tradeNo,
        balanceBefore,
        balanceAfter,
        completedAt: new Date(),
      },
    });

    if (updated.count !== 1) {
      throw new RechargeAlreadyProcessedError(params.orderNo);
    }

    return { processed: true, balanceBefore, balanceAfter };
  }

  /**
   * Set play balance to an absolute value (no ledger entry).
   */
  async setPlayBalance(userId: string, newPlayBalance: number, tx?: Prisma.TransactionClient): Promise<number> {
    if (userId.startsWith('anon-')) return 0;
    const playBalance = roundMoney(newPlayBalance);

    const runner = async (prismaClient: Prisma.TransactionClient) => {
      try {
        const updatedUser = await prismaClient.user.update({
          where: { id: userId },
          data: { playBalance },
          select: { playBalance: true },
        });
        return Number(updatedUser.playBalance);
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new Error(`User ${userId} not found`);
        }
        throw error;
      }
    };

    if (tx) return runner(tx);
    return this.prisma.$transaction(runner);
  }

  /**
   * Get current balance for a user
   *
   * @param userId - User ID
   * @returns Current balance and play balance
   */
  async getBalance(userId: string): Promise<{ balance: number; playBalance: number } | null> {
    // Anonymous users always return 0
    if (userId.startsWith('anon-')) {
      return {
        balance: 0,
        playBalance: 0,
      };
    }

    const user = await this.prisma.user.findUnique({
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
   * Build standard remark for transaction
   *
   * @param type - Transaction type
   * @param relatedBetId - Related bet ID
   * @returns Formatted remark string
   */
  private buildRemark(type: FinancialOperationType, relatedBetId?: string): string {
    const parts: string[] = [];

    switch (type) {
      case 'RECHARGE':
        parts.push('充值');
        break;
      case 'WITHDRAW':
        parts.push('提现');
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

    return parts.join(' | ');
  }

  /**
   * Query user transaction history
   *
   * @param userId - User ID
   * @param options - Query options
   * @returns Transaction records
   */
  async getTransactionHistory(
    userId: string,
    options?: {
      type?: FinancialOperationType;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<any[]> {
    const where: any = { userId };

    if (options?.type) {
      where.type = options.type;
    }

    if (options?.startDate || options?.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = options.startDate;
      if (options.endDate) where.createdAt.lte = options.endDate;
    }

    return this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 100,
    });
  }
}

/**
 * Create a singleton instance for convenience
 *
 * Note: In production, you should inject the PrismaClient instance
 * rather than importing a global singleton.
 */
export function createFinancialService(prisma: PrismaClient): FinancialService {
  return new FinancialService(prisma);
}

class RechargeAlreadyProcessedError extends Error {
  override name = 'RechargeAlreadyProcessedError';
  constructor(orderNo: string) {
    super(`Recharge order already processed: ${orderNo}`);
  }
}
