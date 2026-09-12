import { spawn } from 'node:child_process';

const defaultArgs = [
  'src/agent-runs',
  'src/components',
  'src/domain',
  'src/hooks',
  'src/lib',
  'src/pages',
  'src/stores',
];

const args = process.argv.slice(2);
const vitestArgs = ['run', ...(args.length > 0 ? args : defaultArgs)];

const child = spawn('vitest', vitestArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
