"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { GameStatus, GridBet, GameState, GameEngineState } from "./types";
import { COUNTDOWN_TIME, CENTER_ROW_INDEX, calculateMultiplier, PRICE_SENSITIVITY, HOUSE_EDGE } from "./constants";
import GameChart from "@/components/GameChart";
import { RechargeModal } from "@/components/RechargeModal";
import { useToast } from "@/components/Toast";
import { TutorialModal } from "@/components/TutorialModal";
import { GameStats } from "@/components/GameStats";
import { BetHistoryPanel } from "@/components/BetHistoryPanel";
import { WinCelebration, ModeSwitchOverlay, LoseAnimation } from "@/components/Animations";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAudio, useBybitWebSocket, useGameBalance } from "@/hooks";

// HIT TOLERANCE:
// Relaxed intersection logic based on user feedback (0.8 area).
// A value of 0.4 creates a +/- 0.4 range, resulting in a total hit zone of 0.8 units (80% of a cell).
// This allows the bet to win if the price line passes through the majority of the cell, not just the exact center.
const HIT_TOLERANCE = 0.4;

// Helper to generate a random SHA-256 style hex string for visual "Provably Fair" authenticity
const generateHash = () => {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
};

// Helper: Linear Interpolation to get displayed multiplier value from Row Index
// Updated to support infinite rows
const getMultiplierAtRow = (rowIndex: number): number => {
  const lower = Math.floor(rowIndex);
  const upper = Math.ceil(rowIndex);

  // Pass 0 for timeDelta as this is for the current "Now" display
  const valLower = calculateMultiplier(lower, CENTER_ROW_INDEX, 0);
  const valUpper = calculateMultiplier(upper, CENTER_ROW_INDEX, 0);

  if (lower === upper) return valLower;

  const frac = rowIndex - lower;
  return valLower + (valUpper - valLower) * frac;
};

