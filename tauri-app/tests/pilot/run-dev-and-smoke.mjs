import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const WAIT_MS = process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? '180000';
const randomPort = () => String(42000 + Math.floor(Math.random() * 20000));
const AUTH_CALLBACK_PORT = process.env.AGENTREE_AUTH_CALLBACK_PORT ?? randomPort();
const MCP_PORT = process.env.AGENTREE_MCP_PORT ?? process.env.MCP_PORT ?? randomPort();
const REQUIRED_PORTS = [Number(AUTH_CALLBACK_PORT), Number(MCP_PORT)].filter(Number.isFinite);

const checkPortOpen = (port) => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setTimeout(300);
  socket.on('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('timeout', () => {
    socket.destroy();
    resolve(false);
  });
  socket.on('error', () => resolve(false));
});

const preflight = async () => {
  const ps = spawn('ps', ['-axo', 'pid=,command='], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  for await (const chunk of ps.stdout) stdout += chunk;
  const matching = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /target\/debug\/agentree|npm run tauri -- dev|tauri dev/.test(line))
    .filter((line) => !line.includes('tests/pilot/run-dev-and-smoke.mjs'));
  if (matching.length > 0) {
    throw new Error(`Close existing Agentree dev processes before running Pilot test:\n${matching.join('\n')}`);
  }

  if (process.env.AGENTREE_TAURI_PILOT_ALLOW_BOUND_PORTS === 'true') return;
  const openPorts = [];
  for (const port of REQUIRED_PORTS) {
    if (await checkPortOpen(port)) openPorts.push(port);
  }
  if (openPorts.length > 0) {
    throw new Error(`Required local ports are already in use: ${openPorts.join(', ')}. Stop the existing app/server first, or set AGENTREE_TAURI_PILOT_ALLOW_BOUND_PORTS=true if intentional.`);
  }
};

const killTree = (child) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // best-effort cleanup
    }
  }
};

const run = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
    detached: options.detached ?? false,
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
  });
});

const main = async () => {
  await preflight();

  const dev = spawn('npm', ['run', 'tauri', '--', 'dev'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTREE_AUTH_CALLBACK_PORT: AUTH_CALLBACK_PORT,
      AGENTREE_MCP_PORT: MCP_PORT,
      MCP_PORT,
    },
    detached: true,
  });

  const cleanup = () => killTree(dev);
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    await run('node', ['./tests/pilot/smoke-ui.mjs'], {
      env: {
        ...process.env,
        AGENTREE_TAURI_PILOT_WAIT_MS: WAIT_MS,
      },
    });
  } finally {
    cleanup();
  }
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
