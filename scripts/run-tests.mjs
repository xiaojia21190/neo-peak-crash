import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);

let enableCoverage = false;
let coverageDirectory = undefined;
let coverageThresholds = null;
const passthrough = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];

  if (arg === '--coverage') {
    enableCoverage = true;
    continue;
  }

  if (arg.startsWith('--coverageDirectory=')) {
    enableCoverage = true;
    coverageDirectory = arg.split('=', 2)[1] || coverageDirectory;
    continue;
  }

  if (arg === '--coverageDirectory') {
    enableCoverage = true;
    coverageDirectory = argv[i + 1] ?? coverageDirectory;
    i += 1;
    continue;
  }

  if (arg.startsWith('--coverageThreshold=')) {
    const rawValue = arg.split('=', 2)[1] ?? '';
    coverageThresholds = rawValue;
    continue;
  }

  if (arg === '--coverageThreshold') {
    coverageThresholds = argv[i + 1] ?? '';
    i += 1;
    continue;
  }

  passthrough.push(arg);
}

const testTargets = passthrough.filter((arg) => !arg.startsWith('-'));
const extraFlags = passthrough.filter((arg) => arg.startsWith('-'));
const defaultTargets = ['tests/*.test.ts', '__tests__/**/*.test.ts'];

const normalizeTarget = (target) => target.replace(/\\/g, '/');
const mapTargetToTests = (target) => {
  const normalized = normalizeTarget(target);
  // If users pass a __tests__ directory, expand it to the test glob. Node's test runner
  // (with tsx loader) does not reliably accept directories as entrypoints.
  if (normalized.startsWith('__tests__/') || normalized.startsWith('tests/')) {
    const trimmed = normalized.replace(/\/+$/, '');
    const isDir =
      normalized.endsWith('/') ||
      normalized.endsWith('\\') ||
      (existsSync(trimmed) && statSync(trimmed).isDirectory());

    if (isDir) {
      return `${trimmed}/**/*.test.ts`;
    }

    return target;
  }
  if (!normalized.startsWith('lib/')) return target;

  const trimmed = normalized.replace(/\/+$/, '');
  const isDir =
    normalized.endsWith('/') ||
    normalized.endsWith('\\') ||
    (existsSync(trimmed) && statSync(trimmed).isDirectory());

  if (isDir) {
    return `__tests__/${trimmed}/**/*.test.ts`;
  }

  if (trimmed.endsWith('.ts')) {
    return `__tests__/${trimmed.replace(/\\.ts$/, '.test.ts')}`;
  }

  return target;
};

const coverageIncludes = [];
let resolvedTargets = defaultTargets;
if (testTargets.length > 0) {
  resolvedTargets = testTargets.map(mapTargetToTests);
  if (testTargets.some((target) => normalizeTarget(target) === 'lib/services/financial.ts')) {
    resolvedTargets.push('tests/financial.test.ts');
    coverageIncludes.push('lib/services/financial.ts');
  }
  const normalizedTargets = testTargets.map((target) => normalizeTarget(target).replace(/\/+$/, ''));
  if (normalizedTargets.some((target) => target === 'lib/game-engine' || target === '__tests__/lib/game-engine')) {
    coverageIncludes.push(
      'lib/game-engine/GameEngine.ts',
      'lib/game-engine/SettlementService.ts',
      'lib/game-engine/SnapshotService.ts',
      'lib/game-engine/LockManager.ts'
    );
    // These are exercised by game-engine tests (including payment notify and ws gateway regression tests).
    coverageIncludes.push('app/api/payment/notify/route.ts');
  }
  for (const target of testTargets) {
    const normalized = normalizeTarget(target);
    // When passing a test file under __tests__/lib/**, include the corresponding source file for coverage.
    if (normalized.startsWith('__tests__/lib/') && normalized.endsWith('.test.ts')) {
      coverageIncludes.push(normalized.replace(/^__tests__\//, '').replace(/\.test\.ts$/, '.ts'));
      continue;
    }
    if (
      normalized.endsWith('.ts') &&
      (normalized.startsWith('lib/') || normalized.startsWith('app/') || normalized.startsWith('server/'))
    ) {
      coverageIncludes.push(normalized);
    }
  }
}
const coverageFlags = [];
if (enableCoverage) {
  coverageFlags.push('--experimental-test-coverage');
  for (const include of coverageIncludes) {
    coverageFlags.push(`--test-coverage-include=${include}`);
  }
  if (coverageThresholds) {
    let parsed;
    try {
      parsed = JSON.parse(coverageThresholds);
    } catch {
      parsed = coverageThresholds;
    }

    const extract = (key) => {
      if (parsed && typeof parsed === 'object' && parsed.global && typeof parsed.global[key] === 'number') {
        return parsed.global[key];
      }
      if (typeof parsed === 'string') {
        const match = parsed.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
        if (match) return Number(match[1]);
      }
      return null;
    };

    const branches = extract('branches');
    const functions = extract('functions');
    const lines = extract('lines');
    if (branches !== null) coverageFlags.push(`--test-coverage-branches=${branches}`);
    if (functions !== null) coverageFlags.push(`--test-coverage-functions=${functions}`);
    if (lines !== null) coverageFlags.push(`--test-coverage-lines=${lines}`);
  }
}

const nodeArgs = ['--test', '--import', 'tsx', ...coverageFlags, ...extraFlags, ...resolvedTargets];

const env = { ...process.env };
if (enableCoverage) {
  const dir = resolve(coverageDirectory || 'coverage');
  mkdirSync(dir, { recursive: true });
  env.NODE_V8_COVERAGE = dir;
}

const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit', env });
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
child.on('error', () => {
  process.exit(1);
});
