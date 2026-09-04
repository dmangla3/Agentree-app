import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

const hasConfigArg = args.some((arg, index) => (
  arg === '--config'
  || arg.startsWith('--config=')
  || (index > 0 && args[index - 1] === '--config')
));

const tauriArgs = args[0] === 'dev' && !hasConfigArg
  ? ['dev', '--config', 'src-tauri/tauri.dev.conf.json', ...args.slice(1)]
  : args;

const child = spawn('tauri', tauriArgs, {
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
