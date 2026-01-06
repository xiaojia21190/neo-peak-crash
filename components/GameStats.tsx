"use client";

import React from "react";

interface GameStatsProps {
  totalBets: number;
  totalWins: number;
  totalLosses: number;
  sessionPL: number;
  houseEdge: number;
  isPlayMode: boolean;
}

export function GameStats({ totalBets, totalWins, totalLosses, sessionPL, houseEdge, isPlayMode }: GameStatsProps) {
  const winRate = totalBets > 0 ? ((totalWins / totalBets) * 100).toFixed(1) : "0.0";
  const lossRate = totalBets > 0 ? ((totalLosses / totalBets) * 100).toFixed(1) : "0.0";
  const theoreticalHouseWinRate = ((1 - 1 / (1 + houseEdge)) * 100).toFixed(1);

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-wider">本轮统计</h3>
        {isPlayMode && <span className="text-[8px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full font-bold">🎮 游玩模式</span>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* 总下注 */}
        <div className="bg-white/5 rounded-xl p-3">
          <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">总下注</div>
          <div className="text-lg font-black text-white">{totalBets}</div>
        </div>

        {/* 胜率 */}
        <div className="bg-white/5 rounded-xl p-3">
          <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">胜率</div>
          <div className="text-lg font-black text-green-400">{winRate}%</div>
        </div>

        {/* 胜/负 */}
        <div className="bg-white/5 rounded-xl p-3">
          <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">胜 / 负</div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-green-400">{totalWins}</span>
            <span className="text-gray-500">/</span>
            <span className="text-sm font-black text-red-400">{totalLosses}</span>
          </div>
        </div>

        {/* 盈亏 */}
        <div className="bg-white/5 rounded-xl p-3">
          <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">盈亏</div>
          <div className={`text-lg font-black ${sessionPL >= 0 ? "text-green-400" : "text-red-400"}`}>
            {sessionPL >= 0 ? "+" : ""}
            {sessionPL.toFixed(2)}
          </div>
        </div>
      </div>

      {/* 庄家优势提示 */}
      <div className="mt-3 bg-red-500/5 border border-red-500/10 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="flex-1">
            <div className="text-[9px] text-red-400 font-bold">庄家优势</div>
            <div className="text-[10px] text-gray-400">
              理论抽水率 <span className="text-red-400 font-bold">{(houseEdge * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
