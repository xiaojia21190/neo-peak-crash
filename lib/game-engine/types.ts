/**
 * 游戏引擎类型定义
 */

// 回合状态（与 Prisma 枚举对应）
export type RoundStatus = 'PENDING' | 'BETTING' | 'RUNNING' | 'SETTLING' | 'COMPLETED' | 'CANCELLED';

// 投注状态（与 Prisma 枚举对应）
export type BetStatus = 'PENDING' | 'SETTLING' | 'WON' | 'LOST' | 'CANCELLED' | 'REFUNDED';

// ========== 配置类型 ==========

export interface RoundConfig {
  asset: string;
  bettingDuration: number;    // 投注阶段时长（秒）
  maxDuration: number;        // 最大回合时长（秒）
  minBetAmount: number;
  maxBetAmount: number;
  maxBetsPerUser: number;
  maxBetsPerSecond: number;   // 每用户每秒最大投注次数
  hitTolerance: number;       // 碰撞容差
  tickInterval: number;       // 检测间隔（ms）
}

// ========== 状态类型 ==========

export interface GameState {
  roundId: string;
  status: RoundStatus;
  asset: string;
  startPrice: number;
  currentPrice: number;
  currentRow: number;
  prevRow?: number;           // 上一帧行索引（用于交叉检测）
  elapsed: number;            // 已过秒数
  roundStartTime: number;     // 回合开始时间戳（ms）
  activeBets: Map<string, ServerBet>;
}

export interface ServerBet {
  id: string;
  orderId: string;            // 幂等性 key
  userId: string;
  amount: number;
  multiplier: number;
  targetRow: number;
  targetTime: number;
  placedAt: number;
  status: BetStatus;
  isPlayMode: boolean;
}

export interface HitDetails {
  hitPrice: number;
  hitRow: number;
  hitTime: number;
}

export interface PriceUpdate {
  asset: string;
  price: number;
  timestamp: number;
  source: 'bybit';
}

export interface PriceSnapshot {
  roundId: string;
  timestamp: Date;
  price: number;
  rowIndex: number;
}

// ========== 请求/响应类型 ==========

export interface PlaceBetRequest {
  orderId: string;
  targetRow: number;
  targetTime: number;
  amount: number;
  isPlayMode?: boolean;
}

export interface PlaceBetResponse {
  betId: string;
  multiplier: number;
  targetTime: number;
  targetRow: number;
}

export interface SettlementItem {
  bet: ServerBet;
  isWin: boolean;
  hitDetails?: HitDetails;
}

// ========== WebSocket 消息类型 ==========

export interface WSMessage {
  type: string;
  payload?: unknown;
  timestamp: number;
  seq?: number;
}

// 客户端 -> 服务端
export interface AuthMessage extends WSMessage {
  type: 'auth';
  payload: {
    token: string;
  };
}

export interface PlaceBetMessage extends WSMessage {
  type: 'place_bet';
  payload: PlaceBetRequest;
}

export interface StateRequestMessage extends WSMessage {
  type: 'state_request';
  payload?: {
    /**
     * 是否包含用户历史下注（默认 true）
     */
    includeHistory?: boolean;
    /**
     * 返回的历史下注数量（默认 20）
     */
    historyLimit?: number;
  };
}

// 服务端 -> 客户端
export interface RoundStartMessage extends WSMessage {
  type: 'round_start';
  payload: {
    roundId: string;
    asset: string;
    startPrice: number;
    startTime: number;
    bettingDuration: number;
    maxDuration: number;
  };
}

export interface RoundEndMessage extends WSMessage {
  type: 'round_end';
  payload: {
    roundId: string;
    endPrice: number;
    reason: 'timeout' | 'manual' | 'crash';
    stats: {
      totalBets: number;
      totalWins: number;
      totalPayout: number;
    };
  };
}

export interface PriceUpdateMessage extends WSMessage {
  type: 'price_update';
  payload: {
    price: number;
    rowIndex: number;
    timestamp: number;
  };
}

export interface BetConfirmedMessage extends WSMessage {
  type: 'bet_confirmed';
  payload: {
    orderId: string;
    betId: string;
    multiplier: number;
    targetRow: number;
    targetTime: number;
    amount: number;
  };
}

export interface BetSettledMessage extends WSMessage {
  type: 'bet_settled';
  payload: {
    betId: string;
    orderId: string;
    isWin: boolean;
    payout: number;
    hitDetails?: HitDetails;
    newBalance: number;
  };
}

export interface BetRejectedMessage extends WSMessage {
  type: 'bet_rejected';
  payload: {
    orderId: string;
    code: string;
    message: string;
  };
}

export interface ErrorMessage extends WSMessage {
  type: 'error';
  payload: {
    code: string;
    message: string;
  };
}

export interface GameStateSnapshot {
  roundId: string | null;
  status: RoundStatus | null;
  asset: string;
  startPrice: number;
  currentPrice: number;
  currentRow: number;
  elapsed: number;
  startTime: number;
  bettingDuration: number;
  maxDuration: number;
}

export interface BetSnapshot {
  betId: string;
  orderId: string | null;
  roundId: string | null;
  amount: number;
  multiplier: number;
  targetRow: number | null;
  targetTime: number | null;
  status: BetStatus;
  isWin: boolean;
  payout: number;
  isPlayMode: boolean;
  hitDetails?: HitDetails;
  createdAt: number;
  settledAt?: number | null;
}

export interface UserStateSnapshot {
  balance: number;
  playBalance: number;
  recentBets: BetSnapshot[];
}

export interface StateSnapshotMessage extends WSMessage {
  type: 'state_snapshot';
  payload: {
    serverTime: number;
    connectionId: string;
    isAuthenticated: boolean;
    userId: string | null;
    game: GameStateSnapshot;
    user: UserStateSnapshot | null;
  };
}

// ========== 事件类型 ==========

export interface GameEngineEvents {
  'round:start': RoundStartMessage['payload'];
  'round:running': { roundId: string };
  'round:end': RoundEndMessage['payload'];
  'round:cancelled': {
    roundId: string;
    reason: string;
    refundedBets: number;
  };
  'price': PriceUpdate;
  'state:update': {
    elapsed: number;
    currentPrice: number;
    currentRow: number;
  };
  'bet:confirmed': BetConfirmedMessage['payload'];
  'bet:settled': Omit<BetSettledMessage['payload'], 'newBalance'>;
  'bet:rejected': BetRejectedMessage['payload'];
  'bet:refunded': {
    betId: string;
    orderId: string;
    userId: string;
    amount: number;
    reason: string;
  };
  'price_unavailable': void;
}

// ========== 工具类型 ==========

export type RoundEndReason = 'timeout' | 'manual' | 'crash';

export interface VerifyResult {
  valid: boolean;
  error?: string;
}
