/**
 * 游戏引擎常量定义
 */

// Row index + odds config (canonical 0-based)
export { HOUSE_EDGE, MIN_ROW_INDEX, MAX_ROW_INDEX, CENTER_ROW_INDEX, PRICE_SENSITIVITY } from '../shared/gameMath';

// 时间相关
export const MIN_TARGET_TIME_OFFSET = 0.5;  // 最小目标时间偏移（秒）
export const HIT_TIME_TOLERANCE = 0.5;      // 命中时间容差（±秒）
export const MISS_TIME_BUFFER = 0.6;        // 未命中判定缓冲（秒）

// 价格服务相关
export const PRICE_STALE_THRESHOLD = 5000;      // 价格过期阈值（毫秒）
export const PRICE_CRITICAL_THRESHOLD = 10000;  // 价格严重过期阈值（毫秒）

// 默认配置
export const DEFAULT_ROUND_CONFIG = {
  asset: 'BTCUSDT',
  bettingDuration: 5,      // 投注阶段 5 秒
  maxDuration: 60,         // 最大回合时长 60 秒
  minBetAmount: 1,
  maxBetAmount: 1000,
  maxBetsPerUser: 10,
  maxBetsPerSecond: 5,     // 每用户每秒最多 5 次投注
  hitTolerance: 0.4,       // 碰撞容差 ±0.4 行
  tickInterval: 16,        // 约 60fps
} as const;

// Redis Key 前缀
export const REDIS_KEYS = {
  ROUND_STATE: 'game:round:',       // game:round:{asset}
  ACTIVE_BETS: 'game:bets:',        // game:bets:{roundId}
  PRICE_STREAM: 'game:prices:',     // game:prices:{asset}
  USER_CONNECTIONS: 'game:connections:', // game:connections:{userId}
  BET_LOCK: 'lock:bet:',            // lock:bet:{orderId}
} as const;

// WebSocket 事件
export const WS_EVENTS = {
  // 客户端 -> 服务端
  AUTH: 'auth',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PLACE_BET: 'place_bet',
  CANCEL_BET: 'cancel_bet',
  PING: 'ping',
  VERIFY_ROUND: 'verify_round',

  // 服务端 -> 客户端
  AUTH_RESULT: 'auth_result',
  ROUND_START: 'round_start',
  ROUND_RUNNING: 'round_running',
  ROUND_END: 'round_end',
  ROUND_CANCELLED: 'round_cancelled',
  PRICE_UPDATE: 'price_update',
  STATE_UPDATE: 'state_update',
  BET_CONFIRMED: 'bet_confirmed',
  BET_SETTLED: 'bet_settled',
  BET_REJECTED: 'bet_rejected',
  BET_REFUNDED: 'bet_refunded',
  ERROR: 'error',
  PONG: 'pong',
} as const;

// 错误码
export const ERROR_CODES = {
  NO_ACTIVE_ROUND: 'NO_ACTIVE_ROUND',
  BETTING_CLOSED: 'BETTING_CLOSED',
  TARGET_TIME_PASSED: 'TARGET_TIME_PASSED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MAX_BETS_REACHED: 'MAX_BETS_REACHED',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  DUPLICATE_BET: 'DUPLICATE_BET',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  ROUND_NOT_FOUND: 'ROUND_NOT_FOUND',
  PRICE_UNAVAILABLE: 'PRICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
