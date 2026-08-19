import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-steering-surfaces-${Date.now()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execText = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const requirePilotCli = async () => {
  try {
    await execText('tauri-pilot', ['--help']);
  } catch {
    throw new Error('tauri-pilot CLI is not available. Run `npm run pilot:install` first.');
  }
};

const waitForPilot = async () => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < WAIT_MS) {
    try {
      await execText('tauri-pilot', ['ping']);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for Tauri Pilot after ${WAIT_MS}ms: ${lastError?.stderr || lastError?.stdout || lastError?.message || 'no response'}`);
};

const pilotEval = async (script, timeoutMs = 60000) => {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('tauri-pilot', ['eval', '--json', '-'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`tauri-pilot eval timed out after ${timeoutMs}ms: ${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`tauri-pilot eval exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve({ value: stdout.trim() ? JSON.parse(stdout) : null, roundTripMs: Date.now() - startedAt });
      } catch (error) {
        reject(new Error(`failed to parse tauri-pilot JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.end(script);
  });
};

await requirePilotCli();
await waitForPilot();

const report = (await pilotEval(`
(async () => {
  const label = ${JSON.stringify(LABEL)};
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const visible = (element) => Boolean(element && (element.offsetParent || element.getClientRects().length));
  const text = (element) => (element?.textContent || '').trim();
  const labelFor = (element) => (element?.getAttribute?.('aria-label') || text(element)).trim();
  const findButton = (label) => [...document.querySelectorAll('button')]
    .find((button) => visible(button) && labelFor(button) === label) || null;
  const findComposer = () => document.querySelector('[data-testid="chat-composer-textarea"]');
  const setTextControl = (element, value) => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(element, value);
    element.focus();
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const hoverElement = async (element) => {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.min(12, Math.max(1, rect.width / 2));
    const clientY = rect.top + Math.min(12, Math.max(1, rect.height / 2));
    for (const type of ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter', 'mousemove']) {
      const bubbles = !type.endsWith('enter');
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles, pointerType: 'mouse', clientX, clientY })
        : new MouseEvent(type, { bubbles, clientX, clientY });
      element.dispatchEvent(event);
      await sleep(60);
    }
  };
  const waitFor = async (predicate, timeoutMs = 5000, intervalMs = 25) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  };

  const appModule = (path) => new URL(path, location.href).href;
  const workspaceStoreModule = await import(appModule('/src/stores/workspaceStore.ts'));
  const runStatusStoreModule = await import(appModule('/src/stores/runStatusStore.ts'));
  const agentClientModule = await import(appModule('/src/lib/agentClient.ts'));
  const tauriBindingsModule = await import(appModule('/src/generated/tauri-bindings.ts'));
  const workspaceStore = workspaceStoreModule.useWorkspaceStore;
  const runStatusStore = runStatusStoreModule.useRunStatusStore;
  const queryClient = window.__AGENTREE_QUERY_CLIENT__;
  if (!queryClient) throw new Error('query client is not exposed');

  const workspaceId = workspaceStore.getState().selectedWorkspaceId;
  if (!workspaceId) throw new Error('no selected workspace');

  const queryKey = ['messages', workspaceId];
  const localNodeQueryKey = ['local-nodes', workspaceId];
  const previousMessages = queryClient.getQueryData(queryKey) ?? [];
  const previousLocalNodes = queryClient.getQueryData(localNodeQueryKey) ?? [];
  const messageById = new Map(previousMessages.map((message) => [message.id, message]));
  const runStatusById = runStatusStore.getState().byNodeId;
  const assistantCandidates = [...document.querySelectorAll('[data-agentree-graph-node-id]')]
    .map((element) => element.getAttribute('data-agentree-graph-node-id'))
    .filter((id) => id && messageById.get(id)?.role === 'assistant');
  const assistantId = assistantCandidates.find((id) => !runStatusById[id]?.status) ?? assistantCandidates[0];
  if (!assistantId) throw new Error('no rendered assistant graph node found');
  const previousFocus = workspaceStore.getState().focusedMessageId;
  const originalSteerAgentRun = agentClientModule.agentClient.steerAgentRun;
  const originalCommandSteerAgentRun = tauriBindingsModule.commands.steerAgentRun;
  const calls = [];
  let forceRunStatusTimer = null;

  try {
    queryClient.setQueryData(queryKey, previousMessages.map((message) => (
      message.id === assistantId
        ? { ...message, status: 'running' }
        : message
    )));
    const assistantMessage = messageById.get(assistantId);
    queryClient.setQueryData(localNodeQueryKey, [
      ...previousLocalNodes.filter((row) => row.nodeId !== assistantId),
      {
        nodeId: assistantId,
        workspaceId,
        syncStatus: 'persisted',
        finalizedAt: Math.floor(Date.now() / 1000),
        serverAckAt: Math.floor(Date.now() / 1000),
        retryAttempt: 0,
        message: {
          ...assistantMessage,
          id: assistantId,
          workspaceId,
          role: 'assistant',
          status: 'running',
        },
      },
    ]);
    agentClientModule.agentClient.steerAgentRun = async (assistantNodeId, content, idempotencyKey) => {
      calls.push({ assistantNodeId, content, idempotencyKey });
    };
    tauriBindingsModule.commands.steerAgentRun = async (assistantNodeId, content, idempotencyKey) => {
      calls.push({ assistantNodeId, content, idempotencyKey });
      return null;
    };
    const forceRunningStatus = () => {
      runStatusStore.setState((state) => ({
        byNodeId: {
          ...state.byNodeId,
          [assistantId]: {
            nodeId: assistantId,
            workspaceId,
            role: 'assistant',
            status: 'running',
            progress: 'Pilot steering smoke',
            updatedAt: new Date().toISOString(),
          },
        },
        revision: state.revision + 1,
      }));
    };
    forceRunningStatus();
    forceRunStatusTimer = window.setInterval(forceRunningStatus, 100);
    workspaceStore.getState().dispatchFocus({
      messageId: assistantId,
      source: 'graph',
      metadata: { reason: 'tauri-pilot-steering-smoke' },
    });

    const hideChat = findButton('Hide chat panel');
    if (hideChat) {
      hideChat.click();
      await sleep(150);
    }
    const expandComposer = findButton('Expand graph composer') || findButton('Compose');
    if (expandComposer) {
      expandComposer.click();
      await sleep(100);
    }
    window.dispatchEvent(new Event('agentree:graph-composer-dock-expand'));

    const graphNode = await waitFor(() => document.querySelector(\`[data-agentree-graph-node-id="\${CSS.escape(assistantId)}"]\`), 6000);
    if (!graphNode) throw new Error('selected assistant graph node disappeared');

    const composer = await waitFor(() => findComposer(), 4000);
    if (!composer) throw new Error('graph composer textarea not found');
    const steerButton = await waitFor(() => {
      const button = document.querySelector('[data-testid="graph-dock-send-button"]');
      return button && labelFor(button) === 'Steer running agent' ? button : null;
    }, 4000);
    if (!steerButton) {
      throw new Error('graph composer did not enter steering mode ' + JSON.stringify({
        focusedMessageId: workspaceStore.getState().focusedMessageId,
        targetStatus: runStatusStore.getState().byNodeId[assistantId]?.status ?? null,
        graphDockButtonLabel: labelFor(document.querySelector('[data-testid="graph-dock-send-button"]')),
        graphDockText: text(document.querySelector('[data-testid="graph-dock-composer"]')).slice(0, 300),
        composerValue: findComposer()?.value ?? null,
      }));
    }

    setTextControl(composer, \`Graph composer steer \${label}\`);
    await waitFor(() => !steerButton.disabled, 1000);
    steerButton.click();
    await waitFor(() => calls.length >= 1 && (findComposer()?.value ?? '') === '', 2000);

    window.dispatchEvent(new Event('agentree:graph-viewport-interaction-start'));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    await hoverElement(graphNode);
    const hoverInput = await waitFor(() => {
      const inputs = [...document.querySelectorAll('input[aria-label="Steering prompt"]')];
      return inputs[inputs.length - 1] ?? null;
    }, 3000);
    const hoverButton = await waitFor(() => {
      const cardButton = hoverInput?.closest('[data-agentree-node-hover-card="true"]')?.querySelector('button');
      if (cardButton && labelFor(cardButton) === 'Steer') return cardButton;
      return findButton('Steer');
    }, 3000);
    if (!hoverInput || !hoverButton) throw new Error('hovercard steering controls did not render');

    setTextControl(hoverInput, \`Hovercard steer \${label}\`);
    await waitFor(() => !hoverButton.disabled, 1000);
    hoverButton.click();
    await waitFor(() => calls.length >= 2 && hoverInput.value === '', 2000);

    return {
      label,
      workspaceId,
      assistantId,
      graphComposer: {
        buttonLabel: labelFor(steerButton),
        textareaCleared: (findComposer()?.value ?? '') === '',
      },
      hovercard: {
        inputFound: Boolean(hoverInput),
        buttonLabel: labelFor(hoverButton),
        inputCleared: hoverInput.value === '',
      },
      calls,
    };
  } finally {
    if (forceRunStatusTimer !== null) window.clearInterval(forceRunStatusTimer);
    agentClientModule.agentClient.steerAgentRun = originalSteerAgentRun;
    tauriBindingsModule.commands.steerAgentRun = originalCommandSteerAgentRun;
    queryClient.setQueryData(queryKey, previousMessages);
    queryClient.setQueryData(localNodeQueryKey, previousLocalNodes);
    runStatusStore.getState().clearRunStatus(assistantId);
    workspaceStore.getState().dispatchFocus({
      messageId: previousFocus,
      source: 'system',
      metadata: { reason: 'tauri-pilot-steering-smoke-restore' },
    });
  }
})()
`, 30000)).value;

const validation = {
  ok: report?.calls?.length === 2 &&
    report.calls[0]?.assistantNodeId === report.assistantId &&
    report.calls[1]?.content?.startsWith('Hovercard steer ') &&
    report.graphComposer?.buttonLabel === 'Steer running agent' &&
    report.graphComposer?.textareaCleared === true &&
    report.hovercard?.buttonLabel === 'Steer' &&
    report.hovercard?.inputCleared === true,
};

const out = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  report,
  validation,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${LABEL}.json`);
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ outPath, ...out }, null, 2));

if (!validation.ok) {
  throw new Error(`Tauri Pilot steering smoke failed: ${JSON.stringify(out)}`);
}
