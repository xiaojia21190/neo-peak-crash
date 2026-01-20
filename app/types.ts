
export enum GameStatus {
  WAITING = 'WAITING',
  RUNNING = 'RUNNING',
  CRASHED = 'CRASHED'
}

export interface GridBet {
  id: string;
  targetMultiplier: number;
  rowIndex: number; // The specific row index (0-13) this bet is placed on
  amount: number;
  isTriggered: boolean;
  isLost: boolean;
  timePoint: number; // For positioning on the grid horizontally
}

export interface Candlestick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number; // In this game, 'close' represents the visual Y-axis Row Index
}

export interface StreakState {
  type: 'WIN' | 'LOSS' | 'NONE';
  count: number;
}

export interface GameState {
  currentMultiplier: number; // This is the displayed value (e.g. 7.57x)
  currentRowIndex: number;   // This is the internal position (0-13)
  status: GameStatus;
  history: number[];
  balance: number;
  sessionPL: number;
  activeBets: GridBet[];
  candles: Candlestick[];
  countdown: number;
  streaks: Record<string, StreakState>; // Track streaks per asset symbol
}

// NEW: Mutable state for high-frequency animation loop
export interface GameEngineState {
  candles: Candlestick[];
  activeBets: GridBet[];
  status: GameStatus;
  currentMultiplier: number;
  currentRowIndex: number;
  prevRowIndex: number; // Tracks the exact position of the previous frame (16ms ago)
  currentTime: number;
}
