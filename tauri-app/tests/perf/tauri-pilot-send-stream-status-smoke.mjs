import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-status-smoke-${Date.now()}`;
const WAIT_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 180000);
const PROMPT = process.env.AGENTREE_TAURI_PILOT_PROMPT
  ?? `Start your reply with ${LABEL}. Then write exactly two short sentences.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execFileText = (cmd, args, options = {}) => new Promise((resolve, reject) => {
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

const parseProcessInventory = (text) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const devRuntime = [];
  const packaged = [];
  const tauriDev = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    const pid = match ? Number(match[1]) : null;
    const command = match ? match[2] : line;
    if (/\/Applications\/agentree\.app\/Contents\/MacOS\/agentree$/.test(command)) {
      packaged.push({ pid, command });
    } else if (/(^| )target\/debug\/agentree$/.test(command)) {
      devRuntime.push({ pid, command });
    } else if (/npm run tauri dev|node .*tauri dev/.test(command)) {
      tauriDev.push({ pid, command });
    }
  }
  return { lines, devRuntime, packaged, tauriDev };
};

const preflight = async () => {
  const raw = await execFileText('ps', ['-axo', 'pid=,command=']);
  const inventory = parseProcessInventory(raw);
  if (inventory.packaged.length > 0) {
    throw new Error(`Packaged Agentree app is running; close it before smoke QA: ${JSON.stringify(inventory.packaged)}`);
  }
  if (inventory.devRuntime.length !== 1) {
    throw new Error(`Expected exactly one target/debug/agentree process, found ${inventory.devRuntime.length}: ${JSON.stringify(inventory.devRuntime)}`);
  }

  const devPid = inventory.devRuntime[0].pid;
  if (!devPid) throw new Error('Could not derive dev Agentree PID.');
  await execFileText('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${devPid}) to true`]);
  await sleep(500);

  const visible = (await pilotEval(`
(() => ({
  visibility: document.visibilityState,
  hidden: document.hidden,
  hasFocus: document.hasFocus(),
  url: location.href,
  composerCount: document.querySelectorAll('textarea').length,
  graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
}))()
`, 30000)).value;
  if (visible?.visibility !== 'visible' || visible?.hidden === true || visible?.hasFocus !== true) {
    throw new Error(`Tauri webview is not visible and focused: ${JSON.stringify(visible)}`);
  }
  let readyVisible = visible;
  const startedAt = Date.now();
  while (!readyVisible?.composerCount && Date.now() - startedAt < 5000) {
    await sleep(150);
    readyVisible = (await pilotEval(`
(() => ({
  visibility: document.visibilityState,
  hidden: document.hidden,
  hasFocus: document.hasFocus(),
  url: location.href,
  composerCount: document.querySelectorAll('textarea').length,
  graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
}))()
`, 30000)).value;
  }
  if (!readyVisible?.composerCount) {
    throw new Error(`Composer not found in visible Tauri webview: ${JSON.stringify(readyVisible)}`);
  }
  if (readyVisible?.visibility !== 'visible' || readyVisible?.hidden === true || readyVisible?.hasFocus !== true) {
    throw new Error(`Tauri webview lost visible/focused state: ${JSON.stringify(readyVisible)}`);
  }
  return { inventory, visible: readyVisible };
};

const installProbe = async () => {
  return await pilotEval(`
(() => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompt = ${JSON.stringify(PROMPT)};
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  window.__AGENTREE_STATUS_SMOKE__?.cleanup?.();

  const probe = {
    label,
    prompt,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    sentAtIso: null,
    assistantId: null,
    firstUserVisibleAtMs: null,
    firstAssistantIdAtMs: null,
    firstLiveTextAtMs: null,
    firstTerminalAtMs: null,
    liveTextBaselineByAssistantId: {},
    samples: [],
    errors: [],
    done: false,
    cleanup: null,
  };

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'error']);
  const activeStatuses = new Set(['pending', 'creating', 'initializing', 'running', 'streaming']);

  const escapeSelector = (value) => (
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : String(value).replace(/"/g, '\\"')
  );
  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const findComposer = () => chatHotPath.findComposer();
  const findSendButton = () => chatHotPath.findSendButton();

  const visibleText = (element) => element?.innerText || element?.textContent || '';
  const statusFromText = (text) => {
    const lower = String(text || '').toLowerCase();
    if (lower.includes('completed')) return 'completed';
    if (lower.includes('failed') || lower.includes('error')) return 'failed';
    if (lower.includes('cancelled')) return 'cancelled';
    if (lower.includes('running') || lower.includes('streaming')) return 'running';
    if (lower.includes('pending')) return 'pending';
    return null;
  };

  const titleStatus = (root) => {
    if (!root) return null;
    const titleElement = [...root.querySelectorAll('[title]')]
      .find((element) => /agent (completed|running|failed|error|cancelled|pending)/i.test(element.getAttribute('title') || ''));
    return titleElement ? statusFromText(titleElement.getAttribute('title')) : null;
  };

  const latestAssistantEvent = () => {
    const sentAtMs = Date.parse(probe.sentAtIso || '');
    const events = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return events
      .filter((event) => event?.name === 'run-status.changed')
      .filter((event) => {
        const eventAtMs = Date.parse(event?.ts || '');
        return Number.isFinite(sentAtMs) && Number.isFinite(eventAtMs) && eventAtMs >= sentAtMs;
      })
      .filter((event) => event?.details?.role === 'assistant' && event?.details?.nodeId)
      .slice()
      .reverse()[0] || null;
  };

  const latestTerminalEvent = () => {
    const sentAtMs = Date.parse(probe.sentAtIso || '');
    const events = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return events
      .filter((event) => event?.name === 'run-status.changed')
      .filter((event) => {
        const eventAtMs = Date.parse(event?.ts || '');
        return Number.isFinite(sentAtMs) && Number.isFinite(eventAtMs) && eventAtMs >= sentAtMs;
      })
      .findLast?.((event) => terminalStatuses.has(event?.details?.nextStatus)) ||
      events
        .filter((event) => event?.name === 'run-status.changed')
        .slice()
        .reverse()
        .find((event) => terminalStatuses.has(event?.details?.nextStatus)) ||
      null;
  };

  const clickViewMode = async (title) => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.getAttribute('title') === title || (candidate.textContent || '').trim() === title.replace(' View', ''));
    if (!button) return false;
    button.click();
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    return true;
  };

  const sample = async (label) => {
    const assistantEvent = latestAssistantEvent();
    const eventAssistantId = assistantEvent?.details?.nodeId ?? null;
    if (
      eventAssistantId &&
      (
        !probe.assistantId ||
        String(probe.assistantId).startsWith('opt-') ||
        !String(eventAssistantId).startsWith('opt-')
      )
    ) {
      const changedId = probe.assistantId !== eventAssistantId;
      probe.assistantId = eventAssistantId;
      if (changedId || !probe.firstAssistantIdAtMs) {
        probe.firstAssistantIdAtMs = Number((performance.now() - probe.startedAt).toFixed(2));
      }
    }
    const terminalEvent = latestTerminalEvent();
    if (!probe.firstTerminalAtMs && terminalEvent?.details?.nextStatus) {
      probe.firstTerminalAtMs = Number((performance.now() - probe.startedAt).toFixed(2));
    }

    const assistantId = probe.assistantId;
    const chatElement = assistantId
      ? document.querySelector('[data-chat-focus-id="' + escapeSelector(assistantId) + '"]')
      : null;
    const graphElement = assistantId
      ? document.querySelector('[data-agentree-graph-node-id="' + escapeSelector(assistantId) + '"], .react-flow__node[data-id="' + escapeSelector(assistantId) + '"]')
      : null;
    const timelineElement = assistantId
      ? document.querySelector('[data-agentree-timeline-message-id="' + escapeSelector(assistantId) + '"], #' + escapeSelector(assistantId))
      : null;
    const bodyText = document.body.innerText || '';

    const chatText = visibleText(chatElement);
    if (!probe.firstUserVisibleAtMs && chatHotPath.hasPromptToken({ bodyText, chatText, label })) {
      probe.firstUserVisibleAtMs = Number((performance.now() - probe.startedAt).toFixed(2));
    }
    if (assistantId && chatText && !terminalEvent?.details?.nextStatus) {
      const baseline = probe.liveTextBaselineByAssistantId[assistantId];
      if (!baseline) {
        probe.liveTextBaselineByAssistantId[assistantId] = {
          textLength: chatText.length,
          atMs: Number((performance.now() - probe.startedAt).toFixed(2)),
        };
      } else if (!probe.firstLiveTextAtMs && chatText.length >= baseline.textLength + 8) {
        probe.firstLiveTextAtMs = Number((performance.now() - probe.startedAt).toFixed(2));
      }
    }

    const item = {
      label,
      at: new Date().toISOString(),
      elapsedMs: Number((performance.now() - probe.startedAt).toFixed(2)),
      assistantId,
      chat: {
        exists: Boolean(chatElement),
        status: statusFromText(chatText) || titleStatus(chatElement),
        textLength: chatText.length,
        hasPromptToken: chatText.includes(probe.label),
      },
      graph: {
        exists: Boolean(graphElement),
        status: titleStatus(graphElement) || statusFromText(visibleText(graphElement)),
        textLength: visibleText(graphElement).length,
      },
      timeline: {
        exists: Boolean(timelineElement),
        status: titleStatus(timelineElement) || statusFromText(visibleText(timelineElement)),
        textLength: visibleText(timelineElement).length,
      },
      terminalStatus: terminalEvent?.details?.nextStatus || null,
      terminalEvent,
      activeStatusCount: (window.__AGENTREE_PERF__?.readLatestSession?.() ?? [])
        .filter((event) => event?.name === 'run-status.changed' && activeStatuses.has(event?.details?.nextStatus))
        .length,
    };
    probe.samples.push(item);
    return item;
  };

  const send = async () => {
    await chatHotPath.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
    const textarea = findComposer();
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const sendButton = findSendButton();
    if (!sendButton) throw new Error('send button not found');
    if (sendButton.disabled) throw new Error('send button disabled');
    probe.sentAtIso = new Date().toISOString();
    sendButton.click();
    await sample('sent');
  };

  const finish = async () => {
    await clickViewMode('Branch View');
    await sample('branch-final');
    await clickViewMode('Timeline View');
    await sample('timeline-final');
    await clickViewMode('Branch View');
    await sample('done');

    const finalSample = probe.samples[probe.samples.length - 1];
    const timelineSample = probe.samples.findLast?.((entry) => entry.label === 'timeline-final') || null;
    const branchSample = probe.samples.findLast?.((entry) => entry.label === 'branch-final') || null;
    const terminalStatus = finalSample?.terminalStatus;
    if (!probe.firstUserVisibleAtMs) probe.errors.push({ message: 'user prompt was not visible in chat/body' });
    if (!probe.assistantId) probe.errors.push({ message: 'assistant node id was not observed from run-status projection events' });
    if (!probe.firstLiveTextAtMs) probe.errors.push({ message: 'live assistant text did not grow while the run was active' });
    if (!terminalStatuses.has(terminalStatus)) probe.errors.push({ message: 'terminal status was not observed', terminalStatus });
    if (!branchSample?.graph?.exists) probe.errors.push({ message: 'graph assistant node was not found for final parity sample', assistantId: probe.assistantId });
    if (!timelineSample?.timeline?.exists) probe.errors.push({ message: 'timeline assistant row was not found for final parity sample', assistantId: probe.assistantId });
    if (branchSample?.graph?.exists && terminalStatus && branchSample.graph.status && branchSample.graph.status !== terminalStatus) {
      probe.errors.push({ message: 'graph status mismatch', graphStatus: branchSample.graph.status, terminalStatus });
    }
    if (timelineSample?.timeline?.exists && terminalStatus && timelineSample.timeline.status && timelineSample.timeline.status !== terminalStatus) {
      probe.errors.push({ message: 'timeline status mismatch', timelineStatus: timelineSample.timeline.status, terminalStatus });
    }
    if (finalSample?.chat?.status && terminalStatus && finalSample.chat.status !== terminalStatus) {
      probe.errors.push({ message: 'chat status mismatch', chatStatus: finalSample.chat.status, terminalStatus });
    }
    probe.done = true;
  };

  const run = async () => {
    try {
      await send();
      const startedAt = performance.now();
      while (performance.now() - startedAt < ${JSON.stringify(WAIT_TIMEOUT_MS)}) {
        const current = await sample('poll');
        if (terminalStatuses.has(current.terminalStatus)) {
          await new Promise((resolve) => window.setTimeout(resolve, 3500));
          await finish();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      probe.errors.push({ message: 'timed out waiting for terminal status' });
      probe.done = true;
    } catch (error) {
      probe.errors.push({ message: String(error?.message || error), stack: error?.stack || null });
      probe.done = true;
    }
  };

  probe.cleanup = () => {};
  window.__AGENTREE_STATUS_SMOKE__ = probe;
  void run();
  return { label, promptLength: prompt.length, url: location.href };
})()
`, 60000);
};

const waitForDone = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS + 30000) {
    const state = (await pilotEval(`
(() => {
  const probe = window.__AGENTREE_STATUS_SMOKE__;
  return {
    done: Boolean(probe?.done),
    assistantId: probe?.assistantId ?? null,
    firstUserVisibleAtMs: probe?.firstUserVisibleAtMs ?? null,
    firstLiveTextAtMs: probe?.firstLiveTextAtMs ?? null,
    firstTerminalAtMs: probe?.firstTerminalAtMs ?? null,
    errors: probe?.errors ?? [],
    sampleCount: probe?.samples?.length ?? 0,
  };
})()
`, 30000)).value;
    if (state.done) return state;
    await sleep(1000);
  }
  return { done: false, timedOut: true };
};

