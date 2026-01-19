export {
  HOUSE_EDGE,
  MIN_ROW_INDEX,
  MAX_ROW_INDEX,
  CENTER_ROW_INDEX,
  PRICE_SENSITIVITY,
  calculateMultiplier,
} from '@/lib/shared/gameMath';

export const INITIAL_BALANCE = 1000;
export const COUNTDOWN_TIME = 2; // Reduced from 5s to 2s for snappier gameplay
export const CHART_FPS = 60;
export const MULTIPLIER_STEP = 0.0006; // Growth rate control
export const MIN_BET = 1;
export const MAX_BET = 2000;

// Deprecated but kept for type safety if needed temporarily
export const GRID_MULTIPLIERS = [];
