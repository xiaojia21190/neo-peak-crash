"use client";

import React, { useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { LinuxDoLogo } from "@/components/icons/LinuxDoLogo";

interface UserMenuProps {
  ldcBalance: number;
  onRecharge: () => void;
  isPlayMode?: boolean;
  playBalance?: number;
}

export function UserMenu({ ldcBalance, onRecharge, isPlayMode = false, playBalance = 0 }: UserMenuProps) {
  const { data: session, status } = useSession();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const user = session?.user as
    | {
        name?: string;
        image?: string;
        username?: string;
        trustLevel?: number;
        provider?: string;
      }
    | undefined;

  const isLoggedIn = status === "authenticated" && user?.provider === "linux-do";
  const isLoading = status === "loading";

  const handleLogin = () => {
    signIn("linux-do");
  };

  const handleLogout = () => {
    signOut({ callbackUrl: "/" });
  };

  // 信任等级颜色
  const getTrustLevelColor = (level: number) => {
    switch (level) {
      case 0:
        return "text-gray-400";
      case 1:
        return "text-green-400";
      case 2:
        return "text-blue-400";
      case 3:
        return "text-purple-400";
      case 4:
        return "text-yellow-400";
      default:
        return "text-gray-400";
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 bg-white/5 px-4 py-2 rounded-xl border border-white/5">
        <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-[9px] font-bold text-gray-400">加载中...</span>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <button onClick={handleLogin} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-indigo-600/30 active:scale-95">
        <LinuxDoLogo className="w-4 h-4" />
        <span className="text-[10px] font-black uppercase tracking-wider">Linux DO 登录</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="flex items-center gap-3 bg-white/5 hover:bg-white/10 px-4 py-2 rounded-xl border border-white/5 transition-all">
        {/* 头像 */}
        {user?.image ? (
          <img src={user.image} alt={user.name || "用户"} className="w-7 h-7 rounded-full border border-white/20" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center">
            <span className="text-xs font-bold">{user?.name?.charAt(0) || "U"}</span>
          </div>
        )}

        {/* 用户信息 */}
        <div className="flex flex-col items-start">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-white">{user?.username || user?.name}</span>
            <span className={`text-[8px] font-bold ${getTrustLevelColor(user?.trustLevel || 0)}`}>TL{user?.trustLevel || 0}</span>
          </div>
          <div className="flex items-center gap-1">{isPlayMode ? <span className="text-[9px] text-purple-400 font-bold">{playBalance.toFixed(2)} 🎮</span> : <span className="text-[9px] text-yellow-400 font-bold">{ldcBalance.toFixed(2)} LDC</span>}</div>
        </div>

        {/* 下拉箭头 */}
        <svg className={`w-3 h-3 text-gray-400 transition-transform ${isMenuOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 下拉菜单 */}
      {isMenuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-48 bg-[#1a1a24] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
            {isPlayMode && (
              <div className="p-3 border-b border-white/5 bg-purple-500/10">
                <div className="text-[9px] text-purple-400 uppercase tracking-wider mb-1">🎮 游玩模式</div>
                <div className="text-lg font-black text-purple-400">{playBalance.toFixed(2)}</div>
              </div>
            )}
            <div className="p-3 border-b border-white/5">
              <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">LDC 余额</div>
              <div className="text-lg font-black text-yellow-400">{ldcBalance.toFixed(2)}</div>
            </div>

            <button
              onClick={() => {
                setIsMenuOpen(false);
                onRecharge();
              }}
              className="w-full px-3 py-2.5 text-left text-[10px] font-bold text-indigo-400 hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              充值 LDC
            </button>

            <a href="https://credit.linux.do" target="_blank" rel="noopener noreferrer" className="w-full px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 hover:bg-white/5 transition-colors flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              LDC 控制台
            </a>

            <div className="border-t border-white/5">
              <button
                onClick={() => {
                  setIsMenuOpen(false);
                  handleLogout();
                }}
                className="w-full px-3 py-2.5 text-left text-[10px] font-bold text-red-400 hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                退出登录
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
