# Comprehensive Test Coverage - Development Plan

## Overview
Achieve >=90% code coverage across the entire codebase by fixing broken API route tests (DI mismatch), adding missing tests for uncovered modules (ledger, csrf, game-engine edge modules, game-server), and ensuring the test harness properly reports coverage for all source files.

## Task Breakdown

### Task 1: Coverage Harness Setup
- **ID**: task-1
- **type**: quick-fix
- **Description**: Update `scripts/run-tests.mjs` to ensure coverage measurement includes ALL source files (not just files that happen to be imported by tests). Currently, `coverageIncludes` only lists a handful of hardcoded source files when running game-engine tests. The harness should:
  1. When running the full test suite (no specific targets), add `--test-coverage-include` flags for all source directories (`lib/**/*.ts`, `app/api/**/*.ts`, `server/**/*.ts`) while excluding test files and `node_modules`.
  2. When running targeted tests, automatically infer source coverage includes from the test path (the existing `__tests__/lib/**` mapping is correct but needs extension for `app/api/**` and `server/**` targets).
  3. Add `--test-coverage-exclude` for test files, helpers, and mocks to avoid inflating coverage.
- **File Scope**: `scripts/run-tests.mjs`
- **Dependencies**: None
- **Test Command**: `pnpm test -- --coverage`
- **Test Focus**:
  - Full suite run reports coverage for all source files (spot check: `lib/services/ledger.ts`, `lib/utils/csrf.ts`, `server/game-server.ts` appear in coverage output)
  - Targeted run (e.g., `pnpm test -- __tests__/lib/services/ --coverage`) still works correctly
  - Test files themselves are excluded from coverage percentages

### Task 2: API Route Tests + DI Fix
- **ID**: task-2
- **type**: quick-fix
- **Description**: The existing API route tests have a DI mismatch: they call `POST(request, deps)` and `GET(request, deps)` but the exported route handlers (`GET`, `POST`) only accept `(request: NextRequest)` with no deps parameter. The internal DI-enabled handlers are `handleRecharge`, `handleGetBalance`, `handlePostBalance`, `handleGetBets`. Fix existing tests and add missing bets route tests:
  1. **`__tests__/app/api/payment/recharge.test.ts`** - In the `Recharge Route` describe block, change calls from `POST(request, deps)` to `handleRecharge(request, deps)` (import `handleRecharge` from the route module).
  2. **`__tests__/app/api/user/balance.test.ts`** - Change calls from `GET(request, deps)` to `handleGetBalance(request, deps)` and from `POST(request, deps)` to `handlePostBalance(request, deps)`.
  3. **`__tests__/app/api/user/bets.test.ts`** (new) - Write tests for `handleGetBets`, `POST` (disabled), and `PUT` (disabled) covering: unauthenticated user (401), banned user (403), silenced user (403), non-existent user (404), successful bet history retrieval, POST returns 403, PUT returns 403, and internal error (500).
- **File Scope**:
  - `__tests__/app/api/payment/recharge.test.ts` (update)
  - `__tests__/app/api/user/balance.test.ts` (update)
  - `__tests__/app/api/user/bets.test.ts` (new)
  - `app/api/payment/recharge/route.ts` (source - read only)
  - `app/api/user/balance/route.ts` (source - read only)
  - `app/api/user/bets/route.ts` (source - read only)
- **Dependencies**: depends on task-1
- **Test Command**: `pnpm test -- __tests__/app/api/ --coverage`
- **Test Focus**:
  - All recharge route tests pass when calling `handleRecharge` directly with injected deps
  - All balance route tests pass when calling `handleGetBalance`/`handlePostBalance` directly
  - Bets route: unauthenticated returns 401, banned user returns 403, silenced user returns 403, non-existent user returns 404, valid user gets bet history array, POST/PUT return 403 with disabled message, internal error returns 500
  - validateUserStatus tested for all user states (active, banned, silenced, not found)

### Task 3: Services and Utils Tests
- **ID**: task-3
- **type**: default
- **Description**: Add comprehensive tests for two uncovered modules:
  1. **`lib/services/ledger.ts`** - Test `createLedgerEntry` (all 4 entry types: DEPOSIT, BET, WIN, REFUND), balance mismatch warning path (diff > 0.01), `mapLedgerTypeToTransactionType` mapping (including default fallback), `buildRemark` for each type (with and without relatedBetId, with and without balance values), and `getUserLedger` with various filter options (type filter, date range, limit, no options). Mock the Prisma `transaction.create` and `transaction.findMany` methods.
  2. **`lib/utils/csrf.ts`** - Test `validateSameOrigin` for: matching origin header, matching referer header, mismatched origin (returns false), missing both headers in production (returns false), missing both headers in development (returns true), invalid URL in origin, invalid NEXTAUTH_URL env, and origin vs referer priority.
