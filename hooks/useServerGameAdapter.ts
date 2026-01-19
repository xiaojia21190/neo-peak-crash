"use client";

/**
 * 服务端游戏引擎适配层
 * 将 useGameEngine 的服务端状态映射到现有 GameChart 组件接口
 */

import { useRef, useEffect, useCallback, useMemo } from 'react';
import { useGameEngine } from './useGameEngine';
import { useGameBalance } from './useGameBalance';
import type { GameEngineState, GridBet, GameStatus as ClientGameStatus, Candlestick } from '@/app/types';
import { GameStatus } from '@/app/types';
import type { ClientBet } from '@/lib/game-engine/GameClient';
import { CENTER_ROW_INDEX, calculateMultiplier } from '@/app/constants';

interface UseServerGameAdapterProps {
  userId?: string;
  isLoggedIn: boolean;
  showToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
  stakeAmount: number;
}

interface UseServerGameAdapterReturn {
  // GameChart 需要的 Ref
  gameEngineRef: React.MutableRefObject<GameEngineState>;

  // 游戏状态
  gameStatus: ClientGameStatus;
  countdown: number;
  roundHash: string;
  serverSeed: string | null;

  // 价格信息
  basePrice: number;
  startTime: number;

  // 下注方法
  onPlaceBet: (multiplier: number, timePoint: number, rowIndex: number) => void;

  // 余额管理（从 useGameBalance 透传）
  isPlayMode: boolean;
  ldcBalance: number;
  playBalance: number;
  currentBalance: number;
  setCurrentBalance: React.Dispatch<React.SetStateAction<number>>;
  toggleGameMode: () => void;
  resetPlayBalance: () => void;
  isRechargeModalOpen: boolean;
  setIsRechargeModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLdcBalance: React.Dispatch<React.SetStateAction<number>>;

  // 连接状态
  connected: boolean;
  connecting: boolean;
  connectionError: string | null;

  // 连接控制
  connect: () => void;
  disconnect: () => void;

  // 统计
  activeBetsCount: number;
  sessionPL: number;

  // 历史
  history: number[];
}

// 将服务端 bet 状态映射到客户端 GridBet
function mapServerBetToGridBet(serverBet: ClientBet): GridBet {
  return {
    id: serverBet.betId,
    targetMultiplier: serverBet.multiplier,
    rowIndex: serverBet.targetRow,
    amount: serverBet.amount,
    isTriggered: serverBet.status === 'WON',
    isLost: serverBet.status === 'LOST',
    timePoint: serverBet.targetTime,
  };
}

// 将服务端回合状态映射到客户端 GameStatus
function mapServerStatusToClientStatus(serverStatus: string | null): ClientGameStatus {
  switch (serverStatus) {
    case 'BETTING':
    case 'PENDING':
      return GameStatus.WAITING;
    case 'RUNNING':
      return GameStatus.RUNNING;
    case 'COMPLETED':
    case 'CANCELLED':
    case 'SETTLING':
      return GameStatus.CRASHED;
    default:
      return GameStatus.WAITING;
  }
}

