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
  const [prefersReducedMotion] = useState(() => {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    return false;
  });

  useEffect(() => {
    if (!isActive) return;

    // 生成粒子 - 使用主题色
    const newParticles: ConfettiParticle[] = [];
    const colors = ["#10b981", "#22d3ee", "#8B5CF6", "#F59E0B", "#ef4444", "#3b82f6"];

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

  // Reduced Motion: 简化动画
  if (prefersReducedMotion) {
    return (
      <div className="fixed inset-0 pointer-events-none z-200 flex items-center justify-center">
        {showAmount && (
          <div className="bg-linear-to-r from-emerald-600 to-emerald-500 px-8 py-4 rounded-2xl shadow-2xl shadow-emerald-500/50 backdrop-blur-sm">
            <div className="text-center">
              <div className="text-white/80 text-sm font-heading font-bold mb-1">恭喜获胜！</div>
              <div className="text-white text-3xl font-heading font-black">+{amount.toFixed(2)} LDC</div>
              <div className="text-emerald-200 text-sm mt-1">{multiplier.toFixed(2)}x 倍率</div>
            </div>
          </div>
        )}
      </div>
    );
  }

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
          <div className="bg-linear-to-r from-emerald-600 to-emerald-500 px-8 py-4 rounded-2xl shadow-2xl shadow-emerald-500/50 backdrop-blur-sm">
            <div className="text-center">
              <div className="text-white/80 text-sm font-heading font-bold mb-1">恭喜获胜！</div>
              <div className="text-white text-3xl font-heading font-black">+{amount.toFixed(2)} LDC</div>
              <div className="text-emerald-200 text-sm mt-1">{multiplier.toFixed(2)}x 倍率</div>
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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(onComplete, 800);
    return () => clearTimeout(timer);
  }, [isActive, onComplete]);

  if (!isActive) return null;

  if (prefersReducedMotion) {
    return (
      <div className="fixed pointer-events-none z-150" style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}>
        <div className="bg-cta text-white px-3 py-1 rounded-full text-xs font-heading font-bold shadow-lg shadow-cta/30">-{amount.toFixed(2)} LDC</div>
      </div>
    );
  }

  return (
    <div className="fixed pointer-events-none z-150 animate-bet-placed" style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}>
      <div className="relative">
        {/* 波纹效果 */}
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cta animate-ripple" />
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary animate-ripple" style={{ animationDelay: "0.1s" }} />
        <div className="absolute inset-0 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-400 animate-ripple" style={{ animationDelay: "0.2s" }} />

        {/* 金额标签 */}
        <div className="bg-cta text-white px-3 py-1 rounded-full text-xs font-heading font-bold shadow-lg shadow-cta/30 animate-float-up">-{amount.toFixed(2)} LDC</div>
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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

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

  if (prefersReducedMotion) {
    return (
      <div className="fixed inset-0 pointer-events-none z-100 flex items-center justify-center">
        <div className={`px-8 py-4 rounded-2xl ${isPlayMode ? "bg-cta" : "bg-primary"} shadow-2xl backdrop-blur-sm`}>
          <div className="text-white text-xl font-heading font-black flex items-center gap-3">
            {isPlayMode ? (
              <>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>游玩模式</span>
              </>
            ) : (
              <>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>真实模式</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-100">
      <div className={`absolute inset-0 animate-mode-flash ${isPlayMode ? "bg-cta/20" : "bg-primary/20"}`} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-mode-text">
        <div className={`px-8 py-4 rounded-2xl ${isPlayMode ? "bg-cta" : "bg-primary"} shadow-2xl backdrop-blur-sm`}>
          <div className="text-white text-xl font-heading font-black flex items-center gap-3">
            {isPlayMode ? (
              <>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>游玩模式</span>
              </>
            ) : (
              <>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(onComplete, 1000);
    return () => clearTimeout(timer);
  }, [isActive, onComplete]);

  if (!isActive) return null;

  if (prefersReducedMotion) {
    return <div className="fixed inset-0 pointer-events-none z-150 bg-red-500/5" />;
  }

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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

  if (type === "NONE" || count < 2) return null;

  const isWin = type === "WIN";

  return (
    <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-heading font-black ${prefersReducedMotion ? "" : "animate-streak-pulse"} ${isWin ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-red-500/20 text-red-400 border border-red-500/30"}`}>
      {isWin ? (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
        </svg>
      )}
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
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <span className={`inline-block ml-2 text-sm font-heading font-bold ${prefersReducedMotion ? "" : "animate-balance-change"} ${isPositive ? "text-green-400" : "text-red-400"}`}>
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