const collect = async () => {
  return await pilotEval(`
(async () => {
  const probe = window.__AGENTREE_STATUS_SMOKE__;
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 120000);
};

const main = async () => {
  const report = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    prompt: PROMPT,
    preflight: null,
    install: null,
    wait: null,
    collect: null,
    errors: [],
  };

  try {
    report.preflight = await preflight();
    report.install = (await installProbe()).value;
    report.wait = await waitForDone();
  } catch (error) {
    report.errors.push({ phase: 'preflight-install-wait', message: error.message, stack: error.stack });
  }

  try {
    report.collect = (await collect()).value;
  } catch (error) {
    report.errors.push({ phase: 'collect', message: error.message, stack: error.stack });
  }

  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({ reportPath, report });

  const probeErrors = report.collect?.probe?.errors ?? [];
  const errors = [
    ...report.errors.map((error) => `${error.phase}: ${error.message}`),
    ...probeErrors.map((error) => error.message),
  ];
  const summary = {
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    assistantId: report.collect?.probe?.assistantId ?? null,
    firstUserVisibleAtMs: report.collect?.probe?.firstUserVisibleAtMs ?? null,
    firstLiveTextAtMs: report.collect?.probe?.firstLiveTextAtMs ?? null,
    firstTerminalAtMs: report.collect?.probe?.firstTerminalAtMs ?? null,
    terminalStatus: report.collect?.probe?.samples?.findLast?.((sample) => sample.terminalStatus)?.terminalStatus ?? null,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0 || !report.collect?.probe?.done) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