export function useServerGameAdapter({
  userId,
  isLoggedIn,
  showToast,
  stakeAmount,
}: UseServerGameAdapterProps): UseServerGameAdapterReturn {
  // 服务端游戏引擎
  const {
    connected,
    connecting,
    error: connectionError,
    state: serverState,
    roundId,
    status: serverStatus,
    currentPrice,
    currentRow,
    elapsed,
    commitHash,
    activeBets: serverBets,
    placeBet,
    serverSeed,
    canBet,
    connect,
    disconnect,
  } = useGameEngine({ autoConnect: false });

  // 余额管理
  const balanceHook = useGameBalance({ userId, isLoggedIn, showToast });
  const { currentBalance, setCurrentBalance, isPlayMode } = balanceHook;

  // 本地状态追踪
  const sessionPLRef = useRef(0);
  const settledBetIdsRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<number[]>([]);
  const startPriceRef = useRef(0);
  const startTimeRef = useRef(0);
  const candlesRef = useRef<Candlestick[]>([]);
  const prevRowRef = useRef(CENTER_ROW_INDEX);

  // GameChart 需要的 engineRef
  const gameEngineRef = useRef<GameEngineState>({
    candles: [],
    activeBets: [],
    status: GameStatus.WAITING,
    currentMultiplier: calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0),
    currentRowIndex: CENTER_ROW_INDEX,
    prevRowIndex: CENTER_ROW_INDEX,
    currentTime: 0,
  });

  // 回合开始时重置状态
  useEffect(() => {
    if (serverStatus === 'BETTING' && serverState) {
      startPriceRef.current = serverState.startPrice;
      startTimeRef.current = serverState.startTime;
      candlesRef.current = [{
        time: 0,
        open: CENTER_ROW_INDEX,
        high: CENTER_ROW_INDEX,
        low: CENTER_ROW_INDEX,
        close: CENTER_ROW_INDEX,
      }];
      prevRowRef.current = CENTER_ROW_INDEX;
    }
  }, [serverStatus, serverState]);

  // 回合结束时记录历史
  useEffect(() => {
    if (serverStatus === 'COMPLETED' || serverStatus === 'CANCELLED') {
      const finalMultiplier = calculateMultiplier(currentRow, CENTER_ROW_INDEX, 0);
      historyRef.current = [...historyRef.current, finalMultiplier].slice(-20);
    }
  }, [serverStatus, currentRow]);

  // 更新 candles（用于 K 线渲染）
  useEffect(() => {
    if (serverStatus === 'RUNNING') {
      const candleIdx = Math.floor(elapsed / 0.1);
      if (candlesRef.current.length <= candleIdx) {
        candlesRef.current.push({
          time: elapsed,
          open: currentRow,
          high: currentRow,
          low: currentRow,
          close: currentRow,
        });
      } else {
        const lastCandle = candlesRef.current[candlesRef.current.length - 1];
        candlesRef.current[candlesRef.current.length - 1] = {
          ...lastCandle,
          close: currentRow,
          high: Math.max(lastCandle.high, currentRow),
          low: Math.min(lastCandle.low, currentRow),
          time: elapsed,
        };
      }
    }
  }, [serverStatus, elapsed, currentRow]);

  // 同步到 gameEngineRef（供 GameChart 60fps 渲染）
  useEffect(() => {
    const clientStatus = mapServerStatusToClientStatus(serverStatus);
    const gridBets = serverBets.map(mapServerBetToGridBet);
    const displayMultiplier = calculateMultiplier(currentRow, CENTER_ROW_INDEX, 0);

    gameEngineRef.current = {
      candles: candlesRef.current,
      activeBets: gridBets,
      status: clientStatus,
      currentMultiplier: displayMultiplier,
      currentRowIndex: currentRow,
      prevRowIndex: prevRowRef.current,
      currentTime: elapsed,
    };

    prevRowRef.current = currentRow;
  }, [serverStatus, serverBets, currentRow, elapsed]);

  // 处理投注结算，更新 session P/L（防止重复计算）
  useEffect(() => {
    serverBets.forEach((bet) => {
      // 只处理未记录过的已结算投注
      if (!settledBetIdsRef.current.has(bet.betId) && (bet.status === 'WON' || bet.status === 'LOST')) {
        settledBetIdsRef.current.add(bet.betId);

        if (bet.status === 'WON' && bet.payout) {
          sessionPLRef.current += bet.payout - bet.amount;
        } else if (bet.status === 'LOST') {
          sessionPLRef.current -= bet.amount;
        }
      }
    });
  }, [serverBets]);

  // 下注方法（适配现有接口）
  const onPlaceBet = useCallback(
    async (multiplier: number, timePoint: number, rowIndex: number) => {
      if (!canBet) {
        showToast('当前无法下注', 'warning');
        return;
      }

      if (!isPlayMode && !isLoggedIn) {
        showToast('请先登录 Linux DO 账号', 'warning');
        return;
      }

      if (currentBalance < stakeAmount) {
        if (isPlayMode) {
          showToast('游玩余额不足，点击重置按钮恢复余额', 'error');
        } else {
          showToast('LDC 余额不足，请先充值', 'error');
        }
        return;
      }

      try {
        // 乐观更新余额
        setCurrentBalance((prev: number) => prev - stakeAmount);

        await placeBet({
          amount: stakeAmount,
          targetRow: rowIndex,
          targetTime: timePoint,
          isPlayMode,
        });

        // 投注成功（服务端会通过 WebSocket 推送确认）
      } catch (error) {
        // 回滚余额
        setCurrentBalance((prev: number) => prev + stakeAmount);
        showToast(error instanceof Error ? error.message : '下注失败', 'error');
      }
    },
    [canBet, isLoggedIn, isPlayMode, currentBalance, stakeAmount, setCurrentBalance, placeBet, showToast]
  );

  // 计算倒计时（投注阶段剩余时间）
  const countdown = useMemo(() => {
    if (serverStatus === 'BETTING' && serverState) {
      const remaining = serverState.bettingDuration - elapsed;
      return Math.max(0, Math.ceil(remaining));
    }
    return 0;
  }, [serverStatus, serverState, elapsed]);

  return {
    // GameChart 接口
    gameEngineRef,
    gameStatus: mapServerStatusToClientStatus(serverStatus),
    countdown,
    roundHash: commitHash,
    serverSeed,
    basePrice: startPriceRef.current,
    startTime: startTimeRef.current,
    onPlaceBet,

    // 余额管理透传
    ...balanceHook,

    // 连接状态
    connected,
    connecting,
    connectionError,

    // 连接控制
    connect,
    disconnect,

    // 统计
    activeBetsCount: serverBets.length,
    sessionPL: sessionPLRef.current,

    // 历史
    history: historyRef.current,
  };
}
