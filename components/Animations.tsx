"use client";

import React, { useEffect, useState } from "react";

// 胜利庆祝粒子效果
interface ConfettiParticle {
  id: number;
  x: number;
  y: number;
  color: string;
  rotation: number;
  scale: number;
  velocityX: number;
  velocityY: number;
}

interface WinCelebrationProps {
  isActive: boolean;
  amount: number;
  multiplier: number;
  onComplete: () => void;
}

export function WinCelebration({ isActive, amount, multiplier, onComplete }: WinCelebrationProps) {
  const [particles, setParticles] = useState<ConfettiParticle[]>([]);
  const [showAmount, setShowAmount] = useState(false);

  useEffect(() => {
    if (!isActive) return;

    // 生成粒子
    const newParticles: ConfettiParticle[] = [];
    const colors = ["#10b981", "#22d3ee", "#a855f7", "#f59e0b", "#ef4444", "#3b82f6"];

    for (let i = 0; i < 50; i++) {
      newParticles.push({
        id: i,
        x: 50 + Math.random() * 20 - 10,
        y: 50,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        scale: 0.5 + Math.random() * 0.5,
        velocityX: (Math.random() - 0.5) * 15,
        velocityY: -10 - Math.random() * 10,
      });
    }

    setParticles(newParticles);
    setShowAmount(true);

    // 清理
    const timer = setTimeout(() => {
      setParticles([]);
      setShowAmount(false);
      onComplete();
    }, 2500);

    return () => clearTimeout(timer);
  }, [isActive, onComplete]);

  if (!isActive && particles.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-200">
      {/* 粒子效果 */}
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="absolute w-3 h-3 animate-confetti"
          style={
            {
              left: `${particle.x}%`,
              top: `${particle.y}%`,
              backgroundColor: particle.color,
              transform: `rotate(${particle.rotation}deg) scale(${particle.scale})`,
              "--vx": `${particle.velocityX}vw`,
              "--vy": `${particle.velocityY}vh`,
            } as React.CSSProperties
          }
        />
      ))}

      {/* 金额显示 */}
      {showAmount && (
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-win-popup">
          <div className="bg-linear-to-r from-green-600 to-emerald-500 px-8 py-4 rounded-2xl shadow-2xl shadow-green-500/50">
            <div className="text-center">
              <div className="text-white/80 text-sm font-bold mb-1">🎉 恭喜获胜！</div>
              <div className="text-white text-3xl font-black">+{amount.toFixed(2)} LDC</div>
              <div className="text-green-200 text-sm mt-1">{multiplier.toFixed(2)}x 倍率</div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes confetti {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateX(var(--vx)) translateY(calc(var(--vy) + 100vh)) rotate(720deg);
            opacity: 0;
          }
        }
        .animate-confetti {
          animation: confetti 2.5s ease-out forwards;
        }
        @keyframes win-popup {
          0% {
            transform: translate(-50%, -50%) scale(0);
            opacity: 0;
          }
          20% {
            transform: translate(-50%, -50%) scale(1.2);
            opacity: 1;
          }
          40% {
            transform: translate(-50%, -50%) scale(1);
          }
          80% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
          }
          100% {
            transform: translate(-50%, -50%) scale(0.8);
            opacity: 0;
          }
        }
        .animate-win-popup {
          animation: win-popup 2.5s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

// 下注成功动画
interface BetPlacedAnimationProps {
  isActive: boolean;
  x: number;
  y: number;
  amount: number;
  onComplete: () => void;
}

export function BetPlacedAnimation({ isActive, x, y, amount, onComplete }: BetPlacedAnimationProps) {
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(onComplete, 800);
    return () => clearTimeout(timer);
  }, [isActive, onComplete]);

  if (!isActive) return null;

  return (
    <div className="fixed pointer-events-none z-150 animate-bet-placed" style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}>
      <div className="relative">
        {/* 波纹效果 */}
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-indigo-500 animate-ripple" />
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-indigo-400 animate-ripple" style={{ animationDelay: "0.1s" }} />
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-indigo-300 animate-ripple" style={{ animationDelay: "0.2s" }} />

        {/* 金额标签 */}
        <div className="bg-indigo-600 text-white px-3 py-1 rounded-full text-xs font-bold shadow-lg shadow-indigo-500/50 animate-float-up">-{amount.toFixed(2)} LDC</div>
      </div>

      <style jsx>{`
        @keyframes ripple {
          0% {
            transform: translate(-50%, -50%) scale(0);
            opacity: 1;
          }
          100% {
            transform: translate(-50%, -50%) scale(2);
            opacity: 0;
          }
        }
        .animate-ripple {
          animation: ripple 0.8s ease-out forwards;
        }
        @keyframes float-up {
          0% {
            transform: translateY(0);
            opacity: 1;
          }
          100% {
            transform: translateY(-30px);
            opacity: 0;
          }
        }
        .animate-float-up {
          animation: float-up 0.8s ease-out forwards;
        }
        @keyframes bet-placed {
          0% {
            transform: translate(-50%, -50%) scale(0.5);
          }
          50% {
            transform: translate(-50%, -50%) scale(1.1);
          }
          100% {
            transform: translate(-50%, -50%) scale(1);
          }
        }
        .animate-bet-placed {
          animation: bet-placed 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}

// 模式切换动画
interface ModeSwitchAnimationProps {
  isPlayMode: boolean;
}

export function ModeSwitchOverlay({ isPlayMode }: ModeSwitchAnimationProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  const [prevMode, setPrevMode] = useState(isPlayMode);

  useEffect(() => {
    if (prevMode !== isPlayMode) {
      setIsAnimating(true);
      const timer = setTimeout(() => {
        setIsAnimating(false);
        setPrevMode(isPlayMode);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isPlayMode, prevMode]);

  if (!isAnimating) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-100">
      <div className={`absolute inset-0 animate-mode-flash ${isPlayMode ? "bg-purple-500/20" : "bg-yellow-500/20"}`} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-mode-text">
        <div className={`px-8 py-4 rounded-2xl ${isPlayMode ? "bg-purple-600" : "bg-yellow-600"} shadow-2xl`}>
          <div className="text-white text-xl font-black flex items-center gap-3">
            {isPlayMode ? (
              <>
                <span className="text-2xl">🎮</span>
                <span>游玩模式</span>
              </>
            ) : (
              <>
                <span className="text-2xl">⚡</span>
                <span>真实模式</span>
              </>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes mode-flash {
          0% {
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }
        .animate-mode-flash {
          animation: mode-flash 0.5s ease-out forwards;
        }
        @keyframes mode-text {
          0% {
            transform: translate(-50%, -50%) scale(0.5);
            opacity: 0;
          }
          30% {
            transform: translate(-50%, -50%) scale(1.1);
            opacity: 1;
          }
          70% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
          }
          100% {
            transform: translate(-50%, -50%) scale(0.8);
            opacity: 0;
          }
        }
        .animate-mode-text {
          animation: mode-text 0.5s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

// 失败动画
interface LoseAnimationProps {
  isActive: boolean;
  onComplete: () => void;
}

export function LoseAnimation({ isActive, onComplete }: LoseAnimationProps) {
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(onComplete, 1000);
    return () => clearTimeout(timer);
  }, [isActive, onComplete]);

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-150">
      <div className="absolute inset-0 bg-red-500/10 animate-lose-flash" />

      <style jsx>{`
        @keyframes lose-flash {
          0%,
          100% {
            opacity: 0;
          }
          25%,
          75% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
        .animate-lose-flash {
          animation: lose-flash 0.5s ease-out;
        }
      `}</style>
    </div>
  );
}

// 连胜动画
interface StreakAnimationProps {
  count: number;
  type: "WIN" | "LOSS" | "NONE";
}

export function StreakBadge({ count, type }: StreakAnimationProps) {
  if (type === "NONE" || count < 2) return null;

  const isWin = type === "WIN";

  return (
    <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-black animate-streak-pulse ${isWin ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
      {isWin ? "🔥" : "💀"}
      <span>
        {count}连{isWin ? "胜" : "败"}
      </span>

      <style jsx>{`
        @keyframes streak-pulse {
          0%,
          100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.05);
          }
        }
        .animate-streak-pulse {
          animation: streak-pulse 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

// 余额变化动画
interface BalanceChangeProps {
  amount: number;
  isPositive: boolean;
}

export function BalanceChangeIndicator({ amount, isPositive }: BalanceChangeProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <span className={`inline-block ml-2 text-sm font-bold animate-balance-change ${isPositive ? "text-green-400" : "text-red-400"}`}>
      {isPositive ? "+" : "-"}
      {Math.abs(amount).toFixed(2)}

      <style jsx>{`
        @keyframes balance-change {
          0% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(-20px);
          }
        }
        .animate-balance-change {
          animation: balance-change 1.5s ease-out forwards;
        }
      `}</style>
    </span>
  );
}
