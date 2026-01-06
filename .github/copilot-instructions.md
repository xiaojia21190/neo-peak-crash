# Neon Peak Crash - AI Agent Instructions

**重要提示：请使用中文回答所有问题和提供代码建议。**

## Architecture Overview

This is a high-performance crypto multiplier prediction game with a **dual-state architecture**:

- **React State** (`gameState`): UI-only updates (text, balance, status) throttled to ~10 FPS to prevent render lag
- **Engine Ref** (`engineRef`): High-frequency game state (60 FPS) for charting, hit detection, and game logic - bypasses React's render cycle

**Critical Pattern**: Always update `engineRef.current` directly in the animation loop for performance. Only call `setGameState()` when UI needs to change or on bet events.

## Key Components & Data Flow

### Core Game Loop ([app/page.tsx](app/page.tsx#L140-L280))

- `requestAnimationFrame` runs at 60 FPS updating `engineRef`
- WebSocket (Bybit V5) provides real-time crypto prices via `useBybitWebSocket` hook
- Price delta → row index → multiplier via `calculateMultiplier()` in [app/constants.ts](app/constants.ts#L30)
- Hit detection checks if price line crosses bet cells using `HIT_TOLERANCE = 0.4` (relaxed intersection)

### Custom Hooks ([hooks/](hooks/))

- **[useAudio.ts](hooks/useAudio.ts)**: Audio system with background music (LFO modulation) and sound effects (bet, win, lose, crash). Uses Web Audio API for procedural sound generation.
- **[useBybitWebSocket.ts](hooks/useBybitWebSocket.ts)**: WebSocket connection to Bybit V5 (`wss://stream.bybit.com/v5/public/linear`) with auto-reconnect (3s timeout), heartbeat ping (20s), and clock synchronization.
- **[useGameBalance.ts](hooks/useGameBalance.ts)**: Balance management for LDC (real) and Play Mode (simulated). Handles localStorage persistence and mode switching validation.

### UI Components

- **[Header.tsx](components/Header.tsx)**: Top navigation with asset selector, music toggle, help button, price display, session P/L, streak badge, and user menu. Wrapped with `React.memo`.
- **[Footer.tsx](components/Footer.tsx)**: Bottom control bar with stake amount, quick bet buttons, balance display, game mode toggle, and start/stop button. Wrapped with `React.memo`.
- **[GameChart.tsx](components/GameChart.tsx)**: D3.js visualization with custom animation loop (60 FPS), camera interpolation, grid cells with fog opacity, and particle effects.

### Chart Rendering ([components/GameChart.tsx](components/GameChart.tsx#L100-L300))

- D3.js with custom animation loop (separate from React) - runs independently at 60 FPS
- Receives `gameEngineRef` prop (not data values) to avoid React re-renders
- Camera follows price with soft interpolation: `cameraYRef.current += (targetY - cameraYRef.current) * 0.03`
- Grid cells rendered dynamically based on viewport with fog opacity for future cells
- Click effects use particle system with lock-frame animation and ripple shockwaves

### External Integrations

- **Bybit V5 WebSocket**: Managed by `useBybitWebSocket` hook - real-time trade data with auto-reconnect and heartbeat
- **LinuxDO Connect OAuth**: NextAuth v5 with custom provider for user authentication
- **LinuxDO Credit (LDC)**: Payment integration via EasyPay protocol at `credit.linux.do/epay`
- **Web Audio API**: Managed by `useAudio` hook - procedural sound generation with background music using LFO modulation

## Development Workflow

```bash
# Install dependencies
pnpm install

# Set environment variables in .env.local
NEXTAUTH_SECRET=your_secret_here
LINUXDO_CLIENT_ID=your_client_id
LINUXDO_CLIENT_SECRET=your_client_secret

# Start dev server (runs on port 3000)
pnpm dev

# Production build
pnpm build
```

## Critical Constants & Formulas

- **Multiplier Calculation**: [app/constants.ts](app/constants.ts#L30) - Gaussian distribution with house edge (6%) and time bonus (~4% per second)
- **Price Sensitivity**: `PRICE_SENSITIVITY = 28000` - amplifies micro-volatility for gameplay
- **Hit Tolerance**: `HIT_TOLERANCE = 0.4` - creates 80% hit zone per cell
- **House Edge**: `HOUSE_EDGE = 0.06` (6%)
- **Play Mode Balance**: `PLAY_MODE_BALANCE = 10000` - initial simulated LDC for play mode

## Important Patterns

### Bet Placement

- Bets stored in both `engineRef.current.activeBets` (for hit detection) and `gameState.activeBets` (for UI)
- Duplicate prevention: Check existing bets before adding
- Balance validation required before bet placement
- Play mode uses simulated balance, real mode uses actual LDC

### State Synchronization

- `engineRef.current.prevRowIndex` tracks exact position from previous frame for precise hit detection
- Clock offset calculated from Bybit trade timestamps for time synchronization (first trade establishes offset)
- Round hash generated per round for "provably fair" display
- Asset switching disabled during RUNNING state to prevent mid-game data corruption

### Performance Considerations

- Never pass large arrays (candles, bets) as props to GameChart - use refs
- Throttle UI updates: `if (betChanged || frameCountRef.current % 6 === 0)` (approx 10 FPS for UI text)
- D3 updates happen in internal render loop, not React useEffect
- Use `React.memo` for Header and Footer components to prevent unnecessary re-renders
- Custom hooks use `useCallback` and `useMemo` for stable references

## File Structure

```
app/
  page.tsx          - Main game logic (~570 lines), game loop, state management
  constants.ts      - Game constants and multiplier formula
  types.ts          - TypeScript interfaces (GameState, GameEngineState, GridBet, etc.)
  layout.tsx        - Root layout with providers

hooks/
  index.ts          - Barrel export for all hooks
  useAudio.ts       - Audio system (background music + sound effects)
  useBybitWebSocket.ts - WebSocket connection and price data
  useGameBalance.ts - Balance management (LDC/play mode)

components/
  Header.tsx        - Top navigation bar (memo wrapped)
  Footer.tsx        - Bottom control bar (memo wrapped)
  GameChart.tsx     - D3.js visualization with custom animation
  UserMenu.tsx      - User authentication menu
  RechargeModal.tsx - LDC recharge modal
  TutorialModal.tsx - Game tutorial/help modal
  GameStats.tsx     - Game statistics panel
  BetHistoryPanel.tsx - Bet history display
  Animations.tsx    - Win/Lose animations, streak badges
  Toast.tsx         - Toast notification system
```

## Common Tasks

- **Adjust game difficulty**: Modify `HOUSE_EDGE`, `PRICE_SENSITIVITY`, or `HIT_TOLERANCE` in [app/constants.ts](app/constants.ts)
- **Change multiplier curve**: Edit `calculateMultiplier()` function in [app/constants.ts](app/constants.ts#L30)
- **Add new crypto asset**: Add to `ASSETS` array in [components/Header.tsx](components/Header.tsx) and ensure Bybit symbol format (e.g., "SOLUSDT")
- **Modify hit detection**: Adjust logic in [app/page.tsx](app/page.tsx#L200) around `isRowCrossed` calculation
- **Change audio effects**: Modify `playSound()` in [hooks/useAudio.ts](hooks/useAudio.ts)
- **Adjust balance logic**: Modify [hooks/useGameBalance.ts](hooks/useGameBalance.ts) for mode switching or persistence
- **Change fog/visual effects**: Modify opacity calculation in [components/GameChart.tsx](components/GameChart.tsx#L300)
- **Adjust camera smoothness**: Change interpolation factor (currently 0.03) in [components/GameChart.tsx](components/GameChart.tsx#L200)
- **Modify Header/Footer UI**: Edit [components/Header.tsx](components/Header.tsx) or [components/Footer.tsx](components/Footer.tsx) - remember to update props interface if needed
