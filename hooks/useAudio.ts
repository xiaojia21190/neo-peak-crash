"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";

type SoundType = "bet" | "win" | "lose" | "crash";

interface UseAudioReturn {
  isMusicPlaying: boolean;
  toggleMusic: () => void;
  playSound: (type: SoundType) => void;
}

/**
 * 音频系统 Hook
 * 管理背景音乐和音效播放
 */
export function useAudio(): UseAudioReturn {
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);

  // Audio Context Ref
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Background Music Ref
  const bgmRef = useRef<{
    oscillators: OscillatorNode[];
    masterGain: GainNode;
    lfo: OscillatorNode;
  } | null>(null);

  // 获取或创建 AudioContext
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }, []);

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
      const ctx = getAudioContext();

      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(ctx.destination);

      // Fade in
      masterGain.gain.linearRampToValueAtTime(0.15, now + 2);

      // Filter for "Underwater/Cyberpunk" feel
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400;
      filter.Q.value = 2;
      filter.connect(masterGain);

      // LFO to modulate filter (Breathing effect)
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.2;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 300;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();

      // Oscillators (Blade Runner style Drone)
      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth";
      osc1.frequency.value = 65.41; // C2

      const osc2 = ctx.createOscillator();
      osc2.type = "sawtooth";
      osc2.frequency.value = 65.8; // Detuned C2 for phasing

      const osc3 = ctx.createOscillator();
      osc3.type = "sine";
      osc3.frequency.value = 32.7; // C1

      [osc1, osc2, osc3].forEach((osc) => {
        osc.connect(filter);
        osc.start();
      });

      bgmRef.current = { oscillators: [osc1, osc2, osc3], lfo, masterGain };
      setIsMusicPlaying(true);
    }
  }, [isMusicPlaying, getAudioContext]);

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
  const playSound = useCallback(
    (type: SoundType) => {
      try {
        const ctx = getAudioContext();
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
          osc.frequency.setValueAtTime(880, t);
          osc.frequency.setValueAtTime(1760, t + 0.1);
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
          gain.gain.setValueAtTime(0.2, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);

          const osc = ctx.createOscillator();
          osc.connect(gain);
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(300, t);
          osc.frequency.exponentialRampToValueAtTime(30, t + 0.8);
          osc.start(t);
          osc.stop(t + 0.8);

          // Add noise burst for crash impact
          const bufferSize = ctx.sampleRate * 0.5;
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
    },
    [getAudioContext]
  );

  // 返回稳定的对象引用
  return useMemo(
    () => ({
      isMusicPlaying,
      toggleMusic,
      playSound,
    }),
    [isMusicPlaying, toggleMusic, playSound]
  );
}
