"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSession } from "next-auth/react";
import { GameStatus } from "./types";
import { COUNTDOWN_TIME, CENTER_ROW_INDEX, calculateMultiplier, HOUSE_EDGE } from "./constants";
import GameChart from "@/components/GameChart";
import { RechargeModal } from "@/components/RechargeModal";
import { useToast } from "@/components/Toast";
import { TutorialModal } from "@/components/TutorialModal";
import { GameStats } from "@/components/GameStats";
import { BetHistoryPanel } from "@/components/BetHistoryPanel";
import { WinCelebration, ModeSwitchOverlay, LoseAnimation } from "@/components/Animations";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAudio, useServerGameAdapter } from "@/hooks";

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

  // 音频控制
  const { isMusicPlaying, toggleMusic, playSound } = useAudio();

  // 下注金额
  const [stakeAmount, setStakeAmount] = useState<number>(5.0);

  // 服务端游戏适配层 - 替代本地引擎
  const {
    gameEngineRef,
    gameStatus,
    countdown,
    roundHash,
    serverSeed,
    basePrice,
    startTime,
    onPlaceBet,
    isPlayMode,
    ldcBalance,
    playBalance,
    currentBalance,
    setCurrentBalance,
    toggleGameMode,
    resetPlayBalance,
    isRechargeModalOpen,
    setIsRechargeModalOpen,
    setLdcBalance,
    connected,
    connecting,
    connectionError,
    activeBetsCount,
    sessionPL,
    history,
    connect,
    disconnect,
  } = useServerGameAdapter({
    userId: user?.id,
    isLoggedIn,
    showToast,
    stakeAmount,
  });

  // 资产选择（服务端目前固定 BTC）
  const [selectedAsset] = useState<string>("BTC");

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
      const timer = setTimeout(() => {
        setIsTutorialOpen(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  // 监听投注结果并更新统计
  const prevBetsRef = useRef(gameEngineRef.current.activeBets);
  useEffect(() => {
    const currentBets = gameEngineRef.current.activeBets;
    const prevBets = prevBetsRef.current;

    currentBets.forEach((bet) => {
      const prevBet = prevBets.find((b) => b.id === bet.id);
      if (!prevBet) return;

      // 检测胜利
      if (!prevBet.isTriggered && bet.isTriggered) {
        playSound("win");
        setTotalWins((prev) => prev + 1);
        const payout = bet.amount * bet.targetMultiplier;
        setWinAmount(payout);
        setWinMultiplier(bet.targetMultiplier);
        setShowWinCelebration(true);
        setBetHistory((prev) => prev.map((h) => (h.id === bet.id ? { ...h, result: "win" as const, payout } : h)));
      }

      // 检测失败
      if (!prevBet.isLost && bet.isLost) {
        playSound("lose");
        setTotalLosses((prev) => prev + 1);
        setShowLoseAnimation(true);
        setBetHistory((prev) => prev.map((h) => (h.id === bet.id ? { ...h, result: "loss" as const, payout: 0 } : h)));
      }
    });

    prevBetsRef.current = currentBets;
  }, [gameEngineRef.current.activeBets, playSound]);

  // 处理下注请求
  const handlePlaceBet = useCallback(
    (multiplier: number, timePoint: number, rowIndex: number) => {
      if (gameStatus === GameStatus.CRASHED) return;

      // 游玩模式不需要登录，真实模式需要登录
      if (!isPlayMode && !isLoggedIn) {
        showToast("请先登录 Linux DO 账号", "warning");
        return;
      }

      // 检查余额
      if (currentBalance < stakeAmount) {
        if (isPlayMode) {
          showToast("游玩余额不足，点击重置按钮恢复余额", "error");
        } else {
          showToast("LDC 余额不足，请先充值", "error");
        }
        return;
      }

      playSound("bet");

      // 记录下注历史
      const betId = `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

      // 调用服务端下注
      onPlaceBet(multiplier, timePoint, rowIndex);
    },
    [gameStatus, isPlayMode, isLoggedIn, currentBalance, stakeAmount, playSound, showToast, onPlaceBet],
  );

  // 连接状态文本
  const connectionStatusText = useMemo(() => {
    if (connecting) return "连接中...";
    if (connectionError) return connectionError;
    if (!connected) return "未连接";
    return null;
  }, [connected, connecting, connectionError]);

  // Streak 计算
  const streak = useMemo(() => {
    const recentResults = betHistory.slice(-10).filter((b) => b.result !== "pending");
    if (recentResults.length === 0) return { type: "NONE" as const, count: 0 };

    const lastResult = recentResults[recentResults.length - 1]?.result;
    let count = 0;
    for (let i = recentResults.length - 1; i >= 0; i--) {
      if (recentResults[i].result === lastResult) {
        count++;
      } else {
        break;
      }
    }
    return {
      type: lastResult === "win" ? ("WIN" as const) : ("LOSS" as const),
      count,
    };
  }, [betHistory]);

  // 当前显示价格（从 gameEngineRef 获取）
  const currentDisplayPrice = basePrice || 0;

  return (
    <div className="min-w-7xl min-h-180 h-screen w-full flex flex-col bg-[#0d0d12] text-white font-sans overflow-hidden">
      {/* Header */}
      <Header
        selectedAsset={selectedAsset}
        onAssetChange={() => {}} // 服务端固定资产，暂不支持切换
        isGameRunning={gameStatus === GameStatus.RUNNING}
        isMusicPlaying={isMusicPlaying}
        onToggleMusic={toggleMusic}
        onOpenTutorial={() => setIsTutorialOpen(true)}
        realPrice={currentDisplayPrice}
        connectionError={connectionStatusText}
        sessionPL={sessionPL}
        streak={streak}
        ldcBalance={ldcBalance}
        playBalance={playBalance}
        isPlayMode={isPlayMode}
        onOpenRecharge={() => setIsRechargeModalOpen(true)}
      />

      {/* Main Game Interface */}
      <main className="flex-1 relative">
        <GameChart gameEngineRef={gameEngineRef} onPlaceBet={handlePlaceBet} roundHash={roundHash} basePrice={currentDisplayPrice} startTime={startTime || Date.now()} />

        {/* 连接状态指示器 */}
        {(connecting || connectionError) && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full flex items-center gap-6 shadow-2xl z-40 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${connecting ? "bg-yellow-500" : "bg-red-500"} animate-pulse`}></div>
              <span className="text-[9px] font-heading font-black text-white/50 uppercase tracking-wider">{connecting ? "连接服务器中..." : connectionError || "连接断开"}</span>
            </div>
          </div>
        )}

        {/* Provably Fair 信息 */}
        {serverSeed && (
          <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md border border-green-500/30 px-4 py-2 rounded-lg z-40 pointer-events-none">
            <div className="text-[9px] text-green-400 font-mono">✓ Server Seed Revealed</div>
            <div className="text-[8px] text-gray-400 font-mono truncate max-w-50">{serverSeed}</div>
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
        gameStatus={gameStatus}
        activeBetsCount={activeBetsCount}
        isConnected={connected}
        connectionError={connectionStatusText}
        onStartRound={() => {
          if (!connected && !connecting) {
            connect(); // 首次点击时建立连接
          }
        }}
        onStopRound={() => {}} // 服务端自动管理回合
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
        <GameStats totalBets={totalBets} totalWins={totalWins} totalLosses={totalLosses} sessionPL={sessionPL} houseEdge={HOUSE_EDGE} isPlayMode={isPlayMode} />
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
