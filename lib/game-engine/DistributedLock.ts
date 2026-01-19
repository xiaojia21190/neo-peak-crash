/**
 * Redis 分布式锁实现
 */
import type { Redis } from 'ioredis';
import { randomBytes } from 'crypto';

export class DistributedLock {
  constructor(private redis: Redis) {}

  /**
   * 获取锁
   * @param key 锁键名
   * @param ttl 锁过期时间（毫秒）
   * @returns 锁令牌，失败返回 null
   */
  async acquire(key: string, ttl: number): Promise<string | null> {
    const token = randomBytes(16).toString('hex');
    const result = await this.redis.set(key, token, 'PX', ttl, 'NX');
    return result === 'OK' ? token : null;
  }

  /**
   * 释放锁（使用 Lua 脚本确保原子性）
   * @param key 锁键名
   * @param token 锁令牌
   * @returns 是否成功释放
   */
  async release(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, token);
    return result === 1;
  }

  /**
   * 延长锁过期时间
   * @param key 锁键名
   * @param token 锁令牌
   * @param ttl 新的过期时间（毫秒）
   * @returns 是否成功延长
   */
  async extend(key: string, token: string, ttl: number): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, key, token, ttl);
    return result === 1;
  }

  /**
   * 检查锁是否存在
   * @param key 锁键名
   * @returns 锁是否存在
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }
}
