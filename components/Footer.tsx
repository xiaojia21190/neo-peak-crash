"use client";

import React, { memo } from "react";
import { GameStatus } from "@/app/types";

interface FooterProps {
  // 下注金额
  stakeAmount: number;
  onStakeChange: (amount: number) => void;
  currentBalance: number;

  // 模式
  isPlayMode: boolean;
  isLoggedIn: boolean;
  onToggleMode: () => void;
  onResetPlayBalance: () => void;
  selectedAsset: string;

  // 游戏状态
  gameStatus: GameStatus;
  activeBetsCount: number;
  isConnected: boolean;
  connectionError: string | null;

  // 操作
  onStartRound: () => void;
  onStopRound: () => void;
}

const QUICK_AMOUNTS = [1, 5, 10, 50, 100];

export const Footer = memo(function Footer({ stakeAmount, onStakeChange, currentBalance, isPlayMode, isLoggedIn, onToggleMode, onResetPlayBalance, selectedAsset, gameStatus, activeBetsCount, isConnected, connectionError, onStartRound, onStopRound }: FooterProps) {
  const isRunning = gameStatus === GameStatus.RUNNING;
  const isCrashed = gameStatus === GameStatus.CRASHED;
  const isWaiting = gameStatus === GameStatus.WAITING;

  return (
    <footer className="h-28 bg-[#0F172A] border-t border-slate-700/30 flex items-center px-14 justify-between z-50 shadow-2xl backdrop-blur-sm">
      <div className="flex gap-16">
        {/* Stake Amount */}
        <div className="flex flex-col gap-2.5">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Stake Amount</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onStakeChange(Math.max(1, stakeAmount - 1))}
              className="w-8 h-8 bg-slate-800/50 rounded-lg border border-slate-700/50 hover:bg-slate-700/50 hover:border-slate-600 transition-all duration-200 flex items-center justify-center text-slate-400 hover:text-slate-200 font-black text-sm"
            >
              −
            </button>
            <div className="bg-slate-800/50 border border-slate-700/50 px-4 py-2 rounded-xl font-mono font-black text-sm min-w-25 text-center shadow-inner text-amber-400">{stakeAmount.toFixed(2)} LDC</div>
            <button
              onClick={() => onStakeChange(stakeAmount + 1)}
              className="w-8 h-8 bg-slate-800/50 rounded-lg border border-slate-700/50 hover:bg-slate-700/50 hover:border-slate-600 transition-all duration-200 flex items-center justify-center text-slate-400 hover:text-slate-200 font-black text-sm"
            >
              +
            </button>
          </div>
          {/* Quick Bet Buttons */}
          <div className="flex gap-1">
            {QUICK_AMOUNTS.map((amount) => (
              <button key={amount} onClick={() => onStakeChange(amount)} className={`px-2 py-1 text-[8px] font-bold rounded-lg transition-all ${stakeAmount === amount ? "bg-indigo-600 text-white" : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white"}`}>
                {amount}
              </button>
            ))}
            <button onClick={() => onStakeChange(Math.floor(currentBalance))} className="px-2 py-1 text-[8px] font-bold rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
              MAX
            </button>
          </div>
        </div>

        {/* Balance Display */}
        <div className="flex flex-col gap-2.5">
          <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">{isPlayMode ? "Play Balance" : "LDC Balance"}</span>
          <div className={`flex items-center gap-3 ${isPlayMode ? "bg-purple-500/10 border-purple-500/20" : "bg-yellow-500/10 border-yellow-500/20"} border px-5 py-2.5 rounded-2xl`}>
            <svg className={`w-5 h-5 ${isPlayMode ? "text-purple-400" : "text-yellow-400"}`} fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z" />
            </svg>
            <span className={`text-lg font-black ${isPlayMode ? "text-purple-400" : "text-yellow-400"}`}>{currentBalance.toFixed(2)}</span>
            {isPlayMode && (
              <button onClick={onResetPlayBalance} className="text-[8px] text-purple-300 hover:text-purple-100 underline" title="重置游玩余额">
                重置
              </button>
            )}
            {!isPlayMode && !isLoggedIn && <span className="text-[8px] text-gray-500">未登录</span>}
          </div>
        </div>

        {/* Game Mode */}
        <div className="flex flex-col gap-2.5">
          <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">Game Mode</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleMode}
              disabled={isRunning}
              className={`flex items-center gap-3 px-5 py-2.5 rounded-2xl transition-all ${isPlayMode ? "bg-purple-500/10 border border-purple-500/20 text-purple-400" : "bg-indigo-500/10 border border-indigo-500/20 text-indigo-400"} ${
                isRunning ? "opacity-50 cursor-not-allowed" : "hover:opacity-80 cursor-pointer"
              }`}
            >
              {isPlayMode ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              )}
              <span className="text-[10px] font-heading font-black uppercase italic tracking-wider">{isPlayMode ? "游玩模式" : `${selectedAsset} / 真实模式`}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-20">
        {/* Active Risk */}
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">Active Risk</span>
          <span className="text-3xl font-black text-yellow-400 mono tracking-tighter shadow-yellow-400/10 drop-shadow-lg">${(activeBetsCount * stakeAmount).toFixed(2)}</span>
        </div>

        {/* Start/Stop Button */}
        <button
          onClick={isRunning ? onStopRound : onStartRound}
          disabled={isCrashed}
          className={`px-16 h-14 rounded-2xl font-black text-xs uppercase italic tracking-[0.25em] transition-all shadow-2xl relative overflow-hidden group ${
            !isConnected
              ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/40 active:scale-95"
              : isRunning
                ? "bg-red-600 hover:bg-red-500 text-white shadow-red-600/40 active:scale-95"
                : isCrashed
                  ? "bg-red-900/50 text-red-300 border border-red-900 cursor-not-allowed"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/40 active:scale-95"
          }`}
        >
          {!isConnected ? (
            connectionError ? (
              "开始游戏"
            ) : (
              "开始游戏"
            )
          ) : isRunning ? (
            <>
              <span className="relative z-10">Stop Cycle</span>
              <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            </>
          ) : isCrashed ? (
            "MARKET FAILURE"
          ) : isWaiting ? (
            <>
              <span className="relative z-10">Start Cycle</span>
              <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            </>
          ) : (
            "Tracking Market"
          )}
        </button>
      </div>
    </footer>
  );
});
