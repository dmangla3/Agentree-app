import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-cancel-flow-${Date.now()}`;
const WAIT_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const PROMPT = process.env.AGENTREE_TAURI_PILOT_PROMPT
  ?? `Start with ${LABEL}. Then continue writing numbered short paragraphs until stopped.`;

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
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    const pid = match ? Number(match[1]) : null;
    const command = match ? match[2] : line;
    if (/\/Applications\/agentree\.app\/Contents\/MacOS\/agentree$/.test(command)) {
      packaged.push({ pid, command });
    } else if (/(^| )target\/debug\/agentree$/.test(command)) {
      devRuntime.push({ pid, command });
    }
  }
  return { lines, devRuntime, packaged };
};

const preflight = async () => {
  const inventory = parseProcessInventory(await execFileText('ps', ['-axo', 'pid=,command=']));
  if (inventory.packaged.length > 0) {
    throw new Error(`Packaged Agentree app is running; close it before perf QA: ${JSON.stringify(inventory.packaged)}`);
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

const installProbe = async () => pilotEval(`
(() => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompt = ${JSON.stringify(PROMPT)};
  const waitTimeoutMs = ${JSON.stringify(WAIT_TIMEOUT_MS)};
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  window.__AGENTREE_CANCEL_FLOW__?.cleanup?.();

  const probe = {
    label,
    promptLength: prompt.length,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    sentAtIso: null,
    cancelVisibleAtIso: null,
    cancelClickedAtIso: null,
    flowId: null,
    assistantId: null,
    samples: [],
    errors: [],
    done: false,
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const elapsedMs = () => Number((performance.now() - probe.startedAt).toFixed(2));
  const events = () => window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const findComposer = () => chatHotPath.findComposer();
  const statusButton = () => chatHotPath.findSendButton({ includeCancel: true });
  const sendButton = () => chatHotPath.findSendButton();
  const buttonLabel = () => {
    const button = statusButton();
    return button ? (button.getAttribute('aria-label') || button.textContent || '').trim() : null;
  };
  const latestFlowStarted = () => {
    const sentAt = Date.parse(probe.sentAtIso || '');
    return events()
      .filter((event) => event?.name === 'send-flow.flow.started')
      .slice()
      .reverse()
      .find((event) => {
        const eventAt = Date.parse(event?.ts || '');
        return Number.isFinite(sentAt) && Number.isFinite(eventAt) && eventAt >= sentAt - 100;
      }) || null;
  };
  const latestTerminal = () => events()
    .filter((event) => ['send-flow.lifecycle.cancelled', 'send-flow.lifecycle.failed', 'send-flow.lifecycle.completed'].includes(event?.name))
    .slice()
    .reverse()
    .find((event) => !probe.flowId || event?.details?.flowId === probe.flowId) || null;
  const latestRunStatus = () => {
    const sentAt = Date.parse(probe.sentAtIso || '');
    return events()
      .filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared')
      .filter((event) => {
        const eventAt = Date.parse(event?.ts || '');
        return !Number.isFinite(sentAt) || (Number.isFinite(eventAt) && eventAt >= sentAt - 100);
      })
      .slice()
      .reverse()
      .find((event) => (
        !probe.assistantId ||
        event?.details?.nodeId === probe.assistantId ||
        event?.details?.nextStatus === 'cancelled' ||
        event?.details?.status === 'cancelled'
      )) || null;
  };

  const sample = (label) => {
    const flowStarted = latestFlowStarted();
    if (flowStarted?.details?.flowId && !probe.flowId) {
      probe.flowId = flowStarted.details.flowId;
      probe.assistantId = flowStarted.details.optimisticAssistantMessageId ?? flowStarted.details.assistantId ?? null;
    }
    const terminal = latestTerminal();
    const runStatus = latestRunStatus();
    const runStatusNodeId = runStatus?.details?.nodeId ?? null;
    if (
      runStatusNodeId &&
      (!probe.assistantId || String(probe.assistantId).startsWith('opt-') || !String(runStatusNodeId).startsWith('opt-'))
    ) {
      probe.assistantId = runStatusNodeId;
    }
    const textarea = findComposer();
    const item = {
      label,
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      buttonLabel: buttonLabel(),
      buttonDisabled: statusButton()?.disabled ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      textareaValueLength: textarea?.value?.length ?? null,
      flowId: probe.flowId,
      assistantId: probe.assistantId,
      terminalName: terminal?.name ?? null,
      runStatus: runStatus?.details?.nextStatus ?? runStatus?.details?.status ?? null,
      graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
    };
    probe.samples.push(item);
    return item;
  };

  const send = async () => {
    await chatHotPath.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
    const textarea = findComposer();
    if (!textarea) throw new Error('composer textarea missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    const waitStartedAt = performance.now();
    let button = sendButton();
    while ((!button || button.disabled) && performance.now() - waitStartedAt < 5000) {
      await sleep(100);
      button = sendButton();
    }
    if (!button) throw new Error('send button missing after prompt');
    if (button.disabled) throw new Error('send button disabled before cancel flow send');
    probe.sentAtIso = new Date().toISOString();
    button.click();
    sample('sent');
  };

  const waitForCancelButton = async () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 30000) {
      const current = sample('wait-cancel-button');
      if (chatHotPath.isCancelLabel(current.buttonLabel)) {
        probe.cancelVisibleAtIso = probe.cancelVisibleAtIso ?? new Date().toISOString();
        return current;
      }
      await sleep(150);
    }
    throw new Error('cancel button did not appear after send');
  };

  const clickCancel = async () => {
    const button = statusButton();
    if (!button) throw new Error('cancel button missing');
    const labelText = buttonLabel();
    if (!chatHotPath.isCancelLabel(labelText)) {
      throw new Error('expected cancel button, got ' + labelText);
    }
    probe.cancelClickedAtIso = new Date().toISOString();
    button.click();
    sample('cancel-clicked');
  };

  const waitForCancelled = async () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < waitTimeoutMs) {
      const current = sample('wait-cancelled');
      if (current.terminalName === 'send-flow.lifecycle.cancelled' || current.runStatus === 'cancelled') {
        await sleep(500);
        sample('cancelled');
        return;
      }
      await sleep(300);
    }
    throw new Error('timed out waiting for cancelled lifecycle');
  };

  const run = async () => {
    try {
      sample('installed');
      await send();
      await waitForCancelButton();
      await clickCancel();
      await waitForCancelled();
      const final = sample('done');
      if (chatHotPath.isCancelLabel(final.buttonLabel)) {
        probe.errors.push({ message: 'composer still shows cancel after cancelled lifecycle' });
      }
      if (final.textareaDisabled) {
        probe.errors.push({ message: 'composer textarea still disabled after cancelled lifecycle' });
      }
      probe.done = true;
    } catch (error) {
      probe.errors.push({ message: String(error?.message || error), stack: error?.stack || null });
      probe.done = true;
    }
  };

  probe.cleanup = () => {};
  window.__AGENTREE_CANCEL_FLOW__ = probe;
  void run();
  return { label, promptLength: prompt.length, url: location.href };
})()
`, 60000);

const waitForDone = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS + 30000) {
    const state = (await pilotEval(`