const App: React.FC = () => {
  // Toast 通知
  const { showToast } = useToast();

  // 用户会话
  const { data: session, status: sessionStatus } = useSession();
  const user = session?.user as
    | {
        id?: string;
        name?: string;
        username?: string;
        trustLevel?: number;
        provider?: string;
      }
    | undefined;
  const isLoggedIn = sessionStatus === "authenticated" && user?.provider === "linux-do";

  // 使用自定义 Hooks
  const { isMusicPlaying, toggleMusic, playSound } = useAudio();
  const { isPlayMode, ldcBalance, playBalance, currentBalance, setCurrentBalance, toggleGameMode, resetPlayBalance, setLdcBalance, isRechargeModalOpen, setIsRechargeModalOpen } = useGameBalance({ userId: user?.id, isLoggedIn, showToast });

  // 资产选择
  const [selectedAsset, setSelectedAsset] = useState<string>("ETH");

  // WebSocket 连接
  const { realPrice, lastTrade, connectionError, latestPriceRef } = useBybitWebSocket(selectedAsset);

  // 1. REACT STATE: Only for UI updates (Text, Balance, Status) - Updates at low FPS (e.g., 10fps)
  const [gameState, setGameState] = useState<GameState>({
    currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
    currentRowIndex: CENTER_ROW_INDEX,
    status: GameStatus.WAITING,
    history: [],
    balance: 0, // 将使用 ldcBalance 替代
    sessionPL: 0,
    activeBets: [],
    candles: [],
    countdown: COUNTDOWN_TIME,
    streaks: {},
    roundHash: generateHash(), // Initial hash
  });

  // 2. ENGINE REF: Stores the "True" game state for high-frequency (60fps) logic and Charting
  // This bypasses React's render cycle for the heavy lifting.
  const engineRef = useRef<GameEngineState>({
    candles: [{ time: 0, open: CENTER_ROW_INDEX, high: CENTER_ROW_INDEX, low: CENTER_ROW_INDEX, close: CENTER_ROW_INDEX }],
    activeBets: [],
    status: GameStatus.WAITING,
    currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
    currentRowIndex: CENTER_ROW_INDEX,
    prevRowIndex: CENTER_ROW_INDEX,
    currentTime: 0,
  });

  const [stakeAmount, setStakeAmount] = useState<number>(5.0);
  const [startPrice, setStartPrice] = useState<number>(0);

  // 教程弹窗状态
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);

  // 游戏统计
  const [totalBets, setTotalBets] = useState(0);
  const [totalWins, setTotalWins] = useState(0);
  const [totalLosses, setTotalLosses] = useState(0);

  // 下注历史
  interface BetHistoryItem {
    id: string;
    time: number;
    multiplier: number;
    stake: number;
    result: "win" | "loss" | "pending";
    payout: number;
  }
  const [betHistory, setBetHistory] = useState<BetHistoryItem[]>([]);

  // 动画状态
  const [showWinCelebration, setShowWinCelebration] = useState(false);
  const [winAmount, setWinAmount] = useState(0);
  const [winMultiplier, setWinMultiplier] = useState(0);
  const [showLoseAnimation, setShowLoseAnimation] = useState(false);

  // 首次访问显示教程
  useEffect(() => {
    const tutorialCompleted = localStorage.getItem("tutorial_completed");
    if (!tutorialCompleted) {
      // 延迟显示，等待页面加载完成
      const timer = setTimeout(() => {
        setIsTutorialOpen(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const startTimeRef = useRef<number>(0);
  const candleCounterRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0); // For throttling UI updates

  // --- 2. Game Loop Control ---
  const startRound = useCallback(() => {
    if (latestPriceRef.current === 0) return;

    startTimeRef.current = Date.now();
    candleCounterRef.current = 0;
    setStartPrice(latestPriceRef.current);

    // Reset Engine Ref
    engineRef.current = {
      candles: [{ time: 0, open: CENTER_ROW_INDEX, high: CENTER_ROW_INDEX, low: CENTER_ROW_INDEX, close: CENTER_ROW_INDEX }],
      activeBets: [],
      status: GameStatus.RUNNING,
      currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
      currentRowIndex: CENTER_ROW_INDEX,
      prevRowIndex: CENTER_ROW_INDEX, // Initialize Previous
      currentTime: 0,
    };

    // Update React State (UI)
    setGameState((prev) => ({
      ...prev,
      status: GameStatus.RUNNING,
      currentRowIndex: CENTER_ROW_INDEX,
      currentMultiplier: calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0),
      countdown: 0,
      activeBets: [],
      roundHash: generateHash(), // Generate NEW HASH for the round
    }));
  }, []);

  // Handle Crash Event (Transition to CRASHED state first)
  const handleCrash = useCallback(() => {
    playSound("crash");

    const crashValue = engineRef.current.currentMultiplier;
    engineRef.current.status = GameStatus.CRASHED;

    setGameState((prev) => ({
      ...prev,
      status: GameStatus.CRASHED,
      history: [...prev.history, crashValue], // Record history
    }));

    // Auto-reset after animation (3 seconds)
    setTimeout(() => {
      engineRef.current.status = GameStatus.WAITING;
      engineRef.current.candles = [];
      engineRef.current.activeBets = [];

      setGameState((prev) => ({
        ...prev,
        status: GameStatus.WAITING,
        currentRowIndex: CENTER_ROW_INDEX,
        currentMultiplier: calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0),
        countdown: COUNTDOWN_TIME,
        candles: [],
        activeBets: [],
      }));
    }, 3000);
  }, [playSound, gameState.history]);

  // --- 3. Logic Frame (60 FPS) via RequestAnimationFrame ---
  // PERFORMANCE FIX: This loop updates the Ref (Engine) 60 times a second,
  // but throttles the React State (UI) updates to ~10-12 FPS to avoid lag.
  useEffect(() => {
    let animationFrame: number;

    const update = () => {
      const now = Date.now();
      const engine = engineRef.current;

      if (engine.status === GameStatus.RUNNING) {
        const elapsed = (now - startTimeRef.current) / 1000;
        const currentRealPrice = latestPriceRef.current;
        const basePrice = startPrice;

        if (currentRealPrice > 0 && basePrice > 0) {
          // 1. Calculate Price Delta & Position
          const percentChange = (currentRealPrice - basePrice) / basePrice;
          const rowDelta = percentChange * PRICE_SENSITIVITY;
          let newRowIndex = CENTER_ROW_INDEX - rowDelta;
          newRowIndex = Math.max(-1000, Math.min(1000, newRowIndex));
          const displayMultiplier = getMultiplierAtRow(newRowIndex);

          // 2. Update Engine State (High Frequency)
          // CRITICAL: Store the PREVIOUS frame's row index before updating to new one.
          // This allows exact path checking between frames.
          const prevEngineRow = engine.currentRowIndex;

          engine.currentRowIndex = newRowIndex;
          engine.prevRowIndex = prevEngineRow;
          engine.currentMultiplier = displayMultiplier;
          engine.currentTime = elapsed;

          // Update Candles in Ref
          const candleIdx = Math.floor(elapsed / 0.1);
          if (candleIdx > candleCounterRef.current) {
            candleCounterRef.current = candleIdx;
            engine.candles.push({
              time: elapsed,
              open: newRowIndex,
              high: newRowIndex,
              low: newRowIndex,
              close: newRowIndex,
            });
          } else if (engine.candles.length > 0) {
            const lastCandle = engine.candles[engine.candles.length - 1];
            engine.candles[engine.candles.length - 1] = {
              ...lastCandle,
              close: newRowIndex,
              time: elapsed,
            };
          }

          // 3. Hit Detection Logic (Mutates Engine Bets)
          let betChanged = false;
          let payout = 0;
          let newWins = 0;
          let newLosses = 0;

          engine.activeBets.forEach((bet) => {
            if (bet.isTriggered || bet.isLost) return;

            // Time check - Relaxed to 0.5s to match visual cell width (Center +/- 0.5s)
            // This ensures if the line passes ANYWHERE inside the cell, we check for vertical crossing.
            const timeDiff = Math.abs(elapsed - bet.timePoint);
            const isTimeMatching = timeDiff < 0.5;

            // Row Check - STRICT INTERSECTION LOGIC
            // We determine if the line segment (prevEngineRow -> newRowIndex) intersects with the bet's row.
            const minRow = Math.min(prevEngineRow, newRowIndex) - HIT_TOLERANCE;
            const maxRow = Math.max(prevEngineRow, newRowIndex) + HIT_TOLERANCE;

            // Check if the bet's specific row index falls within the movement range of this frame
            const isRowCrossed = bet.rowIndex >= minRow && bet.rowIndex <= maxRow;

            if (isTimeMatching && isRowCrossed) {
              bet.isTriggered = true;
              betChanged = true;
              payout += bet.amount * bet.targetMultiplier;
              newWins++;
            } else if (elapsed - bet.timePoint > 0.6) {
              // Loss Check - Only mark lost if we are definitively past the timePoint (with margin)
              bet.isLost = true;
              betChanged = true;
              newLosses++;
            }
          });

          // 4. Update React State (UI) - THROTTLED or ON EVENT
          frameCountRef.current++;

          // Force update if bets changed OR if it's the 6th frame (approx 10 FPS updates for UI text)
          // We always update on 6th frame to ensure Multiplier UI is fresh
          if (betChanged || frameCountRef.current % 6 === 0) {
            if (newWins > 0) playSound("win");
            if (newLosses > 0) playSound("lose");

            // 更新统计和历史
            if (newWins > 0) {
              setTotalWins((prev) => prev + newWins);
              // 更新历史记录中的胜利
              let totalWinPayout = 0;
              let maxMultiplier = 0;
              engine.activeBets.forEach((bet) => {
                if (bet.isTriggered) {
                  const betPayout = bet.amount * bet.targetMultiplier;
                  totalWinPayout += betPayout;
                  if (bet.targetMultiplier > maxMultiplier) {
                    maxMultiplier = bet.targetMultiplier;
                  }
                  setBetHistory((prev) => prev.map((h) => (h.id === bet.id ? { ...h, result: "win" as const, payout: betPayout } : h)));
                }
              });
              // 触发胜利庆祝动画
              if (totalWinPayout > 0) {
                setWinAmount(totalWinPayout);
                setWinMultiplier(maxMultiplier);
                setShowWinCelebration(true);
              }
            }
            if (newLosses > 0) {
              setTotalLosses((prev) => prev + newLosses);
              // 更新历史记录中的失败
              engine.activeBets.forEach((bet) => {
                if (bet.isLost) {
                  setBetHistory((prev) => prev.map((h) => (h.id === bet.id ? { ...h, result: "loss" as const, payout: bet.amount } : h)));
                }
              });
              // 触发失败动画
              setShowLoseAnimation(true);
            }

            // Update balance on win (根据模式更新对应余额)
            if (payout > 0) {
              setCurrentBalance((prev: number) => prev + payout);
            }

            setGameState((prev) => {
              // Streaks update logic
              let currentStreak = prev.streaks[selectedAsset] || { type: "NONE", count: 0 };
              if (newWins > 0) {
                currentStreak = currentStreak.type === "WIN" ? { type: "WIN", count: currentStreak.count + newWins } : { type: "WIN", count: newWins };
              }
              if (newLosses > 0) {
                currentStreak = currentStreak.type === "LOSS" ? { type: "LOSS", count: currentStreak.count + newLosses } : { type: "LOSS", count: newLosses };
              }

              return {
                ...prev,
                currentMultiplier: displayMultiplier,
                currentRowIndex: newRowIndex,
                // Note: We don't strictly need to copy candles to state for UI,
                // but we do it loosely so non-chart components might see it.
                // Ideally, UI shouldn't depend on heavy candle array.
                activeBets: [...engine.activeBets],
                balance: currentBalance + payout,
                sessionPL: prev.sessionPL + payout,
                streaks: { ...prev.streaks, [selectedAsset]: currentStreak },
              };
            });
          }
        }
      }

      animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [gameState.status, startPrice, playSound, selectedAsset, currentBalance, setCurrentBalance]);

  // Countdown
  useEffect(() => {
    if (gameState.status === GameStatus.WAITING && gameState.countdown > 0) {
      const t = setInterval(() => setGameState((prev) => ({ ...prev, countdown: prev.countdown - 1 })), 1000);
      return () => clearInterval(t);
    } else if (gameState.status === GameStatus.WAITING && gameState.countdown === 0) {
      startRound();
    }
  }, [gameState.status, gameState.countdown, startRound]);

  // Handles the initial click on the grid - IMMEDIATE BET
  const onBetRequest = useCallback(
    (multiplier: number, timePoint: number, rowIndex: number) => {
      if (engineRef.current.status === GameStatus.CRASHED) return;

      // 游玩模式不需要登录，真实模式需要登录
      if (!isPlayMode && !isLoggedIn) {
        showToast("请先登录 Linux DO 账号", "warning");
        return;
      }

      const currentTime = engineRef.current.currentTime;

      if (timePoint + 0.5 < currentTime) return;

      // Check duplicated bet in Engine Ref
      const exists = engineRef.current.activeBets.some((b) => b.rowIndex === rowIndex && Math.abs(b.timePoint - timePoint) < 0.1);
      if (exists) return;

      // Check Balance
      if (currentBalance < stakeAmount) {
        if (isPlayMode) {
          showToast("游玩余额不足，点击重置按钮恢复余额", "error");
        } else {
          showToast("LDC 余额不足，请先充值", "error");
        }
        return;
      }

      playSound("bet");

      const betId = Math.random().toString();
      const newBet: GridBet = {
        id: betId,
        targetMultiplier: multiplier,
        rowIndex: rowIndex,
        amount: stakeAmount,
        isTriggered: false,
        isLost: false,
        timePoint: timePoint,
      };

      // Update Engine Immediately
      engineRef.current.activeBets.push(newBet);

      // Update Balance (根据模式更新对应余额)
      setCurrentBalance((prev: number) => prev - stakeAmount);

      // 记录下注历史
      setTotalBets((prev) => prev + 1);
      setBetHistory((prev) => [
        ...prev,
        {
          id: betId,
          time: Date.now(),
          multiplier: multiplier,
          stake: stakeAmount,
          result: "pending" as const,
          payout: 0,
        },
      ]);

      // Update UI
      setGameState((prev) => ({
        ...prev,
        balance: currentBalance - stakeAmount,
        sessionPL: prev.sessionPL - stakeAmount,
        activeBets: [...prev.activeBets, newBet],
      }));
    },
    [currentBalance, setCurrentBalance, stakeAmount, playSound, isLoggedIn, isPlayMode, showToast]
  );

  const streak = gameState.streaks[selectedAsset] || { type: "NONE", count: 0 };

  // Base Price Logic: Use locked start price when running, or live price when waiting
  const currentBasePrice = gameState.status === GameStatus.RUNNING ? startPrice : latestPriceRef.current || 0;

  return (
    <div className="min-w-[1280px] min-h-[720px] h-screen w-full flex flex-col bg-[#0d0d12] text-white font-sans overflow-hidden">
      {/* Header */}
      <Header
        selectedAsset={selectedAsset}
        onAssetChange={setSelectedAsset}
        isGameRunning={gameState.status === GameStatus.RUNNING}
        isMusicPlaying={isMusicPlaying}
        onToggleMusic={toggleMusic}
        onOpenTutorial={() => setIsTutorialOpen(true)}
        realPrice={realPrice}
        connectionError={connectionError}
        sessionPL={gameState.sessionPL}
        streak={streak}
        ldcBalance={ldcBalance}
        playBalance={playBalance}
        isPlayMode={isPlayMode}
        onOpenRecharge={() => setIsRechargeModalOpen(true)}
      />

      {/* Main Game Interface */}
      <main className="flex-1 relative">
        <GameChart
          gameEngineRef={engineRef}
          onPlaceBet={onBetRequest}
          roundHash={gameState.roundHash}
          basePrice={currentBasePrice}
          startTime={startTimeRef.current || Date.now()} // Pass start time for X-Axis, fallback to now to avoid 1970
        />

        {/* Live Data Feed Ticker */}
        {lastTrade && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full flex items-center gap-6 shadow-2xl z-40 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-[9px] font-black text-white/50 uppercase tracking-wider">
                Stream <span className="text-yellow-400">⚡</span>
              </span>
            </div>
            <div className="flex gap-4 font-mono text-[10px]">
              <span className="text-gray-400">
                SYM: <span className="text-indigo-300 font-bold">{lastTrade.s}</span>
              </span>
              <span className="text-gray-400">
                PRC: <span className="text-white font-bold">{parseFloat(lastTrade.p).toFixed(2)}</span>
              </span>
              <span className="text-gray-400">
                VOL: <span className="text-white font-bold">{parseFloat(lastTrade.q).toFixed(5)}</span>
              </span>
            </div>
          </div>
        )}
      </main>

      {/* Control Footer */}
      <Footer
        stakeAmount={stakeAmount}
        onStakeChange={setStakeAmount}
        currentBalance={currentBalance}
        isPlayMode={isPlayMode}
        isLoggedIn={isLoggedIn}
        onToggleMode={toggleGameMode}
        onResetPlayBalance={resetPlayBalance}
        selectedAsset={selectedAsset}
        gameStatus={gameState.status}
        activeBetsCount={gameState.activeBets.length}
        isConnected={latestPriceRef.current > 0}
        connectionError={connectionError}
        onStartRound={startRound}
        onStopRound={handleCrash}
      />

      {/* 充值弹窗 */}
      <RechargeModal
        isOpen={isRechargeModalOpen}
        onClose={() => setIsRechargeModalOpen(false)}
        onSuccess={(amount) => {
          setLdcBalance((prev) => prev + amount);
          setIsRechargeModalOpen(false);
        }}
      />

      {/* 教程弹窗 */}
      <TutorialModal isOpen={isTutorialOpen} onClose={() => setIsTutorialOpen(false)} houseEdge={HOUSE_EDGE} />

      {/* 侧边统计面板 */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 w-56 space-y-4 z-30 pointer-events-auto">
        <GameStats totalBets={totalBets} totalWins={totalWins} totalLosses={totalLosses} sessionPL={gameState.sessionPL} houseEdge={HOUSE_EDGE} isPlayMode={isPlayMode} />
        <BetHistoryPanel history={betHistory} maxItems={5} />
      </div>

      {/* 动画效果 */}
      <WinCelebration isActive={showWinCelebration} amount={winAmount} multiplier={winMultiplier} onComplete={() => setShowWinCelebration(false)} />
      <LoseAnimation isActive={showLoseAnimation} onComplete={() => setShowLoseAnimation(false)} />
      <ModeSwitchOverlay isPlayMode={isPlayMode} />

      <style>{`
        @keyframes bounce-short {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .animate-bounce-short {
          animation: bounce-short 0.3s ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default App;
