# Neon Peak Crash - AI Agent Instructions

**重要提示：请使用中文回答所有问题和提供代码建议。**

## Architecture Overview

This is a high-performance crypto multiplier prediction game with a **dual-state architecture**:

- **React State** (`gameState`): UI-only updates (text, balance, status) throttled to ~10 FPS to prevent render lag
- **Engine Ref** (`engineRef`): High-frequency game state (60 FPS) for charting, hit detection, and game logic - bypasses React's render cycle

**Critical Pattern**: Always update `engineRef.current` directly in the animation loop for performance. Only call `setGameState()` when UI needs to change or on bet events.

## Key Components & Data Flow

### Core Game Loop ([App.tsx](App.tsx#L400-L500))

- `requestAnimationFrame` runs at 60 FPS updating `engineRef`
- WebSocket (Bybit V5) provides real-time crypto prices
- Price delta → row index → multiplier via `calculateMultiplier()` in [constants.ts](constants.ts#L30)
- Hit detection checks if price line crosses bet cells using `HIT_TOLERANCE = 0.4` (relaxed intersection)

### Chart Rendering ([components/GameChart.tsx](components/GameChart.tsx#L100-L300))

- D3.js with custom animation loop (separate from React) - runs independently at 60 FPS
- Receives `gameEngineRef` prop (not data values) to avoid React re-renders
- Camera follows price with soft interpolation: `cameraYRef.current += (targetY - cameraYRef.current) * 0.03`
- Grid cells rendered dynamically based on viewport with fog opacity for future cells
- Click effects use particle system with lock-frame animation and ripple shockwaves

### External Integrations

- **Bybit V5 WebSocket**: `wss://stream.bybit.com/v5/public/linear` for real-time trade data with auto-reconnect (3s timeout) and heartbeat ping every 20s
- **Google Gemini AI**: Commentary via [services/geminiService.ts](services/geminiService.ts) using `gemini-3-flash-preview` model
- **Web Audio API**: Procedural sound generation (no audio files) - see `playSound()` and `toggleMusic()` in [App.tsx](App.tsx#L100-L200). Background music uses LFO modulation for "breathing" effect

## Development Workflow

```bash
# Install dependencies
pnpm install

# Set API key in .env.local
echo "GEMINI_API_KEY=your_key_here" > .env.local

# Start dev server (runs on port 3000)
pnpm dev

# Production build
pnpm build
```

## Critical Constants & Formulas

- **Multiplier Calculation**: [constants.ts](constants.ts#L30) - Gaussian distribution with house edge (6%) and time bonus (~4% per second)
- **Price Sensitivity**: `PRICE_SENSITIVITY = 28000` - amplifies micro-volatility for gameplay
- **Hit Tolerance**: `HIT_TOLERANCE = 0.4` - creates 80% hit zone per cell
- **House Edge**: `HOUSE_EDGE = 0.06` (6%)

## Important Patterns

### Bet Placement

- Bets stored in both `engineRef.current.activeBets` (for hit detection) and `gameState.activeBets` (for UI)
- Duplicate prevention: Check existing bets before adding
- Balance validation required before bet placement

### State Synchronization

- `engineRef.current.prevRowIndex` tracks exact position from previous frame for precise hit detection
- Clock offset calculated from Bybit trade timestamps for time synchronization (first trade establishes offset)
- Round hash generated per round for "provably fair" display
- Asset switching disabled during RUNNING state to prevent mid-game data corruption

### Performance Considerations

- Never pass large arrays (candles, bets) as props to GameChart - use refs
- Throttle UI updates: `if (betChanged || frameCountRef.current % 6 === 0)` (approx 10 FPS for UI text)
- D3 updates happen in internal render loop, not React useEffect
- Use `oddsReferenceYRef` for smoothing multiplier display to prevent flickering numbers

## File Structure

- `App.tsx` - Main game logic, WebSocket, game loop, audio
- `components/GameChart.tsx` - D3.js visualization with custom animation
- `services/geminiService.ts` - AI commentary integration
- `constants.ts` - Game constants and multiplier formula
- `types.ts` - TypeScript interfaces (GameState, GameEngineState, GridBet, etc.)

## Common Tasks

- **Adjust game difficulty**: Modify `HOUSE_EDGE`, `PRICE_SENSITIVITY`, or `HIT_TOLERANCE` in [constants.ts](constants.ts)
- **Change multiplier curve**: Edit `calculateMultiplier()` function in [constants.ts](constants.ts#L30) - controls Gaussian distribution and time bonus
- **Add new crypto asset**: Add to asset selector array in [App.tsx](App.tsx#L600) and ensure Bybit symbol format (e.g., "SOLUSDT")
- **Modify hit detection**: Adjust logic in [App.tsx](App.tsx#L500) around `isRowCrossed` calculation - time tolerance is 0.5s, row tolerance uses HIT_TOLERANCE
- **Change fog/visual effects**: Modify opacity calculation in [GameChart.tsx](components/GameChart.tsx#L300) around `dist >= 0` check
- **Adjust camera smoothness**: Change interpolation factor (currently 0.03) in [GameChart.tsx](components/GameChart.tsx#L200)