- **File Scope**:
  - `__tests__/lib/services/ledger.test.ts` (new)
  - `__tests__/lib/utils/csrf.test.ts` (new)
  - `lib/services/ledger.ts` (source - read only)
  - `lib/utils/csrf.ts` (source - read only)
- **Dependencies**: depends on task-1
- **Test Command**: `pnpm test -- __tests__/lib/services/ledger.test.ts __tests__/lib/utils/csrf.test.ts --coverage`
- **Test Focus**:
  - Ledger: `createLedgerEntry` calls prisma.transaction.create with correct mapped type for each LedgerEntryType
  - Ledger: balance mismatch triggers console.warn when diff > 0.01, no warn when diff <= 0.01
  - Ledger: `buildRemark` produces correct string format for each type with/without betId
  - Ledger: `getUserLedger` passes correct `where` clause based on options (type, date range, limit defaults to 100)
  - CSRF: same-origin returns true, cross-origin returns false
  - CSRF: development mode allows missing headers, production mode rejects
  - CSRF: handles malformed URLs gracefully (returns false, no throw)

### Task 4: Game Engine Edge Module Tests
- **ID**: task-4
- **type**: default
- **Description**: Add tests for four uncovered game engine modules:
  1. **`lib/game-engine/utils.ts`** - Test `calculateRowIndex` (center price returns center index, price increase shifts row, price decrease shifts row, boundary clamping at MIN/MAX_ROW_INDEX), `generateOrderId` (returns string with timestamp prefix and hex suffix, uniqueness across calls), `createThrottler` (executes immediately on first call, suppresses calls within interval, allows call after interval), `createDebouncer` (delays execution, resets timer on subsequent calls), `delay` (resolves after specified ms), `withTimeout` (resolves when promise completes within timeout, rejects with timeout error when promise exceeds timeout).
  2. **`lib/game-engine/wsAuth.ts`** - Test `verifyNextAuthToken` (returns null for empty token, returns null when AUTH_SECRET missing, returns userId on valid decode, returns null when user not found in DB, returns null on decode error) and `verifyNextAuthCookie` (returns null for missing cookie header, returns null when no session token cookie, returns userId on valid cookie, returns null on getToken error). Mock `next-auth/jwt` decode/getToken and prisma.
  3. **`lib/game-engine/errors.ts`** - Test `GameError` construction (sets code, message, name), `toJSON` returns {code, message}, instanceof Error check.
  4. **`lib/game-engine/DistributedLock.ts`** - Test `acquire` (returns token on success when redis.set returns 'OK', returns null on failure), `release` (returns true when eval returns 1, returns false when eval returns 0), `extend` (returns true on success, false on failure), `exists` (returns true when redis.exists returns 1, false otherwise). Mock Redis with minimal interface.
- **File Scope**:
  - `__tests__/lib/game-engine/utils.test.ts` (new)
  - `__tests__/lib/game-engine/wsAuth.test.ts` (new)
  - `__tests__/lib/game-engine/errors.test.ts` (new)
  - `__tests__/lib/game-engine/DistributedLock.test.ts` (new)
  - `lib/game-engine/utils.ts` (source - read only)
  - `lib/game-engine/wsAuth.ts` (source - read only)
  - `lib/game-engine/errors.ts` (source - read only)
  - `lib/game-engine/DistributedLock.ts` (source - read only)
  - `lib/game-engine/constants.ts` (source - read only, for constant values used in utils tests)
- **Dependencies**: depends on task-1
- **Test Command**: `pnpm test -- __tests__/lib/game-engine/ --coverage`
- **Test Focus**:
  - utils: `calculateRowIndex` boundary behavior, `generateOrderId` format and uniqueness, throttler/debouncer timing behavior, `delay` resolves correctly, `withTimeout` timeout rejection
  - wsAuth: all early-return null paths tested (empty token, missing secret, missing user), successful verification path, error handling paths
  - errors: GameError properties, toJSON serialization, prototype chain
  - DistributedLock: acquire/release/extend/exists with mocked Redis responses, correct Lua script arguments passed

