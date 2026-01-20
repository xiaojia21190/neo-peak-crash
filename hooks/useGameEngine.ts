"use client";

/**
 * 游戏引擎 React Hook
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { GameClient, type ClientGameState, type ClientBet } from '@/lib/game-engine/GameClient';
import type { PlaceBetRequest, HitDetails } from '@/lib/game-engine/types';

export interface UseGameEngineOptions {
  autoConnect?: boolean;
}

export interface UseGameEngineReturn {
  // 连接状态
  connected: boolean;
  connecting: boolean;
  error: string | null;

  // 游戏状态
  state: ClientGameState | null;
  roundId: string | null;
  status: string | null;
  currentPrice: number;
  currentRow: number;
  elapsed: number;

  // 投注
  activeBets: ClientBet[];
  placeBet: (request: Omit<PlaceBetRequest, 'orderId'>) => Promise<ClientBet>;
  pendingBetCount: number;

  // 方法
  connect: () => void;
  disconnect: () => void;

  // 回合信息
  isRoundActive: boolean;
  canBet: boolean;
}

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

export function useGameEngine(options: UseGameEngineOptions = {}): UseGameEngineReturn {
  const { autoConnect = true } = options;
  const { data: session, status: sessionStatus } = useSession();

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ClientGameState | null>(null);

  const clientRef = useRef<GameClient | null>(null);

  // 初始化客户端
  useEffect(() => {
    if (!clientRef.current) {
      clientRef.current = new GameClient({ url: WS_URL });
    }

    const client = clientRef.current;

    // 事件处理
    const handleConnected = () => {
      setConnected(true);
      setConnecting(false);
      setError(null);
    };

    const handleAuthError = (err: string) => {
      setError(err);
      setConnecting(false);
    };

    const handleDisconnected = () => {
      setConnected(false);
    };

    const handleError = (err: Error) => {
      setError(err.message);
    };

    const handleRoundStart = (newState: ClientGameState) => {
      setState(newState);
    };

    const handleRoundRunning = () => {
      setState((prev: ClientGameState | null) => (prev ? { ...prev, status: 'RUNNING' as const } : null));
    };

    const handleStateUpdate = (update: { elapsed: number; currentPrice: number; currentRow: number }) => {
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              elapsed: update.elapsed,
              currentPrice: update.currentPrice,
              currentRow: update.currentRow,
            }
          : null
      );
    };

    const handlePrice = (update: { price: number; rowIndex: number }) => {
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              currentPrice: update.price,
              currentRow: update.rowIndex,
            }
          : null
      );
    };

    const handleBetConfirmed = (data: { betId: string; orderId: string; amount: number; multiplier: number; targetRow: number; targetTime: number }) => {
      const bet: ClientBet = {
        betId: data.betId,
        orderId: data.orderId,
        amount: data.amount,
        multiplier: data.multiplier,
        targetRow: data.targetRow,
        targetTime: data.targetTime,
        status: 'PENDING',
      };
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              activeBets: [...prev.activeBets.filter((b: ClientBet) => b.orderId !== data.orderId), bet],
            }
          : null
      );
    };

    const handleBetSettled = (data: { betId: string; isWin: boolean; payout: number; hitDetails?: HitDetails }) => {
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              activeBets: prev.activeBets.map((b: ClientBet) =>
                b.betId === data.betId
                  ? {
                      ...b,
                      status: data.isWin ? 'WON' as const : 'LOST' as const,
                      isWin: data.isWin,
                      payout: data.payout,
                      hitDetails: data.hitDetails,
                    }
                  : b
              ),
            }
          : null
      );
    };

    const handleRoundEnd = () => {
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              status: 'COMPLETED' as const,
            }
          : null
      );
    };

    const handleRoundCancelled = () => {
      setState((prev: ClientGameState | null) =>
        prev
          ? {
              ...prev,
              status: 'CANCELLED' as const,
            }
          : null
      );
    };

    // 注册事件
    client.on('connected', handleConnected);
    client.on('auth_error', handleAuthError);
    client.on('disconnected', handleDisconnected);
    client.on('error', handleError);
    client.on('round:start', handleRoundStart);
    client.on('round:running', handleRoundRunning);
    client.on('state:update', handleStateUpdate);
    client.on('price', handlePrice);
    client.on('bet:confirmed', handleBetConfirmed);
    client.on('bet:settled', handleBetSettled);
    client.on('round:end', handleRoundEnd);
    client.on('round:cancelled', handleRoundCancelled);

    return () => {
      client.off('connected', handleConnected);
      client.off('auth_error', handleAuthError);
      client.off('disconnected', handleDisconnected);
      client.off('error', handleError);
      client.off('round:start', handleRoundStart);
      client.off('round:running', handleRoundRunning);
      client.off('state:update', handleStateUpdate);
      client.off('price', handlePrice);
      client.off('bet:confirmed', handleBetConfirmed);
      client.off('bet:settled', handleBetSettled);
      client.off('round:end', handleRoundEnd);
      client.off('round:cancelled', handleRoundCancelled);
    };
  }, []);

  // 自动连接（允许匿名连接观看游戏）
  useEffect(() => {
    if (autoConnect && !connected && !connecting) {
      setConnecting(true);
      clientRef.current?.connect();
    }
  }, [autoConnect, connected, connecting]);

  // 清理
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  // 连接方法（允许匿名连接）
  const connect = useCallback(() => {
    if (!connected) {
      setConnecting(true);
      clientRef.current?.connect();
    }
  }, [connected]);

  // 断开方法
  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    setConnected(false);
    setState(null);
  }, []);

  // 下注方法
  const placeBet = useCallback(
    async (request: Omit<PlaceBetRequest, 'orderId'>): Promise<ClientBet> => {
      if (!clientRef.current?.connected) {
        throw new Error('未连接到服务器');
      }
      return clientRef.current.placeBet(request);
    },
    []
  );

  // 计算属性
  const isRoundActive = useMemo(
    () => state?.status === 'BETTING' || state?.status === 'RUNNING',
    [state?.status]
  );

  const canBet = useMemo(
    () => connected && (state?.status === 'BETTING' || state?.status === 'RUNNING'),
    [connected, state?.status]
  );

  const pendingBetCount = useMemo(
    () => state?.activeBets.filter((b: ClientBet) => b.status === 'PENDING').length ?? 0,
    [state?.activeBets]
  );

  return {
    // 连接状态
    connected,
    connecting,
    error,

    // 游戏状态
    state,
    roundId: state?.roundId ?? null,
    status: state?.status ?? null,
    currentPrice: state?.currentPrice ?? 0,
    currentRow: state?.currentRow ?? 6.5,
    elapsed: state?.elapsed ?? 0,

    // 投注
    activeBets: state?.activeBets ?? [],
    placeBet,
    pendingBetCount,

    // 方法
    connect,
    disconnect,

    // 回合信息
    isRoundActive,
    canBet,
  };
}
