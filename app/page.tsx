"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { GameStatus, Candlestick, GridBet, GameState, StreakState, GameEngineState } from "./types";
import { INITIAL_BALANCE, COUNTDOWN_TIME, CENTER_ROW_INDEX, calculateMultiplier, PRICE_SENSITIVITY } from "./constants";
import GameChart from "@/components/GameChart";

// HIT TOLERANCE:
// Relaxed intersection logic based on user feedback (0.8 area).
// A value of 0.4 creates a +/- 0.4 range, resulting in a total hit zone of 0.8 units (80% of a cell).
// This allows the bet to win if the price line passes through the majority of the cell, not just the exact center.
const HIT_TOLERANCE = 0.4;

// Helper to generate a random SHA-256 style hex string for visual "Provably Fair" authenticity
const generateHash = () => {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
};

// Interface for the raw WebSocket data (Generic Trade Data)
interface TradeData {
  s: string; // Symbol
  p: string; // Price
  q: string; // Quantity/Volume
  T: number; // Trade Time
}

// Helper: Linear Interpolation to get displayed multiplier value from Row Index
// Updated to support infinite rows
const getMultiplierAtRow = (rowIndex: number): number => {
  const lower = Math.floor(rowIndex);
  const upper = Math.ceil(rowIndex);

  // Pass 0 for timeDelta as this is for the current "Now" display
  const valLower = calculateMultiplier(lower, CENTER_ROW_INDEX, 0);
  const valUpper = calculateMultiplier(upper, CENTER_ROW_INDEX, 0);

  if (lower === upper) return valLower;

  const frac = rowIndex - lower;
  return valLower + (valUpper - valLower) * frac;
};

