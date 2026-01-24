import type { Redis } from 'ioredis';
import { DistributedLock } from './DistributedLock';
import { REDIS_KEYS } from './constants';

export class LockManager {
  private distributedLock: DistributedLock;
  private roundLockToken: string | null = null;

  constructor(private redis: Redis) {
    this.distributedLock = new DistributedLock(redis);
  }

  async acquireRoundLock(asset: string, ttlMs: number): Promise<string | null> {
    const lockKey = `${REDIS_KEYS.ROUND_STATE}${asset}:lock`;
    const token = await this.distributedLock.acquire(lockKey, ttlMs);
    this.roundLockToken = token;
    return token;
  }

  async releaseRoundLock(asset: string): Promise<boolean> {
    if (!this.roundLockToken) return false;
    const lockKey = `${REDIS_KEYS.ROUND_STATE}${asset}:lock`;
    try {
      return await this.distributedLock.release(lockKey, this.roundLockToken);
    } finally {
      this.roundLockToken = null;
    }
  }

  async acquireBetLock(orderId: string, ttlMs = 30000): Promise<string | null> {
    const lockKey = `${REDIS_KEYS.BET_LOCK}${orderId}`;
    try {
      return await this.distributedLock.acquire(lockKey, ttlMs);
    } catch (error) {
      console.warn(`[LockManager] Failed to acquire bet lock for order ${orderId}`, error);
      return null;
    }
  }

  async releaseBetLock(orderId: string, token: string): Promise<boolean> {
    const lockKey = `${REDIS_KEYS.BET_LOCK}${orderId}`;
    if (!token) return false;
    return this.distributedLock.release(lockKey, token);
  }
}
