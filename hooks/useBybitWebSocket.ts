"use client";

import { useEffect, useState, useRef, useMemo } from "react";

// Interface for the raw WebSocket data (Generic Trade Data)
export interface TradeData {
  s: string; // Symbol
  p: string; // Price
  q: string; // Quantity/Volume
  T: number; // Trade Time
}

interface UseBybitWebSocketReturn {
  realPrice: number;
  lastTrade: TradeData | null;
  connectionError: string | null;
  clockOffset: number | null;
  latestPriceRef: React.MutableRefObject<number>;
}

/**
 * Bybit WebSocket Hook
 * 管理与 Bybit V5 的 WebSocket 连接和实时价格数据
 */
export function useBybitWebSocket(selectedAsset: string): UseBybitWebSocketReturn {
  const [realPrice, setRealPrice] = useState<number>(0);
  const [lastTrade, setLastTrade] = useState<TradeData | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState<number | null>(null);

  const latestPriceRef = useRef<number>(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let pingInterval: ReturnType<typeof setTimeout>;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let isMounted = true;

    setConnectionError(null);
    setClockOffset(null);
    setRealPrice(0);
    latestPriceRef.current = 0;
    setLastTrade(null);

    const connect = () => {
      // Bybit V5 Public Linear Endpoint (Mainnet)
      const url = "wss://stream.bybit.com/v5/public/linear";

      console.log(`Connecting to Bybit V5 stream (${url}) for ${selectedAsset}...`);

      try {
        ws = new WebSocket(url);

        ws.onopen = () => {
          if (!isMounted) return;
          console.log(`Connected to Bybit Stream - ${selectedAsset}`);
          setConnectionError(null);

          // Bybit V5 Subscription Logic
          const topic = `publicTrade.${selectedAsset}USDT`;
          const subscribeMsg = {
            op: "subscribe",
            args: [topic],
          };
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(subscribeMsg));
          }

          // Start Heartbeat (Bybit requires ping every 20s)
          pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: "ping" }));
            }
          }, 20000);
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);

            // Handle Pong
            if (data.op === "pong") return;

            // Handle Trade Data
            if (data.topic && data.topic.startsWith("publicTrade") && data.data && data.data.length > 0) {
              const trade = data.data[data.data.length - 1];

              const price = parseFloat(trade.p);
              const tradeTime = parseInt(trade.T);

              setRealPrice(price);
              latestPriceRef.current = price;
              setLastTrade({
                s: trade.s,
                p: trade.p,
                q: trade.v,
                T: tradeTime,
              });

              // CLOCK SYNC LOGIC
              setClockOffset((prev) => {
                if (prev === null) {
                  const offset = Date.now() - tradeTime;
                  console.log(`Clock Sync: Local time is ${offset}ms diff from Bybit. Calibrating...`);
                  return offset;
                }
                return prev;
              });
            }
          } catch (err) {
            console.error("Error parsing WS message", err);
          }
        };

        ws.onclose = (e) => {
          if (!isMounted) return;
          clearInterval(pingInterval);
          console.log("Bybit Stream Closed. Code:", e.code);
          setConnectionError("Reconnecting...");
          reconnectTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          console.warn("WebSocket Connection Error encountered.");
        };
      } catch (e) {
        console.error("Failed to create WebSocket", e);
        setConnectionError("Socket Creation Failed");
      }
    };

    connect();

    return () => {
      isMounted = false;
      clearInterval(pingInterval);
      clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [selectedAsset]);

  return useMemo(
    () => ({
      realPrice,
      lastTrade,
      connectionError,
      clockOffset,
      latestPriceRef,
    }),
    [realPrice, lastTrade, connectionError, clockOffset]
  );
}
