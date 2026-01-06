
export const INITIAL_BALANCE = 1000;
export const HOUSE_EDGE = 0.06; // 利润最大化：将抽水率从 3% 提升至 6%
export const COUNTDOWN_TIME = 2; // Reduced from 5s to 2s for snappier gameplay
export const CHART_FPS = 60;
export const MULTIPLIER_STEP = 0.0006; // Growth rate control
export const MIN_BET = 1;
export const MAX_BET = 2000;

export const CENTER_ROW_INDEX = 6.5; 

// HARDCORE MODE ADJUSTMENTS:
// Sensitivity: 28000 (Amplifies micro-volatility)
export const PRICE_SENSITIVITY = 28000;

// Dynamic Multiplier Calculation
// REVISED: Optimized for Platform Profitability.
// Added: timeDelta (seconds into the future)
export const calculateMultiplier = (
  rowIndex: number, 
  centerIndex: number = CENTER_ROW_INDEX, 
  timeDelta: number = 0
): number => {
  const distance = Math.abs(rowIndex - centerIndex);
  
  // 1. Sigma (Standard Deviation)
  const sigma = 3.5; 
  
  // Base Probability
  const baseProbability = 0.92;

  // Gaussian Function: P(x)
  const probability = baseProbability * Math.exp(-(distance * distance) / (2 * sigma * sigma));

  // 2. Calculate "Fair Payout"
  const fairPayout = 1 / probability;

  // 3. Apply Increased House Edge
  const housePayout = fairPayout * (1 - HOUSE_EDGE);

  // 4. Time Bonus Logic
  // Strategy: Incentivize betting into the future.
  // Rate: ~4% increase per second into the future.
  // If you bet 5 seconds out, you get ~1.2x the base odds.
  const timeBonus = 1 + (Math.max(0, timeDelta) * 0.04);

  // 5. Formatting & Risk Control
  // 强制锁死最大赔率为 100x (increased from 88x due to time bonus capability)
  return Math.max(1.01, Math.min(100, housePayout * timeBonus));
};

// Deprecated but kept for type safety if needed temporarily
export const GRID_MULTIPLIERS = [];
