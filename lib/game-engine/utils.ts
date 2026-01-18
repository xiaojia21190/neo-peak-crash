/**
 * 游戏引擎工具函数
 */

import crypto from 'crypto';
import { CENTER_ROW_INDEX, PRICE_SENSITIVITY, MAX_ROW_INDEX } from './constants';

/**
 * 计算行索引（根据价格变化）
 */
export function calculateRowIndex(currentPrice: number, startPrice: number): number {
  const percentChange = (currentPrice - startPrice) / startPrice;
  const rowDelta = percentChange * PRICE_SENSITIVITY;
  return Math.max(-MAX_ROW_INDEX, Math.min(MAX_ROW_INDEX, CENTER_ROW_INDEX - rowDelta));
}

/**
 * 计算投注倍率
 * 倍率基于目标行与当前行的距离，以及时间差
 */
export function calculateMultiplier(
  targetRow: number,
  currentRow: number,
  timeDelta: number
): number {
  // 基础倍率：行距离越远，倍率越高
  const rowDistance = Math.abs(targetRow - currentRow);
  const baseMultiplier = 1 + rowDistance * 0.5;

  // 时间因子：时间越短，倍率越高（最小倍率 1.0）
  const timeFactor = Math.max(1, 2 - timeDelta * 0.1);

  // 最终倍率，保留 4 位小数
  const multiplier = Math.round(baseMultiplier * timeFactor * 10000) / 10000;

  // 限制范围 1.01 - 100.00
  return Math.max(1.01, Math.min(100, multiplier));
}

/**
 * 生成服务端种子
 */
export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 计算种子哈希（SHA256）
 */
export function hashSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * 验证种子哈希
 */
export function verifySeedHash(seed: string, expectedHash: string): boolean {
  return hashSeed(seed) === expectedHash;
}

/**
 * 生成唯一订单 ID
 */
export function generateOrderId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 节流函数
 */
export function createThrottler<T extends (...args: unknown[]) => void>(
  fn: T,
  intervalMs: number
): T {
  let lastCall = 0;

  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn(...args);
    }
  }) as T;
}

/**
 * 防抖函数
 */
export function createDebouncer<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number
): T {
  let timeoutId: NodeJS.Timeout | null = null;

  return ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delayMs);
  }) as T;
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时的 Promise
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}