(() => {
  const probe = window.__AGENTREE_CANCEL_FLOW__;
  return {
    done: Boolean(probe?.done),
    flowId: probe?.flowId ?? null,
    assistantId: probe?.assistantId ?? null,
    sentAtIso: probe?.sentAtIso ?? null,
    cancelVisibleAtIso: probe?.cancelVisibleAtIso ?? null,
    cancelClickedAtIso: probe?.cancelClickedAtIso ?? null,
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

const collect = async () => pilotEval(`
(async () => {
  const probe = window.__AGENTREE_CANCEL_FLOW__;
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 120000);

const summarizeRuntime = (perfEvents) => {
  const eventLoopStalls = perfEvents.filter((event) => event?.name === 'runtime.event-loop-stall');
  const rafStalls = perfEvents.filter((event) => event?.name === 'runtime.raf-stall');
  const maxDuration = (items) => items.reduce((max, event) => Math.max(max, Number(event?.durationMs ?? 0)), 0);
  return {
    eventLoopStallCount: eventLoopStalls.length,
    rafStallCount: rafStalls.length,
    maxEventLoopStallMs: maxDuration(eventLoopStalls),
    maxRafStallMs: maxDuration(rafStalls),
  };
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

  const probe = report.collect?.probe ?? null;
  const finalSample = probe?.samples?.[probe.samples.length - 1] ?? null;
  const runtime = summarizeRuntime(report.collect?.perfEvents ?? []);
  const errors = [
    ...report.errors.map((error) => `${error.phase}: ${error.message}`),
    ...(probe?.errors ?? []).map((error) => error.message),
  ];
  if (!probe?.done) errors.push('cancel flow did not finish');
  if (!probe?.cancelClickedAtIso) errors.push('cancel button was not clicked');
  if (finalSample?.terminalName !== 'send-flow.lifecycle.cancelled' && finalSample?.runStatus !== 'cancelled') {
    errors.push(`cancelled terminal status was not observed; terminal=${finalSample?.terminalName ?? 'none'} runStatus=${finalSample?.runStatus ?? 'none'}`);
  }
  const msBetween = (startIso, endIso) => {
    const start = Date.parse(startIso || '');
    const end = Date.parse(endIso || '');
    return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
  };

  console.log(JSON.stringify({
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    flowId: probe?.flowId ?? null,
    assistantId: probe?.assistantId ?? null,
    sentAtIso: probe?.sentAtIso ?? null,
    cancelVisibleAtIso: probe?.cancelVisibleAtIso ?? null,
    cancelClickedAtIso: probe?.cancelClickedAtIso ?? null,
    sendToCancelVisibleMs: msBetween(probe?.sentAtIso, probe?.cancelVisibleAtIso),
    sendToCancelClickedMs: msBetween(probe?.sentAtIso, probe?.cancelClickedAtIso),
    finalButtonLabel: finalSample?.buttonLabel ?? null,
    finalTextareaDisabled: finalSample?.textareaDisabled ?? null,
    runtime,
    errors,
  }, null, 2));

  if (errors.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
