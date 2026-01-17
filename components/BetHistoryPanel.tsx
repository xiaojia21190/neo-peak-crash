"use client";

import React, { useEffect, useState } from "react";

interface BetHistoryItem {
  id: string;
  time: number;
  multiplier: number;
  stake: number;
  result: "win" | "loss" | "pending";
  payout: number;
}

interface BetHistoryPanelProps {
  history: BetHistoryItem[];
  maxItems?: number;
}

export function BetHistoryPanel({ history, maxItems = 10 }: BetHistoryPanelProps) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);
  }, []);

  const displayHistory = history.slice(-maxItems).reverse();

  if (displayHistory.length === 0) {
    return (
      <div className="glass border-border-dark/30 rounded-2xl p-4">
        <h3 className="text-[10px] font-heading font-black text-slate-400 uppercase tracking-wider mb-3">下注历史</h3>
        <div className="text-center py-6">
          <div className="text-slate-500 text-sm font-body">暂无下注记录</div>
          <div className="text-slate-600 text-xs font-body mt-1">开始游戏后将显示历史</div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass border-border-dark/30 rounded-2xl p-4">
      <h3 className="text-[10px] font-heading font-black text-slate-400 uppercase tracking-wider mb-3">下注历史</h3>

      <div className="space-y-2 max-h-50 overflow-y-auto custom-scrollbar">
        {displayHistory.map((item) => (
          <div
            key={item.id}
            className={`flex items-center justify-between p-2 rounded-xl transition-colors duration-200 ${item.result === "win" ? "bg-green-500/10 border border-green-500/20" : item.result === "loss" ? "bg-red-500/10 border border-red-500/20" : "bg-primary/10 border border-primary/20"}`}
          >
            <div className="flex items-center gap-3">
              {/* 结果图标 */}
              <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${item.result === "win" ? "bg-green-500/20" : item.result === "loss" ? "bg-red-500/20" : "bg-primary/20"}`}>
                {item.result === "win" ? (
                  <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                  </svg>
                ) : item.result === "loss" ? (
                  <svg className="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <div className={`w-2 h-2 bg-primary rounded-full ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                )}
              </div>

              {/* 倍率 */}
              <div>
                <div className="text-xs font-heading font-bold text-text-primary">{item.multiplier.toFixed(2)}x</div>
                <div className="text-[9px] font-body text-slate-500">下注 {item.stake.toFixed(2)}</div>
              </div>
            </div>

            {/* 盈亏 */}
            <div className="text-right">
              <div className={`text-sm font-heading font-black ${item.result === "win" ? "text-green-400" : item.result === "loss" ? "text-red-400" : "text-primary"}`}>
                {item.result === "win" ? "+" : item.result === "loss" ? "-" : ""}
                {item.result === "pending" ? "..." : item.payout.toFixed(2)}
              </div>
              <div className="text-[8px] font-body text-slate-500">{new Date(item.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
            </div>
          </div>
        ))}
      </div>

      <style jsx>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(51, 65, 85, 0.3);
          border-radius: 2px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(51, 65, 85, 0.5);
          border-radius: 2px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(51, 65, 85, 0.7);
        }
      `}</style>
    </div>
  );
}
