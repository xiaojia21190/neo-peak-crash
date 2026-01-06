import React, { useEffect, useRef } from "react";
import * as d3 from "d3";
import { GameStatus, Candlestick, GridBet, GameEngineState } from "@/app/types";
import { calculateMultiplier, CENTER_ROW_INDEX, PRICE_SENSITIVITY } from "@/app/constants";

interface GameChartProps {
  // We now pass the REF, not the data values. This prevents React re-renders.
  gameEngineRef: React.MutableRefObject<GameEngineState>;
  onPlaceBet: (multiplier: number, timePoint: number, rowIndex: number) => void;
  roundHash: string; // New prop for provably fair display
  basePrice: number; // For calculating Y-axis prices
  startTime: number; // Start time for X-axis timestamps
}

interface GridCellData {
  id: string; // unique key: t-row
  t: number;
  rowIdx: number;
  x: number;
  y: number;
  multiplier: number;
  width: number;
  height: number;
  activeBet?: GridBet;
  opacity: number;
  pointerEvents: string;
}

const GameChart: React.FC<GameChartProps> = ({ gameEngineRef, onPlaceBet, roundHash, basePrice, startTime }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const cameraYRef = useRef(CENTER_ROW_INDEX);
  const basePriceRef = useRef(basePrice); // Ref to avoid useEffect dependency on basePrice which updates fast

  // Update ref when prop changes
  useEffect(() => {
    basePriceRef.current = basePrice;
  }, [basePrice]);

  // New: Smooth reference for odds calculation to prevent erratic number jumping
  const oddsReferenceYRef = useRef(CENTER_ROW_INDEX);

  // Store active click effects.
  // We use a ref so this data persists across renders without triggering re-renders itself.
  // UPDATED: Now storing width/height for sizing the lock animation
  const clickEffectsRef = useRef<
    {
      id: string;
      t: number;
      rowIdx: number;
      startTime: number;
      width: number;
      height: number;
    }[]
  >([]);

  // Crash particles
  const crashParticlesRef = useRef<{ id: string; x: number; y: number; vx: number; vy: number; life: number; color: string }[]>([]);
  const prevStatusRef = useRef<GameStatus>(GameStatus.WAITING);

  // We use a ref to access the latest prop callback inside the d3 loop
  const onPlaceBetRef = useRef(onPlaceBet);
  onPlaceBetRef.current = onPlaceBet;

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    // Increased right padding to 60px to accommodate the Price Axis
    const padding = { top: 40, right: 60, bottom: 40, left: 0 };

    // --- 1. LAYER SETUP ---
    let gridLayer = svg.select<SVGGElement>(".layer-grid");
    if (gridLayer.empty()) {
      const defs = svg.append("defs");

      const glowFilter = defs.append("filter").attr("id", "neon-line-glow");
      glowFilter.append("feGaussianBlur").attr("stdDeviation", "3.5").attr("result", "coloredBlur");
      const feMerge = glowFilter.append("feMerge");
      feMerge.append("feMergeNode").attr("in", "coloredBlur");
      feMerge.append("feMergeNode").attr("in", "SourceGraphic");

      const successGlow = defs.append("radialGradient").attr("id", "success-glow");
      successGlow.append("stop").attr("offset", "0%").attr("stop-color", "#10b981").attr("stop-opacity", "0.6");
      successGlow.append("stop").attr("offset", "100%").attr("stop-color", "#10b981").attr("stop-opacity", "0");

      // Fog Gradient
      const fogGradient = defs.append("linearGradient").attr("id", "fog-overlay-gradient").attr("x1", "0%").attr("y1", "0%").attr("x2", "100%").attr("y2", "0%");
      fogGradient.append("stop").attr("offset", "0%").attr("stop-color", "#0d0d12").attr("stop-opacity", "0");
      fogGradient.append("stop").attr("offset", "40%").attr("stop-color", "#0d0d12").attr("stop-opacity", "0.8");
      fogGradient.append("stop").attr("offset", "60%").attr("stop-color", "#0d0d12").attr("stop-opacity", "0");

      // Fog Radial for "Head Glow"
      const rg = defs.append("radialGradient").attr("id", "fog-gradient-radial");
      rg.append("stop").attr("offset", "0%").attr("stop-color", "#1e1b4b").attr("stop-opacity", "0.4"); // Indigo mist
      rg.append("stop").attr("offset", "50%").attr("stop-color", "#0d0d12").attr("stop-opacity", "0.0");
      rg.append("stop").attr("offset", "100%").attr("stop-color", "#0d0d12").attr("stop-opacity", "0");

      // CSS Styles
      defs.append("style").text(`
        .grid-cell {
          transition: opacity 0.1s ease-out;
        }
        .grid-cell:hover {
          opacity: 1 !important;
          z-index: 100;
        }
        .grid-cell:hover .cell-bg {
          stroke: #22d3ee !important;
          stroke-width: 2px !important;
          stroke-opacity: 1 !important;
          fill: rgba(34, 211, 238, 0.05) !important;
          filter: drop-shadow(0 0 10px rgba(34, 211, 238, 0.5));
        }
        .grid-cell:hover .cell-text {
          fill: #fff !important;
          font-weight: 900;
          font-size: 11px;
          text-shadow: 0 0 8px rgba(34, 211, 238, 1);
        }
        .grid-cell:hover .cell-hit {
          fill: rgba(34, 211, 238, 0.05) !important;
        }

        .shake-animation {
          animation: hard-shake 0.5s cubic-bezier(.36,.07,.19,.97) both;
        }

        @keyframes hard-shake {
          0% { transform: translate(0, 0) rotate(0deg); }
          10% { transform: translate(-8px, -8px) rotate(-3deg); }
          20% { transform: translate(8px, 8px) rotate(3deg); }
          30% { transform: translate(-8px, 8px) rotate(-3deg); }
          40% { transform: translate(8px, -8px) rotate(3deg); }
          50% { transform: translate(-5px, 0px) rotate(-2deg); }
          60% { transform: translate(5px, 0px) rotate(2deg); }
          70% { transform: translate(0px, 5px) rotate(0deg); }
          80% { transform: translate(0px, -5px) rotate(0deg); }
          90% { transform: translate(2px, 2px) rotate(0deg); }
          100% { transform: translate(0, 0) rotate(0deg); }
        }

        @keyframes glitch {
            0% { transform: translate(0,0); clip-path: inset(0 0 0 0); }
            20% { transform: translate(-3px, 3px); clip-path: inset(10% 0 85% 0); }
            40% { transform: translate(-3px, -3px); clip-path: inset(40% 0 43% 0); }
            60% { transform: translate(3px, 3px); clip-path: inset(80% 0 5% 0); }
            80% { transform: translate(3px, -3px); clip-path: inset(20% 0 60% 0); }
            100% { transform: translate(0,0); clip-path: inset(0 0 0 0); }
        }
        .glitch-text {
           animation: glitch 0.3s infinite linear alternate-reverse;
           fill: #ef4444;
           text-shadow: 2px 0 #fff, -2px 0 #000;
        }
        /* Axis Styling */
        .layer-axis-right text, .layer-axis-bottom text {
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
            fill: #94a3b8;
        }
        .layer-axis-right line, .layer-axis-right path, .layer-axis-bottom line, .layer-axis-bottom path {
            display: none; /* Hide default axis lines */
        }
      `);

      gridLayer = svg.append("g").attr("class", "layer-grid");
      // Set pointer-events: none for all overlays so they don't block grid clicks
      svg.append("g").attr("class", "layer-fog").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-effects").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-line").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-bets").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-particles").style("pointer-events", "none"); // New particle layer for crash
      svg.append("g").attr("class", "layer-crash").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-ui").style("pointer-events", "none");
      // Axis Layers
      svg.append("g").attr("class", "layer-axis-right").style("pointer-events", "none");
      svg.append("g").attr("class", "layer-axis-bottom").style("pointer-events", "none");
    }

    const gridLayerEl = svg.select<SVGGElement>(".layer-grid");
    const fogLayer = svg.select<SVGGElement>(".layer-fog");
    const lineLayer = svg.select<SVGGElement>(".layer-line");
    const betsLayer = svg.select<SVGGElement>(".layer-bets");
    const particleLayer = svg.select<SVGGElement>(".layer-particles");
    const uiLayer = svg.select<SVGGElement>(".layer-ui");
    const effectsLayer = svg.select<SVGGElement>(".layer-effects");
    const crashLayer = svg.select<SVGGElement>(".layer-crash");
    const axisLayer = svg.select<SVGGElement>(".layer-axis-right");
    const axisBottomLayer = svg.select<SVGGElement>(".layer-axis-bottom");

    // Setup Fog Overlay Rect (Gradient)
    if (fogLayer.selectAll("rect").empty()) {
      fogLayer.append("rect").attr("x", 0).attr("y", 0).attr("width", width).attr("height", height).attr("fill", "none");
    }

    // --- INTERNAL ANIMATION LOOP ---
    let animationFrameId: number;

    const renderLoop = () => {
      const engine = gameEngineRef.current;
      const { candles, status, activeBets } = engine;
      const currentTime = engine.currentTime;

      // Clear UI text
      uiLayer.selectAll("*").remove();

      // --- 2. SCALES & CAMERA LOGIC ---
      const lastCandle = candles[candles.length - 1];
      const targetY = lastCandle ? lastCandle.close : CENTER_ROW_INDEX;

      // SOFT CAMERA FOLLOW
      cameraYRef.current += (targetY - cameraYRef.current) * 0.03;
      const centerY = cameraYRef.current;

      // ODDS SMOOTHING: Prevents flickering numbers
      // We lerp the reference value used for odds calculation to filter out high-frequency noise
      oddsReferenceYRef.current += (targetY - oddsReferenceYRef.current) * 0.2;
      const gridReferenceY = oddsReferenceYRef.current;

      // ZOOM ADJUSTMENT
      const viewSpan = 7;
      const yScale = d3
        .scaleLinear()
        .domain([centerY - viewSpan / 2, centerY + viewSpan / 2])
        .range([padding.top, height - padding.bottom]);

      const availableHeight = height - padding.top - padding.bottom;
      const cellSize = availableHeight / viewSpan;
      const colWidth = cellSize;

      const secondsPerColumn = 1;
      const pixelsPerSecond = colWidth / secondsPerColumn;
      const viewWindowInSeconds = width / pixelsPerSecond;

      // CAMERA OFFSET
      const timeStart = Math.max(0, currentTime - viewWindowInSeconds * 0.3);
      const timeEnd = timeStart + viewWindowInSeconds;

      const xScale = d3
        .scaleLinear()
        .domain([timeStart, timeEnd])
        .range([0, width - padding.right]); // Limit x-range to padding.right

      // --- 2.1 RENDER RIGHT AXIS (PRICE) ---
      if (axisLayer && basePriceRef.current > 0) {
        axisLayer.attr("transform", `translate(${width - padding.right}, 0)`);

        const currentBase = basePriceRef.current;
        const axis = d3
          .axisRight(yScale)
          .ticks(viewSpan) // Approx one tick per row
          .tickFormat((d) => {
            const rowIdx = typeof d === "number" ? d : 0;
            // REVERSE CALCULATION:
            // newRowIndex = CENTER_ROW_INDEX - (percentChange * PRICE_SENSITIVITY)
            // percentChange = (CENTER_ROW_INDEX - newRowIndex) / PRICE_SENSITIVITY
            const percentChange = (CENTER_ROW_INDEX - rowIdx) / PRICE_SENSITIVITY;
            const price = currentBase * (1 + percentChange);
            return price < 10 ? price.toFixed(4) : price.toFixed(2);
          })
          .tickPadding(10)
          .tickSize(0); // Hide ticks lines, just show text

        axisLayer.call(axis);
        axisLayer.select(".domain").remove();
      } else {
        axisLayer.selectAll("*").remove();
      }

      // --- 2.2 RENDER BOTTOM AXIS (TIME) ---
      if (axisBottomLayer) {
        axisBottomLayer.attr("transform", `translate(0, ${height - padding.bottom + 15})`); // Offset down to margin

        const axis = d3
          .axisBottom(xScale)
          .ticks(6) // Number of timestamps visible
          .tickFormat((d) => {
            const timestamp = startTime + (d as number) * 1000;
            return d3.timeFormat("%I:%M:%S %p")(new Date(timestamp));
          })
          .tickSize(0)
          .tickPadding(10);

        axisBottomLayer.call(axis);
        axisBottomLayer.select(".domain").remove();
      }

      // --- 3. DATA PREPARATION FOR GRID ---
      const minRow = Math.floor(centerY - viewSpan / 2 - 1);
      const maxRow = Math.ceil(centerY + viewSpan / 2 + 1);
      const startCol = Math.floor(timeStart / secondsPerColumn) * secondsPerColumn;
      const endCol = Math.ceil(timeEnd / secondsPerColumn) * secondsPerColumn;

      const gridData: GridCellData[] = [];

      for (let t = startCol; t <= endCol; t += secondsPerColumn) {
        const xPos = xScale(t);
        // Updated boundary check to include padding.right
        if (xPos < -colWidth * 2 || xPos > width - padding.right + colWidth * 2) continue;

        const dist = t - currentTime;

        // FOG LOGIC
        let opacity = 0;
        if (dist >= 0) {
          opacity = Math.min(0.4, dist * 0.1);
        } else {
          opacity = 0;
        }

        for (let rowIdx = minRow; rowIdx <= maxRow; rowIdx++) {
          // Calculate multiplier relative to SMOOTHED head position (gridReferenceY)
          const m = calculateMultiplier(rowIdx, gridReferenceY, Math.max(0, dist));

          const activeBet = activeBets.find((b) => b.rowIndex === rowIdx && Math.abs(b.timePoint - t) < 0.1);

          // Active bets always visible
          const finalOpacity = activeBet ? 1 : opacity;

          gridData.push({
            id: `${t}-${rowIdx}`,
            t,
            rowIdx,
            x: xPos,
            y: yScale(rowIdx),
            multiplier: m,
            width: colWidth,
            height: cellSize,
            activeBet,
            opacity: finalOpacity,
            pointerEvents: "all",
          });
        }
      }

      // --- 4. RENDER GRID ---
      const cells = gridLayerEl.selectAll<SVGGElement, GridCellData>(".grid-cell").data(gridData, (d) => d.id);

      cells.exit().remove();

      const cellsEnter = cells
        .enter()
        .append("g")
        .attr("class", "grid-cell cursor-pointer")
        .attr("transform", (d) => `translate(${d.x}, ${d.y})`);

      cellsEnter
        .append("rect")
        .attr("class", "cell-bg")
        .attr("x", (d) => -d.width / 2)
        .attr("y", (d) => -d.height / 2)
        .attr("width", (d) => d.width)
        .attr("height", (d) => d.height)
        .attr("stroke-width", 0.5)
        .attr("fill", "none");

      cellsEnter.append("text").attr("class", "cell-text mono select-none pointer-events-none").attr("text-anchor", "middle").attr("alignment-baseline", "middle").attr("font-size", "10px");

      cellsEnter
        .append("rect")
        .attr("class", "cell-hit")
        .attr("x", (d) => -d.width / 2)
        .attr("y", (d) => -d.height / 2)
        .attr("width", (d) => d.width)
        .attr("height", (d) => d.height)
        .attr("fill", "transparent")
        .style("pointer-events", "all")
        .on("click", (event, d) => {
          if (engine.status === GameStatus.CRASHED) return;
          clickEffectsRef.current.push({
            id: Math.random().toString(36).substr(2, 9),
            t: d.t,
            rowIdx: d.rowIdx,
            startTime: Date.now(),
            width: d.width, // Capture dimensions for the effect
            height: d.height,
          });
          onPlaceBetRef.current(d.multiplier, d.t, d.rowIdx);
        });

      const cellsUpdate = cells.merge(cellsEnter);
      cellsUpdate
        .attr("transform", (d) => `translate(${d.x}, ${d.y})`)
        .attr("opacity", (d) => d.opacity)
        .style("pointer-events", (d) => d.pointerEvents);

      // Update Text: Show locked multiplier if bet exists, otherwise dynamic multiplier
      cellsUpdate
        .select(".cell-text")
        .text((d) => (d.activeBet ? `${d.activeBet.targetMultiplier.toFixed(2)}x` : `${d.multiplier.toFixed(2)}x`))
        .attr("font-weight", (d) => (d.activeBet ? "900" : "normal"))
        .attr("fill", (d) => (d.activeBet ? "#fff" : "rgba(255, 255, 255, 0.4)"));

      // Update BG
      cellsUpdate
        .select(".cell-bg")
        .attr("fill", (d) => {
          if (!d.activeBet) return "none";
          if (d.activeBet.isLost) return "rgba(100, 116, 139, 0.1)";
          if (d.activeBet.isTriggered) return "rgba(16, 185, 129, 0.2)";
          return "rgba(79, 70, 229, 0.3)";
        })
        .attr("stroke", (d) => {
          if (d.activeBet) {
            if (d.activeBet.isLost) return "#475569";
            if (d.activeBet.isTriggered) return "#10b981";
            return "#6366f1";
          }
          return "rgba(255, 255, 255, 0.1)";
        })
        .attr("stroke-width", (d) => (d.activeBet ? 2 : 0.5))
        .attr("stroke-dasharray", (d) => (d.activeBet?.isLost ? "4,4" : "none"));

      // --- RENDER FOG VISUALS ---
      const headX = xScale(currentTime);

      const fogGroup = fogLayer.selectAll<SVGGElement, number>(".fog-glow").data([1]);

      const fogEnter = fogGroup.enter().append("g").attr("class", "fog-glow");

      fogEnter
        .append("circle")
        .attr("r", height / 1.5)
        .attr("fill", "url(#fog-gradient-radial)");

      fogGroup.merge(fogEnter).attr("transform", `translate(${headX}, ${height / 2})`);

      // --- 5. EFFECTS, BETS, K-LINE, CRASH ---

      // Click Effects (Enhanced with Particles)
      const now = Date.now();
      const MAX_EFFECT_DURATION = 600;
      clickEffectsRef.current = clickEffectsRef.current.filter((e) => now - e.startTime < MAX_EFFECT_DURATION);

      const activeEffects = clickEffectsRef.current.map((e) => ({ ...e, x: xScale(e.t), y: yScale(e.rowIdx) }));

      const effects = effectsLayer.selectAll<SVGGElement, (typeof activeEffects)[0]>(".click-effect").data(activeEffects, (d) => d.id);

      effects.exit().remove();

      // Enter: Create effect groups
      const effEnter = effects.enter().append("g").attr("class", "click-effect").attr("pointer-events", "none");

      // 1. Digital Lock Frame (Rect) - New
      effEnter.append("rect").attr("class", "lock-frame").attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 2);

      // 2. Flash (Central Burst)
      effEnter.append("circle").attr("class", "flash").attr("fill", "#fff");

      // 3. Ripple (Shockwave)
      effEnter.append("circle").attr("class", "ripple").attr("fill", "none").attr("stroke", "#22d3ee");

      // 4. Particles
      const particleCount = 8;
      effEnter
        .append("g")
        .attr("class", "particles")
        .selectAll("circle")
        .data(
          d3.range(particleCount).map((i) => ({
            angle: (i / particleCount) * 2 * Math.PI,
            dist: 25 + Math.random() * 15, // Distance
          }))
        )
        .enter()
        .append("circle")
        .attr("r", 1.5)
        .attr("fill", "#67e8f9"); // cyan-300

      // Update Animation
      const effUpdate = effects.merge(effEnter);
      effUpdate.attr("transform", (d) => `translate(${d.x}, ${d.y})`);

      effUpdate.each(function (d) {
        const progress = (now - d.startTime) / MAX_EFFECT_DURATION;
        const ease = d3.easeCubicOut(progress);
        const easeBack = d3.easeBackOut.overshoot(1.7)(progress); // Snap effect
        const g = d3.select(this);

        // Lock Frame: Starts larger, snaps to cell size, then fades
        // Start at 1.5x size, end at 1.0x size
        const scale = 1.5 - 0.5 * easeBack;
        const w = d.width * scale;
        const h = d.height * scale;

        g.select(".lock-frame")
          .attr("x", -w / 2)
          .attr("y", -h / 2)
          .attr("width", w)
          .attr("height", h)
          .attr("stroke-opacity", 1 - ease) // Fade out
          .attr("stroke", progress < 0.2 ? "#fff" : "#22d3ee"); // White to Cyan snap

        // Flash: Pop and fade
        g.select(".flash")
          .attr("r", (Math.min(d.width, d.height) / 2) * easeBack) // Fill cell briefly
          .attr("opacity", Math.max(0, 0.6 * (1 - progress * 3))); // Fast fade

        // Ripple: Expand and fade
        g.select(".ripple")
          .attr("r", Math.max(d.width, d.height) * ease)
          .attr("stroke-opacity", 1 - progress)
          .attr("stroke-width", 2 * (1 - progress));

        // Particles: Move outward
        g.select(".particles")
          .selectAll("circle")
          .attr("transform", (p: any) => {
            const r = p.dist * ease;
            const x = Math.cos(p.angle) * r;
            const y = Math.sin(p.angle) * r;
            return `translate(${x}, ${y})`;
          })
          .attr("opacity", 1 - progress);
      });

      // Bets Overlay (Badges)
      betsLayer.selectAll("*").remove();
      activeBets.forEach((bet) => {
        const bx = xScale(bet.timePoint);
        const by = yScale(bet.rowIndex);
        if (bx < -100 || bx > width + 100 || by < -50 || by > height + 50) return;
        const g = betsLayer.append("g").attr("transform", `translate(${bx}, ${by})`);
        if (bet.isTriggered) {
          const pulse = Math.abs(Math.sin(Date.now() / 150));
          g.append("rect")
            .attr("x", -colWidth / 2)
            .attr("y", -cellSize / 2)
            .attr("width", colWidth)
            .attr("height", cellSize)
            .attr("fill", "url(#success-glow)")
            .attr("opacity", 0.5 + pulse * 0.5);
        }
        const b = g.append("g").attr("transform", `translate(0, ${-cellSize / 2}) scale(0.8)`);
        b.append("rect")
          .attr("x", -15)
          .attr("y", -10)
          .attr("width", 30)
          .attr("height", 14)
          .attr("rx", 2)
          .attr("fill", bet.isLost ? "#1e293b" : bet.isTriggered ? "#10b981" : "#6366f1")
          .attr("stroke", bet.isLost ? "#475569" : "#fff")
          .attr("stroke-width", 1);
        b.append("text")
          .attr("text-anchor", "middle")
          .attr("y", 0)
          .attr("fill", bet.isLost ? "#94a3b8" : "#fff")
          .attr("font-weight", "bold")
          .attr("font-size", "9px")
          .attr("alignment-baseline", "middle")
          .text(`$${bet.amount}`)
          .style("text-decoration", bet.isLost ? "line-through" : "none");
      });

      // K-Line
      const isCrashed = status === GameStatus.CRASHED;
      if (svgRef.current?.parentElement) {
        // Apply shake only if it is a fresh crash or persisting
        if (isCrashed) svgRef.current.parentElement.classList.add("shake-animation");
        else svgRef.current.parentElement.classList.remove("shake-animation");
      }
      if (candles.length > 1) {
        const lineGenerator = d3
          .line<Candlestick>()
          .x((d) => xScale(d.time))
          .y((d) => yScale(d.close))
          .curve(d3.curveCatmullRom.alpha(0.5));
        const hist = candles.filter((c) => c.time <= currentTime);
        const color = isCrashed ? "#ef4444" : "#ff79c6";
        const lp = lineLayer.selectAll<SVGPathElement, Candlestick[]>(".k-line").data([hist]);
        lp.enter()
          .append("path")
          .attr("class", "k-line")
          .attr("fill", "none")
          .attr("stroke-width", 3)
          .merge(lp)
          .attr("stroke", color)
          .attr("filter", isCrashed ? "drop-shadow(0 0 10px #ef4444)" : "url(#neon-line-glow)")
          .attr("d", lineGenerator);
        lp.exit().remove();

        const last = candles[candles.length - 1];
        const hc = lineLayer.selectAll<SVGCircleElement, Candlestick>(".k-head").data([last]);
        hc.enter().append("circle").attr("class", "k-head").attr("r", 5).attr("fill", "#fff").attr("stroke-width", 2).style("filter", "drop-shadow(0 0 8px #fff)").merge(hc).attr("cx", xScale(last.time)).attr("cy", yScale(last.close)).attr("stroke", color);

        // Crash Logic and Visuals
        if (isCrashed) {
          // 1. Detect transition to spawn particles
          if (prevStatusRef.current !== GameStatus.CRASHED) {
            const cx = xScale(last.time);
            const cy = yScale(last.close);
            for (let i = 0; i < 60; i++) {
              const angle = Math.random() * 2 * Math.PI;
              const speed = Math.random() * 10 + 2;
              crashParticlesRef.current.push({
                id: Math.random().toString(),
                x: cx,
                y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                color: i % 3 === 0 ? "#ef4444" : i % 3 === 1 ? "#b91c1c" : "#ffffff",
              });
            }
          }

          // 2. Render particles
          if (crashParticlesRef.current.length > 0) {
            crashParticlesRef.current.forEach((p) => {
              p.x += p.vx;
              p.y += p.vy;
              p.vy += 0.3; // Gravity
              p.life -= 0.015;
            });
            // cleanup dead particles
            crashParticlesRef.current = crashParticlesRef.current.filter((p) => p.life > 0);

            const ps = particleLayer.selectAll<SVGCircleElement, any>(".crash-particle").data(crashParticlesRef.current, (d) => d.id);

            ps.enter()
              .append("circle")
              .attr("class", "crash-particle")
              .attr("r", (d) => Math.random() * 3 + 1)
              .attr("fill", (d) => d.color)
              .merge(ps)
              .attr("cx", (d) => d.x)
              .attr("cy", (d) => d.y)
              .attr("opacity", (d) => d.life);

            ps.exit().remove();
          }

          // 3. Render Crash Overlay/Text
          if (crashLayer.selectAll("*").empty()) {
            const cx = xScale(last.time);
            const cy = yScale(last.close);
            const g = crashLayer.append("g");

            // Full red flash
            svg.append("rect").attr("class", "crash-flash").attr("width", width).attr("height", height).attr("fill", "#ef4444").attr("opacity", 0.5).style("mix-blend-mode", "overlay").transition().duration(200).attr("opacity", 0).remove();

            // Shockwaves
            [0, 150, 300].forEach((d, i) =>
              g
                .append("circle")
                .attr("cx", cx)
                .attr("cy", cy)
                .attr("r", 10)
                .attr("fill", "none")
                .attr("stroke", "#ef4444")
                .attr("stroke-width", 6 - i)
                .transition()
                .delay(d)
                .duration(800)
                .ease(d3.easeExpOut)
                .attr("r", Math.max(width, height) * 0.5)
                .attr("stroke-width", 0)
                .remove()
            );

            // Text
            const tg = g.append("g").attr("transform", `translate(${cx}, ${cy - 60})`);
            tg.append("text")
              .text("CRASHED")
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "middle")
              .attr("fill", "#ef4444")
              .attr("font-family", "JetBrains Mono")
              .attr("font-weight", "900")
              .attr("font-size", "64px")
              .style("filter", "drop-shadow(0 0 20px #ef4444)")
              .attr("transform", "scale(0.5)")
              .attr("opacity", 0)
              .transition()
              .duration(300)
              .ease(d3.easeElasticOut)
              .attr("transform", "scale(1)")
              .attr("opacity", 1)
              .on("end", function () {
                d3.select(this).classed("glitch-text", true);
              });
          }
        } else {
          crashLayer.selectAll("*").remove();
          particleLayer.selectAll("*").remove();
          crashParticlesRef.current = []; // Reset particles
        }
      }

      prevStatusRef.current = status;
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [gameEngineRef]);

  return (
    <div className="w-full h-full bg-[#0d0d12] relative overflow-hidden select-none">
      <svg ref={svgRef} className="w-full h-full"></svg>
      {/* Provably Fair / Server Seed UI Overlay */}
      <div className="absolute top-6 left-6 pointer-events-none">
        <div className="bg-black/40 backdrop-blur-xl border border-white/5 px-4 py-2 rounded-xl shadow-2xl flex flex-col gap-1 group">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
            <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest flex items-center gap-1">
              Server Seed
              <svg className="w-3 h-3 text-gray-600 group-hover:text-green-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div className="text-[10px] text-indigo-300 font-mono tracking-tighter opacity-80 break-all w-48 leading-tight">{roundHash}</div>
        </div>
      </div>
    </div>
  );
};

export default GameChart;
