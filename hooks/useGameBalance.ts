"use client";

import { useEffect, useState, useCallback, useMemo } from "react";

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
}

/**
 * 游戏余额管理 Hook
 * 管理 LDC 余额、游玩模式余额和模式切换
 */
export function useGameBalance({ userId, isLoggedIn, showToast }: UseGameBalanceProps): UseGameBalanceReturn {
  // 游戏模式：true = 游玩模式（模拟LDC），false = 真实模式（消耗真实LDC）
  const [isPlayMode, setIsPlayMode] = useState<boolean>(true);

  // LDC 余额状态
  const [ldcBalance, setLdcBalance] = useState<number>(0);
  const [playBalance, setPlayBalance] = useState<number>(PLAY_MODE_BALANCE);
  const [isRechargeModalOpen, setIsRechargeModalOpen] = useState(false);

  // 当前使用的余额（根据模式切换）
  const currentBalance = isPlayMode ? playBalance : ldcBalance;
  const setCurrentBalance = isPlayMode ? setPlayBalance : setLdcBalance;

  // 从本地存储加载余额
  useEffect(() => {
    if (isLoggedIn && userId) {
      const savedBalance = localStorage.getItem(`ldc_balance_${userId}`);
      if (savedBalance) {
        setLdcBalance(parseFloat(savedBalance));
      }
      const savedPlayBalance = localStorage.getItem(`ldc_play_balance_${userId}`);
      if (savedPlayBalance) {
        setPlayBalance(parseFloat(savedPlayBalance));
      }
    }
  }, [isLoggedIn, userId]);

  // 保存余额到本地存储
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
    }
  }, [showToast]);

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
  const resetPlayBalance = useCallback(() => {
    setPlayBalance(PLAY_MODE_BALANCE);
    showToast(`游玩余额已重置为 ${PLAY_MODE_BALANCE} LDC`, "success");
  }, [showToast]);

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
    }),
    [isPlayMode, ldcBalance, playBalance, currentBalance, toggleGameMode, resetPlayBalance, isRechargeModalOpen, setCurrentBalance]
  );
}
