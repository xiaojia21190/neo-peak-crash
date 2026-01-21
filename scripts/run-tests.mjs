import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);

let enableCoverage = false;
let coverageDirectory = undefined;
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

  passthrough.push(arg);
}

const nodeArgs = ['--test', '--import', 'tsx', 'tests/*.test.ts', ...passthrough];
if (enableCoverage) {
  nodeArgs.splice(1, 0, '--experimental-test-coverage');
}

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