const App: React.FC = () => {
  // 1. REACT STATE: Only for UI updates (Text, Balance, Status) - Updates at low FPS (e.g., 10fps)
  const [gameState, setGameState] = useState<GameState>({
    currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
    currentRowIndex: CENTER_ROW_INDEX,
    status: GameStatus.WAITING,
    history: [],
    balance: INITIAL_BALANCE,
    sessionPL: 9.63,
    activeBets: [],
    candles: [],
    countdown: COUNTDOWN_TIME,
    streaks: {},
    roundHash: generateHash(), // Initial hash
  });

  // 2. ENGINE REF: Stores the "True" game state for high-frequency (60fps) logic and Charting
  // This bypasses React's render cycle for the heavy lifting.
  const engineRef = useRef<GameEngineState>({
    candles: [{ time: 0, open: CENTER_ROW_INDEX, high: CENTER_ROW_INDEX, low: CENTER_ROW_INDEX, close: CENTER_ROW_INDEX }],
    activeBets: [],
    status: GameStatus.WAITING,
    currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
    currentRowIndex: CENTER_ROW_INDEX,
    prevRowIndex: CENTER_ROW_INDEX,
    currentTime: 0,
  });

  const [stakeAmount, setStakeAmount] = useState<number>(5.0);
  const [realPrice, setRealPrice] = useState<number>(0);
  const [selectedAsset, setSelectedAsset] = useState<string>("ETH");
  const [lastTrade, setLastTrade] = useState<TradeData | null>(null);
  const [startPrice, setStartPrice] = useState<number>(0);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState<number | null>(null);

  const startTimeRef = useRef<number>(0);
  const candleCounterRef = useRef<number>(0);
  const latestPriceRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0); // For throttling UI updates

  // Audio Context Ref
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Background Music Ref
  const bgmRef = useRef<{
    oscillators: OscillatorNode[];
    masterGain: GainNode;
    lfo: OscillatorNode;
  } | null>(null);

  // Background Music Control
  const toggleMusic = useCallback(() => {
    if (isMusicPlaying) {
      // Stop Sequence
      if (bgmRef.current) {
        const { oscillators, lfo, masterGain } = bgmRef.current;
        const now = audioCtxRef.current?.currentTime || 0;

        // Fade out
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(masterGain.gain.value, now);
        masterGain.gain.exponentialRampToValueAtTime(0.001, now + 1);

        setTimeout(() => {
          oscillators.forEach((o) => o.stop());
          lfo.stop();
        }, 1000);
      }
      bgmRef.current = null;
      setIsMusicPlaying(false);
    } else {
      // Start Sequence
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();

      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(ctx.destination);

      // Fade in
      masterGain.gain.linearRampToValueAtTime(0.15, now + 2); // Keep volume atmospheric (low)

      // Filter for "Underwater/Cyberpunk" feel
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400;
      filter.Q.value = 2;
      filter.connect(masterGain);

      // LFO to modulate filter (Breathing effect)
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.2; // Slow breathing
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 300;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();

      // Oscillators (Blade Runner style Drone)
      // Using detuned Sawtooth waves for a thick, gritty sound
      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth";
      osc1.frequency.value = 65.41; // C2

      const osc2 = ctx.createOscillator();
      osc2.type = "sawtooth";
      osc2.frequency.value = 65.8; // Detuned C2 for phasing

      const osc3 = ctx.createOscillator(); // Sub bass
      osc3.type = "sine";
      osc3.frequency.value = 32.7; // C1

      [osc1, osc2, osc3].forEach((osc) => {
        osc.connect(filter);
        osc.start();
      });

      bgmRef.current = { oscillators: [osc1, osc2, osc3], lfo, masterGain };
      setIsMusicPlaying(true);
    }
  }, [isMusicPlaying]);

  // Clean up music on unmount
  useEffect(() => {
    return () => {
      if (bgmRef.current) {
        bgmRef.current.oscillators.forEach((o) => o.stop());
        bgmRef.current.lfo.stop();
      }
    };
  }, []);

  // Sound Effects Manager
  const playSound = useCallback((type: "bet" | "win" | "lose" | "crash") => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();

      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      if (type === "bet") {
        // High blip
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.frequency.setValueAtTime(2000, t);
        osc.frequency.exponentialRampToValueAtTime(1200, t + 0.1);
        osc.start(t);
        osc.stop(t + 0.1);
      } else if (type === "win") {
        // Positive chime
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t); // A5
        osc.frequency.setValueAtTime(1760, t + 0.1); // A6
        osc.start(t);
        osc.stop(t + 0.6);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        gain2.gain.setValueAtTime(0.05, t);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc2.frequency.setValueAtTime(2200, t);
        osc2.start(t);
        osc2.stop(t + 0.3);
      } else if (type === "lose") {
        // Low muted error
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.linearRampToValueAtTime(0.001, t + 0.15);

        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.type = "triangle";
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.linearRampToValueAtTime(80, t + 0.15);
        osc.start(t);
        osc.stop(t + 0.15);
      } else if (type === "crash") {
        // Power down slide
        gain.gain.setValueAtTime(0.2, t); // Louder for crash
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);

        const osc = ctx.createOscillator();
        osc.connect(gain);
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.8);
        osc.start(t);
        osc.stop(t + 0.8);

        // Add noise burst for crash impact
        const bufferSize = ctx.sampleRate * 0.5; // 0.5 sec noise
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.1, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        noise.connect(noiseGain);
        noiseGain.connect(ctx.destination);
        noise.start(t);
      }
    } catch (e) {
      console.error("Audio error:", e);
    }
  }, []);

  // --- 1. WebSocket Connection (Bybit V5) ---
  useEffect(() => {
    let ws: WebSocket | null = null;
    let pingInterval: ReturnType<typeof setTimeout>;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let isMounted = true;

    setConnectionError(null);
    setClockOffset(null);

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
          // Topic format: publicTrade.{symbol}
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
            // Bybit V5 format: { topic: "publicTrade.BTCUSDT", data: [ { p: "...", v: "...", ... } ] }
            if (data.topic && data.topic.startsWith("publicTrade") && data.data && data.data.length > 0) {
              // We take the last trade in the batch as the latest
              const trade = data.data[data.data.length - 1];

              const price = parseFloat(trade.p);
              const tradeTime = parseInt(trade.T);

              setRealPrice(price);
              latestPriceRef.current = price;
              setLastTrade({
                s: trade.s,
                p: trade.p,
                q: trade.v, // In Bybit V5, 'v' is volume/size
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

        ws.onerror = (e) => {
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
  }, [selectedAsset]); // Removed 'region' dependency as Bybit uses a global endpoint

  // --- 2. Game Loop Control ---
  const startRound = useCallback(() => {
    if (latestPriceRef.current === 0) return;

    startTimeRef.current = Date.now();
    candleCounterRef.current = 0;
    setStartPrice(latestPriceRef.current);

    // Reset Engine Ref
    engineRef.current = {
      candles: [{ time: 0, open: CENTER_ROW_INDEX, high: CENTER_ROW_INDEX, low: CENTER_ROW_INDEX, close: CENTER_ROW_INDEX }],
      activeBets: [],
      status: GameStatus.RUNNING,
      currentMultiplier: calculateMultiplier(Math.floor(CENTER_ROW_INDEX), CENTER_ROW_INDEX, 0),
      currentRowIndex: CENTER_ROW_INDEX,
      prevRowIndex: CENTER_ROW_INDEX, // Initialize Previous
      currentTime: 0,
    };

    // Update React State (UI)
    setGameState((prev) => ({
      ...prev,
      status: GameStatus.RUNNING,
      currentRowIndex: CENTER_ROW_INDEX,
      currentMultiplier: calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0),
      countdown: 0,
      activeBets: [],
      roundHash: generateHash(), // Generate NEW HASH for the round
    }));
  }, []);

  // Handle Crash Event (Transition to CRASHED state first)
  const handleCrash = useCallback(() => {
    playSound("crash");

    const crashValue = engineRef.current.currentMultiplier;
    engineRef.current.status = GameStatus.CRASHED;

    setGameState((prev) => ({
      ...prev,
      status: GameStatus.CRASHED,
      history: [...prev.history, crashValue], // Record history
    }));

    // Auto-reset after animation (3 seconds)
    setTimeout(() => {
      engineRef.current.status = GameStatus.WAITING;
      engineRef.current.candles = [];
      engineRef.current.activeBets = [];

      setGameState((prev) => ({
        ...prev,
        status: GameStatus.WAITING,
        currentRowIndex: CENTER_ROW_INDEX,
        currentMultiplier: calculateMultiplier(CENTER_ROW_INDEX, CENTER_ROW_INDEX, 0),
        countdown: COUNTDOWN_TIME,
        candles: [],
        activeBets: [],
      }));
    }, 3000);
  }, [playSound, gameState.history]);

  // --- 3. Logic Frame (60 FPS) via RequestAnimationFrame ---
  // PERFORMANCE FIX: This loop updates the Ref (Engine) 60 times a second,
  // but throttles the React State (UI) updates to ~10-12 FPS to avoid lag.
  useEffect(() => {
    let animationFrame: number;

    const update = () => {
      const now = Date.now();
      const engine = engineRef.current;

      if (engine.status === GameStatus.RUNNING) {
        const elapsed = (now - startTimeRef.current) / 1000;
        const currentRealPrice = latestPriceRef.current;
        const basePrice = startPrice;

        if (currentRealPrice > 0 && basePrice > 0) {
          // 1. Calculate Price Delta & Position
          const percentChange = (currentRealPrice - basePrice) / basePrice;
          const rowDelta = percentChange * PRICE_SENSITIVITY;
          let newRowIndex = CENTER_ROW_INDEX - rowDelta;
          newRowIndex = Math.max(-1000, Math.min(1000, newRowIndex));
          const displayMultiplier = getMultiplierAtRow(newRowIndex);

          // 2. Update Engine State (High Frequency)
          // CRITICAL: Store the PREVIOUS frame's row index before updating to new one.
          // This allows exact path checking between frames.
          const prevEngineRow = engine.currentRowIndex;

          engine.currentRowIndex = newRowIndex;
          engine.prevRowIndex = prevEngineRow;
          engine.currentMultiplier = displayMultiplier;
          engine.currentTime = elapsed;

          // Update Candles in Ref
          const candleIdx = Math.floor(elapsed / 0.1);
          if (candleIdx > candleCounterRef.current) {
            candleCounterRef.current = candleIdx;
            engine.candles.push({
              time: elapsed,
              open: newRowIndex,
              high: newRowIndex,
              low: newRowIndex,
              close: newRowIndex,
            });
          } else if (engine.candles.length > 0) {
            const lastCandle = engine.candles[engine.candles.length - 1];
            engine.candles[engine.candles.length - 1] = {
              ...lastCandle,
              close: newRowIndex,
              time: elapsed,
            };
          }

          // 3. Hit Detection Logic (Mutates Engine Bets)
          let betChanged = false;
          let payout = 0;
          let newWins = 0;
          let newLosses = 0;

          engine.activeBets.forEach((bet) => {
            if (bet.isTriggered || bet.isLost) return;

            // Time check - Relaxed to 0.5s to match visual cell width (Center +/- 0.5s)
            // This ensures if the line passes ANYWHERE inside the cell, we check for vertical crossing.
            const timeDiff = Math.abs(elapsed - bet.timePoint);
            const isTimeMatching = timeDiff < 0.5;

            // Row Check - STRICT INTERSECTION LOGIC
            // We determine if the line segment (prevEngineRow -> newRowIndex) intersects with the bet's row.
            const minRow = Math.min(prevEngineRow, newRowIndex) - HIT_TOLERANCE;
            const maxRow = Math.max(prevEngineRow, newRowIndex) + HIT_TOLERANCE;

            // Check if the bet's specific row index falls within the movement range of this frame
            const isRowCrossed = bet.rowIndex >= minRow && bet.rowIndex <= maxRow;

            if (isTimeMatching && isRowCrossed) {
              bet.isTriggered = true;
              betChanged = true;
              payout += bet.amount * bet.targetMultiplier;
              newWins++;
            } else if (elapsed - bet.timePoint > 0.6) {
              // Loss Check - Only mark lost if we are definitively past the timePoint (with margin)
              bet.isLost = true;
              betChanged = true;
              newLosses++;
            }
          });

          // 4. Update React State (UI) - THROTTLED or ON EVENT
          frameCountRef.current++;

          // Force update if bets changed OR if it's the 6th frame (approx 10 FPS updates for UI text)
          // We always update on 6th frame to ensure Multiplier UI is fresh
          if (betChanged || frameCountRef.current % 6 === 0) {
            if (newWins > 0) playSound("win");
            if (newLosses > 0) playSound("lose");

            setGameState((prev) => {
              // Streaks update logic
              let currentStreak = prev.streaks[selectedAsset] || { type: "NONE", count: 0 };
              if (newWins > 0) {
                currentStreak = currentStreak.type === "WIN" ? { type: "WIN", count: currentStreak.count + newWins } : { type: "WIN", count: newWins };
              }
              if (newLosses > 0) {
                currentStreak = currentStreak.type === "LOSS" ? { type: "LOSS", count: currentStreak.count + newLosses } : { type: "LOSS", count: newLosses };
              }

              return {
                ...prev,
                currentMultiplier: displayMultiplier,
                currentRowIndex: newRowIndex,
                // Note: We don't strictly need to copy candles to state for UI,
                // but we do it loosely so non-chart components might see it.
                // Ideally, UI shouldn't depend on heavy candle array.
                activeBets: [...engine.activeBets],
                balance: prev.balance + payout,
                sessionPL: prev.sessionPL + payout,
                streaks: { ...prev.streaks, [selectedAsset]: currentStreak },
              };
            });
          }
        }
      }

      animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [gameState.status, startPrice, playSound, selectedAsset]);

  // Countdown
  useEffect(() => {
    if (gameState.status === GameStatus.WAITING && gameState.countdown > 0) {
      const t = setInterval(() => setGameState((prev) => ({ ...prev, countdown: prev.countdown - 1 })), 1000);
      return () => clearInterval(t);
    } else if (gameState.status === GameStatus.WAITING && gameState.countdown === 0) {
      startRound();
    }
  }, [gameState.status, gameState.countdown, startRound]);

  // Handles the initial click on the grid - IMMEDIATE BET
  const onBetRequest = useCallback(
    (multiplier: number, timePoint: number, rowIndex: number) => {
      if (engineRef.current.status === GameStatus.CRASHED) return;

      const currentTime = engineRef.current.currentTime;

      if (timePoint + 0.5 < currentTime) return;

      // Check duplicated bet in Engine Ref
      const exists = engineRef.current.activeBets.some((b) => b.rowIndex === rowIndex && Math.abs(b.timePoint - timePoint) < 0.1);
      if (exists) return;

      // Check Balance
      if (gameState.balance < stakeAmount) return;

      playSound("bet");

      const newBet: GridBet = {
        id: Math.random().toString(),
        targetMultiplier: multiplier,
        rowIndex: rowIndex,
        amount: stakeAmount,
        isTriggered: false,
        isLost: false,
        timePoint: timePoint,
      };

      // Update Engine Immediately
      engineRef.current.activeBets.push(newBet);

      // Update UI
      setGameState((prev) => ({
        ...prev,
        balance: prev.balance - stakeAmount,
        sessionPL: prev.sessionPL - stakeAmount,
        activeBets: [...prev.activeBets, newBet],
      }));
    },
    [gameState.balance, stakeAmount, playSound]
  );

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

  const streak = gameState.streaks[selectedAsset] || { type: "NONE", count: 0 };

  // Base Price Logic: Use locked start price when running, or live price when waiting
  const currentBasePrice = gameState.status === GameStatus.RUNNING ? startPrice : latestPriceRef.current || 0;

  return (
    <div className="min-w-[1280px] min-h-[720px] h-screen w-full flex flex-col bg-[#0d0d12] text-white font-sans overflow-hidden">
      {/* Header */}
      <header className="flex justify-between items-center px-8 py-4 bg-[#0d0d12] border-b border-white/5 z-50 shadow-2xl">
        <div className="flex items-center gap-10">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-600/30 group-hover:scale-105 transition-all">
              <span className="font-black text-xs italic">P</span>
            </div>
            <span className="font-black text-xs tracking-[0.2em] uppercase italic opacity-80">PingooTread</span>
          </div>
          <nav className="flex gap-2 p-1.5 bg-white/5 rounded-2xl border border-white/5">
            {["BTC", "ETH", "SOL", "XRP", "DOGE"].map((asset) => (
              <button
                key={asset}
                onClick={() => {
                  if (gameState.status !== GameStatus.RUNNING) {
                    setSelectedAsset(asset);
                    // Visual feedback of reconnection
                    setRealPrice(0);
                    latestPriceRef.current = 0;
                    setLastTrade(null);
                    setClockOffset(null);
                  }
                }}
                disabled={gameState.status === GameStatus.RUNNING}
                className={`text-[9px] font-black px-5 py-2 rounded-xl transition-all ${selectedAsset === asset ? "bg-indigo-600 shadow-lg text-white" : "text-gray-500 hover:text-gray-300"} ${gameState.status === GameStatus.RUNNING ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {asset}
              </button>
            ))}
          </nav>

          {/* MUSIC TOGGLE BUTTON */}
          <button onClick={toggleMusic} className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all ${isMusicPlaying ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "bg-white/5 border-white/5 text-gray-500 hover:bg-white/10"}`}>
            {isMusicPlaying ? (
              <>
                <div className="flex gap-0.5 items-end h-3">
                  <span className="w-0.5 bg-indigo-400 h-2 animate-[bounce_0.8s_infinite]"></span>
                  <span className="w-0.5 bg-indigo-400 h-3 animate-[bounce_1.2s_infinite]"></span>
                  <span className="w-0.5 bg-indigo-400 h-1.5 animate-[bounce_0.6s_infinite]"></span>
                </div>
                <span className="text-[9px] font-black uppercase tracking-wider">Music ON</span>
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                </svg>
                <span className="text-[9px] font-black uppercase tracking-wider">Muted</span>
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-10">
          <div className="flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">{getAssetName(selectedAsset)} / USD</span>
              <button disabled={true} className={`text-[8px] px-1.5 py-0.5 rounded uppercase tracking-wider font-black transition-colors ${connectionError ? "bg-red-500/20 text-red-400 border border-red-500/30" : "bg-white/10 text-gray-400 opacity-60 cursor-default"}`}>
                BYBIT {connectionError ? "(!)" : ""}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {/* Real Price Display */}
              <span className="text-xs font-black mono">{connectionError ? "CONNECTION ERR" : realPrice > 0 ? `$${realPrice.toFixed(2)}` : "CONNECTING..."}</span>
              <div className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${connectionError ? "bg-red-500" : realPrice > 0 ? "bg-green-500 animate-pulse" : "bg-yellow-500"} `}></span>
                <span className={`text-[9px] font-bold ${connectionError ? "text-red-500" : realPrice > 0 ? "text-green-500" : "text-yellow-500"}`}>{connectionError ? "BLOCKED" : realPrice > 0 ? "REAL-TIME" : "WAIT"}</span>
              </div>
            </div>
          </div>

          <div className="h-8 w-px bg-white/10"></div>

          <div className="flex flex-col items-end">
            <span className="text-[8px] text-gray-500 font-bold uppercase tracking-widest mb-1">Session P/L</span>
            <span className={`text-xs font-black mono ${gameState.sessionPL >= 0 ? "text-green-500" : "text-red-500"}`}>
              {gameState.sessionPL >= 0 ? "+" : ""}${gameState.sessionPL.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-4 bg-white/5 px-5 py-2.5 rounded-2xl border border-white/5 shadow-inner">
            <div className="flex flex-col items-end">
              <span className="text-[8px] text-gray-500 font-bold uppercase tracking-widest mb-0.5">Wallet</span>
              <span className="text-sm font-black mono text-indigo-100">${gameState.balance.toLocaleString()}</span>
            </div>
            <button className="w-7 h-7 bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center justify-center font-black transition-all shadow-lg active:scale-95">+</button>
          </div>
        </div>
      </header>

      {/* Main Game Interface */}
      <main className="flex-1 relative">
        <GameChart
          gameEngineRef={engineRef}
          onPlaceBet={onBetRequest}
          roundHash={gameState.roundHash}
          basePrice={currentBasePrice}
          startTime={startTimeRef.current || Date.now()} // Pass start time for X-Axis, fallback to now to avoid 1970
        />

        {/* Live Data Feed Ticker */}
        {lastTrade && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full flex items-center gap-6 shadow-2xl z-40 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-[9px] font-black text-white/50 uppercase tracking-wider">
                Stream <span className="text-yellow-400">⚡</span>
              </span>
            </div>
            <div className="flex gap-4 font-mono text-[10px]">
              <span className="text-gray-400">
                SYM: <span className="text-indigo-300 font-bold">{lastTrade.s}</span>
              </span>
              <span className="text-gray-400">
                PRC: <span className="text-white font-bold">{parseFloat(lastTrade.p).toFixed(2)}</span>
              </span>
              <span className="text-gray-400">
                VOL: <span className="text-white font-bold">{parseFloat(lastTrade.q).toFixed(5)}</span>
              </span>
            </div>
          </div>
        )}
      </main>

      {/* Control Footer */}
      <footer className="h-28 bg-[#0d0d12] border-t border-white/5 flex items-center px-14 justify-between z-50 shadow-2xl">
        <div className="flex gap-16">
          <div className="flex flex-col gap-2.5">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">Stake Amount</span>
            <div className="flex items-center gap-4">
              <button onClick={() => setStakeAmount(Math.max(1, stakeAmount - 1))} className="w-10 h-10 bg-white/5 rounded-xl border border-white/10 hover:text-white transition-all flex items-center justify-center text-gray-400 font-black text-lg">
                −
              </button>
              <div className="bg-white/5 border border-white/10 px-8 py-2.5 rounded-xl mono font-black text-base min-w-[140px] text-center shadow-inner text-indigo-100">${stakeAmount.toFixed(2)}</div>
              <button onClick={() => setStakeAmount(stakeAmount + 1)} className="w-10 h-10 bg-white/5 rounded-xl border border-white/10 hover:text-white transition-all flex items-center justify-center text-gray-400 font-black text-lg">
                +
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">Trading Mode</span>
            <div className="flex items-center gap-4 bg-indigo-500/10 border border-indigo-500/20 px-5 py-2.5 rounded-2xl text-indigo-400">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span className="text-[10px] font-black uppercase italic tracking-wider">{selectedAsset} / Real-Time ⚡</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-20">
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest opacity-60">Active Risk</span>
            <span className="text-3xl font-black text-yellow-400 mono tracking-tighter shadow-yellow-400/10 drop-shadow-lg">${(gameState.activeBets.length * stakeAmount).toFixed(2)}</span>
          </div>
          <button
            onClick={gameState.status === GameStatus.RUNNING ? handleCrash : startRound}
            disabled={latestPriceRef.current === 0 || gameState.status === GameStatus.CRASHED}
            className={`px-16 h-14 rounded-2xl font-black text-xs uppercase italic tracking-[0.25em] transition-all shadow-2xl relative overflow-hidden group ${
              latestPriceRef.current === 0
                ? "bg-white/5 text-gray-600 cursor-not-allowed border border-white/5"
                : gameState.status === GameStatus.RUNNING
                ? "bg-red-600 hover:bg-red-500 text-white shadow-red-600/40 active:scale-95"
                : gameState.status === GameStatus.CRASHED
                ? "bg-red-900/50 text-red-300 border border-red-900 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/40 active:scale-95"
            }`}
          >
            {latestPriceRef.current === 0 ? (
              connectionError ? (
                "Connection Failed"
              ) : (
                "Connecting..."
              )
            ) : gameState.status === GameStatus.RUNNING ? (
              <>
                <span className="relative z-10">Stop Cycle</span>
                <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
              </>
            ) : gameState.status === GameStatus.CRASHED ? (
              "MARKET FAILURE"
            ) : gameState.status === GameStatus.WAITING ? (
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
      <style>{`
        @keyframes bounce-short {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .animate-bounce-short {
          animation: bounce-short 0.3s ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default App;
