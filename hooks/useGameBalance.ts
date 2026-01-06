"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

const PLAY_MODE_BALANCE = 10000; // 游玩模式初始余额

interface UseGameBalanceProps {
  userId?: string;
  isLoggedIn: boolean;
  showToast: (message: string, type: "success" | "error" | "warning" | "info") => void;
}

interface UseGameBalanceReturn {
  isPlayMode: boolean;
  ldcBalance: number;
  playBalance: number;
  currentBalance: number;
  setLdcBalance: React.Dispatch<React.SetStateAction<number>>;
  setPlayBalance: React.Dispatch<React.SetStateAction<number>>;
  setCurrentBalance: React.Dispatch<React.SetStateAction<number>>;
  toggleGameMode: () => void;
  resetPlayBalance: () => void;
  isRechargeModalOpen: boolean;
  setIsRechargeModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isLoading: boolean;
  refreshBalance: () => Promise<void>;
}

/**
 * 游戏余额管理 Hook
 * 管理 LDC 余额、游玩模式余额和模式切换
 * 支持数据库持久化
 */
export function useGameBalance({ userId, isLoggedIn, showToast }: UseGameBalanceProps): UseGameBalanceReturn {
  // 游戏模式：true = 游玩模式（模拟LDC），false = 真实模式（消耗真实LDC）
  const [isPlayMode, setIsPlayMode] = useState<boolean>(true);

  // LDC 余额状态
  const [ldcBalance, setLdcBalance] = useState<number>(0);
  const [playBalance, setPlayBalance] = useState<number>(PLAY_MODE_BALANCE);
  const [isRechargeModalOpen, setIsRechargeModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // 防止重复请求
  const fetchingRef = useRef(false);

  // 当前使用的余额（根据模式切换）
  const currentBalance = isPlayMode ? playBalance : ldcBalance;
  const setCurrentBalance = isPlayMode ? setPlayBalance : setLdcBalance;

  // 从数据库加载余额
  const refreshBalance = useCallback(async () => {
    if (!isLoggedIn || !userId || fetchingRef.current) return;

    fetchingRef.current = true;
    setIsLoading(true);

    try {
      const response = await fetch("/api/user/balance");
      if (response.ok) {
        const data = await response.json();
        setLdcBalance(data.balance ?? 0);
        setPlayBalance(data.playBalance ?? PLAY_MODE_BALANCE);
      }
    } catch (error) {
      console.error("获取余额失败:", error);
      // 回退到本地存储
      const savedBalance = localStorage.getItem(`ldc_balance_${userId}`);
      if (savedBalance) {
        setLdcBalance(parseFloat(savedBalance));
      }
      const savedPlayBalance = localStorage.getItem(`ldc_play_balance_${userId}`);
      if (savedPlayBalance) {
        setPlayBalance(parseFloat(savedPlayBalance));
      }
    } finally {
      setIsLoading(false);
      fetchingRef.current = false;
    }
  }, [isLoggedIn, userId]);

  // 登录后从数据库加载余额
  useEffect(() => {
    if (isLoggedIn && userId) {
      refreshBalance();
    }
  }, [isLoggedIn, userId, refreshBalance]);

  // 同步余额到本地存储（作为备份）
  useEffect(() => {
    if (isLoggedIn && userId) {
      if (ldcBalance > 0) {
        localStorage.setItem(`ldc_balance_${userId}`, ldcBalance.toString());
      }
      localStorage.setItem(`ldc_play_balance_${userId}`, playBalance.toString());
    }
  }, [ldcBalance, playBalance, isLoggedIn, userId]);

  // 检查充值成功回调
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("recharge") === "success") {
      window.history.replaceState({}, "", window.location.pathname);
      showToast("充值成功！余额已更新", "success");
      setIsPlayMode(false);
      // 刷新余额
      refreshBalance();
    }
  }, [showToast, refreshBalance]);

  // 切换模式
  const toggleGameMode = useCallback(() => {
    if (!isPlayMode && ldcBalance <= 0) {
      setIsPlayMode(true);
      showToast("已切换到游玩模式", "info");
    } else if (isPlayMode) {
      if (!isLoggedIn) {
        showToast("请先登录后才能使用真实模式", "warning");
        return;
      }
      if (ldcBalance <= 0) {
        showToast("真实 LDC 余额为 0，请先充值", "warning");
        return;
      }
      setIsPlayMode(false);
      showToast("已切换到真实模式，将消耗真实 LDC", "warning");
    } else {
      setIsPlayMode(true);
      showToast("已切换到游玩模式", "info");
    }
  }, [isPlayMode, ldcBalance, isLoggedIn, showToast]);

  // 重置游玩模式余额
  const resetPlayBalance = useCallback(async () => {
    if (isLoggedIn && userId) {
      try {
        const response = await fetch("/api/user/balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset_play_balance" }),
        });
        if (response.ok) {
          const data = await response.json();
          setPlayBalance(data.playBalance ?? PLAY_MODE_BALANCE);
          showToast(`游玩余额已重置为 ${PLAY_MODE_BALANCE} LDC`, "success");
          return;
        }
      } catch (error) {
        console.error("重置余额失败:", error);
      }
    }
    // 回退到本地重置
    setPlayBalance(PLAY_MODE_BALANCE);
    showToast(`游玩余额已重置为 ${PLAY_MODE_BALANCE} LDC`, "success");
  }, [isLoggedIn, userId, showToast]);

  return useMemo(
    () => ({
      isPlayMode,
      ldcBalance,
      playBalance,
      currentBalance,
      setLdcBalance,
      setPlayBalance,
      setCurrentBalance,
      toggleGameMode,
      resetPlayBalance,
      isRechargeModalOpen,
      setIsRechargeModalOpen,
      isLoading,
      refreshBalance,
    }),
    [isPlayMode, ldcBalance, playBalance, currentBalance, toggleGameMode, resetPlayBalance, isRechargeModalOpen, setCurrentBalance, isLoading, refreshBalance]
  );
}
