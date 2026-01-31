"use client";

import React, { memo } from "react";
import { GameStatus } from "@/app/types";
import { UserMenu } from "@/components/UserMenu";
import { StreakBadge } from "@/components/Animations";

interface HeaderProps {
  // 资产选择
  selectedAsset: string;
  onAssetChange: (asset: string) => void;
  isGameRunning: boolean;

  // 音乐控制
  isMusicPlaying: boolean;
  onToggleMusic: () => void;

  // 帮助
  onOpenTutorial: () => void;

  // 价格显示
  realPrice: number;
  connectionError: string | null;

  // 盈亏
  sessionPL: number;
  streak: { type: string; count: number };

  // 用户
  ldcBalance: number;
  playBalance: number;
  isPlayMode: boolean;
  onOpenRecharge: () => void;
}

// 服务端目前只支持 BTC，暂时隐藏其他资产
const ASSETS = ["BTC"];

const getAssetName = (symbol: string) => {
  switch (symbol) {
    case "BTC":
      return "Bitcoin";
    case "ETH":
      return "Ethereum";
    case "SOL":
      return "Solana";
    case "XRP":
      return "Ripple";
    case "DOGE":
      return "Dogecoin";
    default:
      return symbol;
  }
};

export const Header = memo(function Header({ selectedAsset, onAssetChange, isGameRunning, isMusicPlaying, onToggleMusic, onOpenTutorial, realPrice, connectionError, sessionPL, streak, ldcBalance, playBalance, isPlayMode, onOpenRecharge }: HeaderProps) {
  return (
    <header className="flex justify-between items-center px-4 py-3 md:px-8 md:py-4 bg-background-dark border-b border-border-dark z-50 shadow-glass sticky top-0 md:relative">
      <div className="flex items-center gap-2 md:gap-10">
        {/* Logo */}
        <div className="flex items-center gap-2 group cursor-pointer">
          <div className="w-9 h-9 bg-cta rounded-xl flex items-center justify-center shadow-neon-purple group-hover:bg-cta-light transition-colors duration-200">
            <span className="font-black text-xs italic">P</span>
          </div>
          <span className="font-heading font-black text-xs tracking-[0.2em] uppercase italic opacity-80">PingooTread</span>
        </div>

        {/* Asset Selector - Desktop Only for now */}
        <nav className="hidden md:flex gap-2 p-1.5 glass rounded-2xl">
          {ASSETS.map((asset) => (
            <button
              key={asset}
              onClick={() => !isGameRunning && onAssetChange(asset)}
              disabled={isGameRunning}
              className={`text-[9px] font-heading font-black px-5 py-2 rounded-xl transition-colors duration-200 cursor-pointer ${selectedAsset === asset ? "bg-cta text-white shadow-neon-purple" : "text-text-muted hover:text-text hover:bg-white/5"} ${isGameRunning ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {asset}
            </button>
          ))}
        </nav>

        {/* Music Toggle - Desktop */}
        <button onClick={onToggleMusic} className={`hidden md:flex items-center gap-2 px-4 py-2 rounded-xl border transition-colors duration-200 cursor-pointer ${isMusicPlaying ? "bg-cta/10 border-cta/30 text-cta" : "glass text-text-muted hover:text-text hover:bg-white/10"}`}>
          {isMusicPlaying ? (
            <>
              <div className="flex gap-0.5 items-end h-3">
                <span className="w-0.5 bg-cta h-2 animate-[bounce_0.8s_infinite]"></span>
                <span className="w-0.5 bg-cta h-3 animate-[bounce_1.2s_infinite]"></span>
                <span className="w-0.5 bg-cta h-1.5 animate-[bounce_0.6s_infinite]"></span>
              </div>
              <span className="text-[9px] font-heading font-black uppercase tracking-wider">Music ON</span>
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
              <span className="text-[9px] font-heading font-black uppercase tracking-wider">Muted</span>
            </>
          )}
        </button>

        {/* Help Button - Desktop */}
        <button onClick={onOpenTutorial} className="hidden md:flex items-center gap-2 px-4 py-2 rounded-xl border glass text-text-muted hover:text-text hover:bg-white/10 transition-colors duration-200 cursor-pointer">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[9px] font-heading font-black uppercase tracking-wider">帮助</span>
        </button>
      </div>

      <div className="flex items-center gap-3 md:gap-10">
        {/* Price Display */}
        <div className="hidden md:flex flex-col items-end">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[8px] text-text-dark font-bold uppercase tracking-widest">{getAssetName(selectedAsset)} / USD</span>
            <button disabled={true} className={`text-[8px] px-1.5 py-0.5 rounded uppercase tracking-wider font-heading font-black transition-colors ${connectionError ? "bg-red-500/20 text-red-400 border border-red-500/30" : "glass text-text-muted opacity-60 cursor-default"}`}>
              BYBIT {connectionError ? "(!)" : ""}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-heading font-black mono">{connectionError ? "CONNECTION ERR" : realPrice > 0 ? `$${realPrice.toFixed(2)}` : "CONNECTING..."}</span>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${connectionError ? "bg-red-500" : realPrice > 0 ? "bg-neon-green animate-pulse-slow" : "bg-yellow-500"} `}></span>
              <span className={`text-[9px] font-heading font-bold ${connectionError ? "text-red-500" : realPrice > 0 ? "text-neon-green" : "text-yellow-500"}`}>{connectionError ? "BLOCKED" : realPrice > 0 ? "REAL-TIME" : "WAIT"}</span>
            </div>
          </div>
        </div>

        <div className="hidden md:block h-8 w-px bg-border-dark"></div>

        {/* Session P/L - Compact on mobile */}
        <div className="flex flex-col items-end">
          <span className="hidden md:inline text-[8px] text-text-dark font-bold uppercase tracking-widest mb-1">Session P/L</span>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-heading font-black mono ${sessionPL >= 0 ? "text-neon-green" : "text-red-500"}`}>
              {sessionPL >= 0 ? "+" : ""}
              {sessionPL.toFixed(2)} LDC
            </span>
            <StreakBadge count={streak.count} type={streak.type as "WIN" | "LOSS" | "NONE"} />
          </div>
        </div>

        {/* User Menu */}
        <UserMenu ldcBalance={ldcBalance} onRecharge={onOpenRecharge} isPlayMode={isPlayMode} playBalance={playBalance} />
      </div>
    </header>
  );
});
