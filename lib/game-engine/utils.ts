/**
 * 游戏引擎工具函数
 */

import crypto from 'crypto';
import { CENTER_ROW_INDEX, PRICE_SENSITIVITY, MIN_ROW_INDEX, MAX_ROW_INDEX } from './constants';
export { calculateMultiplier } from '../shared/gameMath';

/**
 * 计算行索引（根据价格变化）
 */
export function calculateRowIndex(currentPrice: number, startPrice: number): number {
  const percentChange = (currentPrice - startPrice) / startPrice;
  const rowDelta = percentChange * PRICE_SENSITIVITY;
  return Math.max(MIN_ROW_INDEX, Math.min(MAX_ROW_INDEX, CENTER_ROW_INDEX - rowDelta));
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