### Task 5: Server Testability Refactor and Tests
- **ID**: task-5
- **type**: quick-fix
- **Description**: The `server/game-server.ts` file is a monolithic entry point with global state, making it untestable as-is. Refactor to extract testable units and add tests:
  1. **Refactor**: Extract the HTTP request handler (health check + stats endpoint + 404) into a named, exported function `createRequestHandler(deps)` that accepts `{ gateway, adminToken }` as parameters. This allows testing the HTTP routing logic without starting a real server.
  2. **Refactor**: Extract the orphaned round recovery logic into a named, exported async function `recoverOrphanedRounds(deps)` that accepts `{ prisma, financialService, housePoolService }`.
  3. **Test**: Write tests for `createRequestHandler`: health endpoint returns 200 with status/timestamp/uptime; stats endpoint returns 401 without auth; stats returns 401 with wrong token; stats returns 200 with correct token; stats returns 503 when gateway not ready; unknown path returns 404.
  4. **Test**: Write tests for `recoverOrphanedRounds`: no orphaned rounds (no-op), single orphaned round with pending bets (cancels round + refunds bets via transaction), orphaned round with no pending bets (only cancels round), error during refund logs error and continues, idempotent refund (bet already refunded, updated.count === 0 skips refund).
- **File Scope**:
  - `server/game-server.ts` (refactor - extract functions)
  - `__tests__/server/game-server.test.ts` (new)
- **Dependencies**: depends on task-1
- **Test Command**: `pnpm test -- __tests__/server/game-server.test.ts --coverage`
- **Test Focus**:
  - HTTP handler: /health returns 200 JSON with status/timestamp/uptime fields
  - HTTP handler: /stats without Authorization returns 401
  - HTTP handler: /stats with wrong Bearer token returns 401
  - HTTP handler: /stats with valid Bearer token returns 200 with gateway stats
  - HTTP handler: /stats returns 503 when gateway is null
  - HTTP handler: /stats returns 500 when ADMIN_TOKEN not configured
  - HTTP handler: unknown path returns 404
  - Recovery: no orphaned rounds produces no DB updates
  - Recovery: orphaned round with PENDING bets triggers cancel + refund per bet
  - Recovery: isPlayMode=false bets also call housePoolService.applyDelta
  - Recovery: bet already refunded (updateMany.count=0) skips balance change
  - Recovery: error in single bet refund is caught and logged, processing continues

## Acceptance Criteria
- [ ] All existing tests continue to pass after DI fix
- [ ] API route tests call DI-enabled handlers (`handleRecharge`, `handleGetBalance`, `handlePostBalance`, `handleGetBets`) instead of route-exported `GET`/`POST`
- [ ] New bets route test file covers all paths (auth, user status, success, disabled methods)
- [ ] Ledger service tests cover all 4 entry types, balance mismatch warning, remark generation, and query filters
- [ ] CSRF utility tests cover same-origin, cross-origin, dev mode, malformed URLs
- [ ] Game engine edge modules (utils, wsAuth, errors, DistributedLock) all have dedicated test files
- [ ] Server extracted functions (`createRequestHandler`, `recoverOrphanedRounds`) have full test coverage
- [ ] Coverage harness correctly includes all source files in coverage reports
- [ ] All unit tests pass: `pnpm test`
- [ ] Code coverage >= 90% on full suite: `pnpm test -- --coverage`

## Technical Notes
- **Test Framework**: `node:test` (Node.js built-in test runner) with `tsx` loader. No Jest/Mocha.
- **Coverage Mechanism**: V8-based via `--experimental-test-coverage`. Coverage includes are controlled by `--test-coverage-include` flags in `scripts/run-tests.mjs`.
- **DI Pattern**: Route handlers use a `handleXxx(request, deps)` pattern for dependency injection. Tests should import and call `handleXxx` directly, NOT the route-exported `GET`/`POST` functions (which pass through without deps).
- **Prisma Mocking**: Use existing `__tests__/helpers/prismaMock.ts` for database mocking in route and service tests.
- **Redis Mocking**: For DistributedLock tests, create a minimal mock object implementing `set`, `eval`, `exists` methods. For wsAuth tests, mock the `next-auth/jwt` module imports.
- **Server Refactor Constraint**: Keep the `main()` function and signal handlers intact. Only extract the HTTP handler and recovery logic as additional named exports. The `main()` function should call the extracted functions to maintain existing behavior.
- **Timer-Based Tests**: For throttler/debouncer tests in utils, use real timeouts with small intervals (50-100ms) since `node:test` does not provide fake timers natively. Keep test timeouts reasonable.
- **No External Test Dependencies**: The project has no test libraries in devDependencies (no Jest, no Vitest). All tests use `node:test` + `node:assert/strict`.
