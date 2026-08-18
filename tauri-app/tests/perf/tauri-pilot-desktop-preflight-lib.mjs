import { execFileSync } from 'node:child_process';

export const parseAgentreeDesktopProcessInventory = (text) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const devRuntime = [];
  const packaged = [];

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    const pid = match ? Number(match[1]) : null;
    const command = match ? match[2] : line;
    if (/\/Applications\/agentree\.app\/Contents\/MacOS\/agentree(?:\s|$)/.test(command)) {
      packaged.push({ pid, command });
    } else if (/(^|[ /])target\/debug\/agentree(?:\s|$)/.test(command)) {
      devRuntime.push({ pid, command });
    }
  }

  return { lines, devRuntime, packaged };
};

export const assertSingleDevAgentreeRuntime = () => {
  const raw = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const inventory = parseAgentreeDesktopProcessInventory(raw);

  if (inventory.packaged.length > 0) {
    throw new Error(`desktop preflight failed: close packaged Agentree before perf tests: ${JSON.stringify(inventory.packaged)}`);
  }

  if (inventory.devRuntime.length !== 1) {
    throw new Error(`desktop preflight failed: expected exactly one target/debug/agentree process, found ${inventory.devRuntime.length}: ${JSON.stringify(inventory.devRuntime)}`);
  }

  return {
    inventory,
    devProcess: inventory.devRuntime[0],
  };
};

export const assertVisibleFocusedWebviewSource = `
(() => {
  const state = {
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    url: location.href,
    focusOverride: globalThis.__AGENTREE_TAURI_PILOT_ALLOW_VISIBLE_UNFOCUSED_WEBVIEW === true,
  };
  if (state.visibility !== 'visible' || state.hidden === true) {
    throw new Error('desktop webview preflight failed: ' + JSON.stringify(state));
  }
  if (state.hasFocus !== true && state.focusOverride !== true) {
    throw new Error('desktop webview preflight failed: ' + JSON.stringify(state));
  }
  return state;
})()
`;
