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

import type { PrismaClient, Prisma } from '@prisma/client';

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
    const { userId, amount, type, isPlayMode, relatedBetId, remark, orderNo, tradeNo } = params;

    const prismaClient = tx || this.prisma;

    // Anonymous users only support play mode
    const isAnonymous = userId.startsWith('anon-');
    if (isAnonymous && !isPlayMode) {
      throw new Error('Anonymous users can only use play mode');
    }

    // For anonymous users in play mode, skip database operations
    if (isAnonymous && isPlayMode) {
      return {
        balanceBefore: 0,
        balanceAfter: 0,
      };
    }

    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    // Get current balance
    const user = await prismaClient.user.findUnique({
      where: { id: userId },
      select: { balance: true, playBalance: true },
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const balanceBefore = Number(balanceField === 'balance' ? user.balance : user.playBalance);

    // Update balance
    await prismaClient.user.update({
      where: { id: userId },
      data: { [balanceField]: { increment: amount } },
    });

    const balanceAfter = balanceBefore + amount;

    // Record transaction (only for real balance, not play mode)
    let transactionId: string | undefined;
    if (!isPlayMode) {
      const transaction = await prismaClient.transaction.create({
        data: {
          userId,
          type,
          amount,
          balanceBefore,
          balanceAfter,
          relatedBetId,
          remark: remark || this.buildRemark(type, relatedBetId),
          orderNo,
          tradeNo,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      transactionId = transaction.id;
    }

    return {
      balanceBefore,
      balanceAfter,
      transactionId,
    };
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
    const { userId, changes, isPlayMode } = params;
    const prismaClient = tx || this.prisma;

    // Anonymous users in play mode skip database
    const isAnonymous = userId.startsWith('anon-');
    if (isAnonymous && isPlayMode) {
      return {
        balanceBefore: 0,
        balanceAfter: 0,
        transactionIds: [],
      };
    }

    if (isAnonymous && !isPlayMode) {
      throw new Error('Anonymous users can only use play mode');
    }

    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    // Get current balance
    const user = await prismaClient.user.findUnique({
      where: { id: userId },
      select: { balance: true, playBalance: true },
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const balanceBefore = Number(balanceField === 'balance' ? user.balance : user.playBalance);

    // Calculate total change
    const totalChange = changes.reduce((sum, change) => sum + change.amount, 0);

    // Update balance once
    await prismaClient.user.update({
      where: { id: userId },
      data: { [balanceField]: { increment: totalChange } },
    });

    const balanceAfter = balanceBefore + totalChange;

    // Record transactions (only for real balance)
    const transactionIds: string[] = [];
    if (!isPlayMode && changes.length > 0) {
      let currentBalance = balanceBefore;

      const transactionData = changes.map((change) => {
        const balanceBeforeThis = currentBalance;
        currentBalance += change.amount;

        return {
          userId,
          type: change.type,
          amount: change.amount,
          balanceBefore: balanceBeforeThis,
          balanceAfter: currentBalance,
          relatedBetId: change.relatedBetId,
          remark: change.remark || this.buildRemark(change.type, change.relatedBetId),
          status: 'COMPLETED' as const,
          completedAt: new Date(),
        };
      });

      // For batch insert, we can't get IDs back easily with createMany
      // So we create them individually to track IDs
      for (const data of transactionData) {
        const transaction = await prismaClient.transaction.create({ data });
        transactionIds.push(transaction.id);
      }
    }

    return {
      balanceBefore,
      balanceAfter,
      transactionIds,
    };
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
    const { userId, amount, type, isPlayMode, minBalance, relatedBetId, remark, orderNo, tradeNo } = params;
    const prismaClient = tx || this.prisma;

    // Anonymous users in play mode always succeed
    const isAnonymous = userId.startsWith('anon-');
    if (isAnonymous && isPlayMode) {
      return {
        success: true,
        result: {
          balanceBefore: 0,
          balanceAfter: 0,
        },
      };
    }

    if (isAnonymous && !isPlayMode) {
      return {
        success: false,
        error: 'Anonymous users can only use play mode',
      };
    }

    const balanceField = isPlayMode ? 'playBalance' : 'balance';

    // Get current balance
    const user = await prismaClient.user.findUnique({
      where: { id: userId },
      select: { balance: true, playBalance: true },
    });

    if (!user) {
      return {
        success: false,
        error: 'User not found',
      };
    }

    const balanceBefore = Number(balanceField === 'balance' ? user.balance : user.playBalance);

    // Check minimum balance requirement (for deductions)
    const requiredBalance = minBalance !== undefined ? minBalance : -amount;
    if (amount < 0 && balanceBefore < requiredBalance) {
      return {
        success: false,
        error: 'Insufficient balance',
      };
    }

    // Use updateMany for atomic conditional update
    const updateResult = await prismaClient.user.updateMany({
      where: {
        id: userId,
        [balanceField]: { gte: requiredBalance },
      },
      data: {
        [balanceField]: { increment: amount },
      },
    });

    if (updateResult.count === 0) {
      return {
        success: false,
        error: 'Insufficient balance',
      };
    }

    const balanceAfter = balanceBefore + amount;

    // Record transaction (only for real balance)
    let transactionId: string | undefined;
    if (!isPlayMode) {
      const transaction = await prismaClient.transaction.create({
        data: {
          userId,
          type,
          amount,
          balanceBefore,
          balanceAfter,
          relatedBetId,
          remark: remark || this.buildRemark(type, relatedBetId),
          orderNo,
          tradeNo,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      transactionId = transaction.id;
    }

    return {
      success: true,
      result: {
        balanceBefore,
        balanceAfter,
        transactionId,
      },
    };
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
