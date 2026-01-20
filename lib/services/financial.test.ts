/**
 * FinancialService Unit Tests
 *
 * This test suite verifies:
 * 1. Balance change operations
 * 2. Transaction logging
 * 3. Anonymous user handling
 * 4. Batch operations
 * 5. Conditional balance changes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FinancialService } from './financial';
import type { PrismaClient } from '@prisma/client';

// Mock PrismaClient
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  transaction: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
} as unknown as PrismaClient;

describe('FinancialService', () => {
  let financialService: FinancialService;

  beforeEach(() => {
    financialService = new FinancialService(mockPrisma);
    vi.clearAllMocks();
  });

  describe('changeBalance', () => {
    it('should successfully change real balance and create transaction', async () => {
      const userId = 'user-123';
      const amount = 100;

      // Mock user lookup
      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 500,
        playBalance: 1000,
      });

      // Mock balance update
      (mockPrisma.user.update as any).mockResolvedValue({
        balance: 600,
      });

      // Mock transaction creation
      (mockPrisma.transaction.create as any).mockResolvedValue({
        id: 'txn-123',
        type: 'RECHARGE',
        amount: 100,
        balanceBefore: 500,
        balanceAfter: 600,
      });

      const result = await financialService.changeBalance({
        userId,
        amount,
        type: 'RECHARGE',
        isPlayMode: false,
      });

      expect(result.balanceBefore).toBe(500);
      expect(result.balanceAfter).toBe(600);
      expect(result.transactionId).toBe('txn-123');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: { balance: true, playBalance: true },
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { balance: { increment: amount } },
      });

      expect(mockPrisma.transaction.create).toHaveBeenCalled();
    });

    it('should change play balance without creating transaction', async () => {
      const userId = 'user-123';
      const amount = 100;

      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 500,
        playBalance: 1000,
      });

      (mockPrisma.user.update as any).mockResolvedValue({
        playBalance: 1100,
      });

      const result = await financialService.changeBalance({
        userId,
        amount,
        type: 'WIN',
        isPlayMode: true,
      });

      expect(result.balanceBefore).toBe(1000);
      expect(result.balanceAfter).toBe(1100);
      expect(result.transactionId).toBeUndefined();

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { playBalance: { increment: amount } },
      });

      // No transaction created for play mode
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('should handle anonymous users in play mode', async () => {
      const result = await financialService.changeBalance({
        userId: 'anon-123',
        amount: 100,
        type: 'WIN',
        isPlayMode: true,
      });

      expect(result.balanceBefore).toBe(0);
      expect(result.balanceAfter).toBe(0);

      // No database operations for anonymous users
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('should throw error for anonymous users trying to use real balance', async () => {
      await expect(
        financialService.changeBalance({
          userId: 'anon-123',
          amount: 100,
          type: 'RECHARGE',
          isPlayMode: false,
        })
      ).rejects.toThrow('Anonymous users can only use play mode');
    });

    it('should throw error if user not found', async () => {
      (mockPrisma.user.findUnique as any).mockResolvedValue(null);

      await expect(
        financialService.changeBalance({
          userId: 'nonexistent',
          amount: 100,
          type: 'RECHARGE',
          isPlayMode: false,
        })
      ).rejects.toThrow('User nonexistent not found');
    });
  });

  describe('batchChangeBalance', () => {
    it('should batch multiple balance changes efficiently', async () => {
      const userId = 'user-123';
      const changes = [
        { amount: 100, type: 'WIN' as const, relatedBetId: 'bet-1', remark: 'Win 1' },
        { amount: 200, type: 'WIN' as const, relatedBetId: 'bet-2', remark: 'Win 2' },
        { amount: 150, type: 'WIN' as const, relatedBetId: 'bet-3', remark: 'Win 3' },
      ];

      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 1000,
        playBalance: 5000,
      });

      (mockPrisma.user.update as any).mockResolvedValue({
        balance: 1450,
      });

      (mockPrisma.transaction.create as any)
        .mockResolvedValueOnce({ id: 'txn-1' })
        .mockResolvedValueOnce({ id: 'txn-2' })
        .mockResolvedValueOnce({ id: 'txn-3' });

      const result = await financialService.batchChangeBalance({
        userId,
        changes,
        isPlayMode: false,
      });

      expect(result.balanceBefore).toBe(1000);
      expect(result.balanceAfter).toBe(1450); // 1000 + 100 + 200 + 150
      expect(result.transactionIds).toHaveLength(3);

      // Verify single balance update
      expect(mockPrisma.user.update).toHaveBeenCalledOnce();
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { balance: { increment: 450 } }, // Total change
      });

      // Verify transactions created
      expect(mockPrisma.transaction.create).toHaveBeenCalledTimes(3);
    });

    it('should handle anonymous users in batch operations', async () => {
      const result = await financialService.batchChangeBalance({
        userId: 'anon-123',
        changes: [{ amount: 100, type: 'WIN', relatedBetId: 'bet-1' }],
        isPlayMode: true,
      });

      expect(result.balanceBefore).toBe(0);
      expect(result.balanceAfter).toBe(0);
      expect(result.transactionIds).toHaveLength(0);

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('conditionalChangeBalance', () => {
    it('should succeed when balance is sufficient', async () => {
      const userId = 'user-123';
      const amount = -50; // Deduction

      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 100,
        playBalance: 1000,
      });

      (mockPrisma.user.updateMany as any).mockResolvedValue({
        count: 1, // Success
      });

      (mockPrisma.transaction.create as any).mockResolvedValue({
        id: 'txn-123',
      });

      const result = await financialService.conditionalChangeBalance({
        userId,
        amount,
        type: 'BET',
        isPlayMode: false,
        minBalance: 50,
      });

      expect(result.success).toBe(true);
      expect(result.result?.balanceBefore).toBe(100);
      expect(result.result?.balanceAfter).toBe(50);

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: userId,
          balance: { gte: 50 },
        },
        data: {
          balance: { increment: -50 },
        },
      });
    });

    it('should fail when balance is insufficient', async () => {
      const userId = 'user-123';
      const amount = -100;

      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 50,
        playBalance: 1000,
      });

      const result = await financialService.conditionalChangeBalance({
        userId,
        amount,
        type: 'BET',
        isPlayMode: false,
        minBalance: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient balance');

      // Should not attempt update
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('should fail when updateMany returns 0 (race condition)', async () => {
      const userId = 'user-123';
      const amount = -50;

      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 100,
        playBalance: 1000,
      });

      // Another transaction updated the balance concurrently
      (mockPrisma.user.updateMany as any).mockResolvedValue({
        count: 0,
      });

      const result = await financialService.conditionalChangeBalance({
        userId,
        amount,
        type: 'BET',
        isPlayMode: false,
        minBalance: 50,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient balance');
    });
  });

  describe('getBalance', () => {
    it('should return user balance', async () => {
      (mockPrisma.user.findUnique as any).mockResolvedValue({
        balance: 500,
        playBalance: 1000,
      });

      const result = await financialService.getBalance('user-123');

      expect(result).toEqual({
        balance: 500,
        playBalance: 1000,
      });
    });

    it('should return 0 for anonymous users', async () => {
      const result = await financialService.getBalance('anon-123');

      expect(result).toEqual({
        balance: 0,
        playBalance: 0,
      });

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should return null if user not found', async () => {
      (mockPrisma.user.findUnique as any).mockResolvedValue(null);

      const result = await financialService.getBalance('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getTransactionHistory', () => {
    it('should query transaction history with filters', async () => {
      const mockTransactions = [
        { id: 'txn-1', type: 'RECHARGE', amount: 100 },
        { id: 'txn-2', type: 'BET', amount: -50 },
      ];

      (mockPrisma.transaction.findMany as any).mockResolvedValue(mockTransactions);

      const result = await financialService.getTransactionHistory('user-123', {
        type: 'RECHARGE',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        limit: 50,
      });

      expect(result).toEqual(mockTransactions);

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          type: 'RECHARGE',
          createdAt: {
            gte: new Date('2024-01-01'),
            lte: new Date('2024-12-31'),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });
  });
});
