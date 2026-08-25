import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-one-running-retarget-${Date.now()}`;
const THRESHOLD_MS = Number(process.env.AGENTREE_TAURI_PILOT_RETARGET_THRESHOLD_MS ?? 300);
const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_RETARGET_WAIT_MS ?? 5000);
const PILOT_BIN = process.env.AGENTREE_TAURI_PILOT_BIN ?? 'tauri-pilot';
const RETARGET_SETTLE_MS = Number(process.env.AGENTREE_TAURI_PILOT_RETARGET_SETTLE_MS ?? 0);
const RUNNING_PROMPT = process.env.AGENTREE_TAURI_PILOT_RUNNING_PROMPT ??
  `one running retarget setup ${LABEL}. Run /bin/zsh -lc "sleep 30; echo done" then reply done.`;
const REPLY_PROMPT = process.env.AGENTREE_TAURI_PILOT_REPLY_PROMPT ??
  `one running retarget reply ${LABEL}. Reply briefly.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pilotEval = async (script, timeoutMs = 60000) => {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(PILOT_BIN, ['eval', '--json', '-'], {
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

const DOM_HELPERS_SOURCE = `
const visible = (element) => Boolean(element && (element.offsetParent || element.getClientRects().length));
const elementLabel = (element) => (element?.getAttribute?.('aria-label') || element?.textContent || '').trim();
const findComposer = () => document.querySelector('[data-testid="chat-composer-textarea"]') || document.querySelector('textarea[placeholder^="Ask anything"]');
const findSendButton = ({ includeCancel = true } = {}) => (
  document.querySelector('[data-testid="chat-send-button"]') ||
  [...document.querySelectorAll('button')].find((button) => {
    if (!visible(button)) return false;
    const label = elementLabel(button);
    return label === 'Send' || label === 'Edit and run' || (includeCancel && (label === 'Cancel sending message' || label === 'Cancel'));
  }) ||
  null
);
const setTextarea = (textarea, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.focus();
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: value ? 'insertText' : 'deleteContentBackward', data: value || null }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
};
const sampleDom = () => {
  const button = findSendButton({ includeCancel: true });
  const textarea = findComposer();
  const bodyText = document.body.innerText || document.body.textContent || '';
  return {
    buttonLabel: elementLabel(button),
    buttonDisabled: button?.disabled ?? null,
    composerValueLength: textarea?.value?.length ?? null,
    replyTargetText: bodyText.match(/Reply to\\n[^\\n]+\\n?/i)?.[0] || bodyText.match(/REPLY TO\\s+[^\\n]+/i)?.[0] || null,
    runningText: bodyText.match(/\\d+ RUNNING/i)?.[0] || null,
    bodyTail: bodyText.slice(-700),
  };
};
const waitFor = async (predicate, timeoutMs, intervalMs = 25) => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) {
      return { value, elapsedMs: Number((performance.now() - startedAt).toFixed(2)) };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { value: null, elapsedMs: Number((performance.now() - startedAt).toFixed(2)) };
};
`;

const validateMetrics = (metrics) => {
  const fields = [
    'completedParentRetargetMs',
    'replySendEnabledAfterTypingMs',
    'replyClickReturnMs',
    'replyFeedbackVisibleMs',
  ];
  const failures = [];
  for (const field of fields) {
    const value = metrics[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      failures.push(`${field} missing`);
    } else if (value > THRESHOLD_MS) {
      failures.push(`${field} exceeded ${THRESHOLD_MS}ms: ${value}ms`);
    }
  }
  return { ok: failures.length === 0, failures, thresholdMs: THRESHOLD_MS };
};

const step = async (report, name, script, timeoutMs) => {
  const result = await pilotEval(script, timeoutMs);
  report.steps.push({ name, value: result.value, roundTripMs: result.roundTripMs });
  return result.value;
};

const collectPerf = async () => {
  try {
    return await pilotEval(`
(async () => {
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 60000);
  } catch {
    return { value: null };
  }
};

const main = async () => {
  const report = {
    label: LABEL,
    thresholdMs: THRESHOLD_MS,
    startedAt: new Date().toISOString(),
    metrics: {},
    steps: [],
    validation: null,
    exportStatus: null,
    perfEvents: [],
    errors: [],
  };

  try {
    await step(report, 'reload', 'location.reload(); true', 20000);
    await sleep(4500);
    await step(report, 'prepare', `
(async () => {
  ${DOM_HELPERS_SOURCE}
  try {
    const mod = await import('/src/stores/runStatusStore.ts');
    mod.useRunStatusStore.getState().clearAllRunStatus();
  } catch {}
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(${JSON.stringify(LABEL)});
  return sampleDom();
})()
`, 30000);

    const setup = await step(report, 'start-running-agent', `
(async () => {
  ${DOM_HELPERS_SOURCE}
  const composer = findComposer();
  if (!composer) throw new Error('composer not found');
  setTextarea(composer, ${JSON.stringify(RUNNING_PROMPT)});
  const ready = await waitFor(() => {
    const button = findSendButton({ includeCancel: false });
    return elementLabel(button) === 'Send' && !button.disabled ? button : null;
  }, 4000, 25);
  if (!ready.value) throw new Error('setup send not ready ' + JSON.stringify(sampleDom()));
  const clickStartedAt = performance.now();
  ready.value.click();
  return {
    clickReturnMs: Number((performance.now() - clickStartedAt).toFixed(2)),
    sample: sampleDom(),
  };
})()
`, 30000);
    report.metrics.setupClickReturnMs = setup.clickReturnMs;

    let running = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      running = await step(report, `poll-running-${attempt}`, `
(async () => {
  ${DOM_HELPERS_SOURCE}
  return sampleDom();
})()
`, 10000);
      if (running?.buttonLabel === 'Cancel sending message' || running?.runningText) break;
      await sleep(250);
    }
    report.metrics.runningDetected = running;
    if (!(running?.buttonLabel === 'Cancel sending message' || running?.runningText)) {
      throw new Error(`running state not detected: ${JSON.stringify(running)}`);
    }
    if (RETARGET_SETTLE_MS > 0) {
      await sleep(RETARGET_SETTLE_MS);
      const settled = await step(report, 'retarget-settle-sample', `
(async () => {
  ${DOM_HELPERS_SOURCE}
  return sampleDom();
})()
`, 10000);
      report.metrics.retargetSettleMs = RETARGET_SETTLE_MS;
      report.metrics.retargetSettledSample = settled;
    }

    const retarget = await step(report, 'click-completed-parent', `
(async () => {
  ${DOM_HELPERS_SOURCE}
  let workspaceStore = null;
  try {
    workspaceStore = (await import('/src/stores/workspaceStore.ts')).useWorkspaceStore;
  } catch {}
  const setupToken = ${JSON.stringify(LABEL)};
  const pathButtons = [...document.querySelectorAll("nav[aria-label='Workspace path'] button, [aria-label='Workspace path'] button")]
    .filter((button) => visible(button))
    .map((button) => ({
      element: button,
      aria: button.getAttribute('aria-label') || '',
      text: (button.innerText || button.textContent || '').trim(),
      current: button.getAttribute('aria-current') === 'page',
    }))
    .filter((candidate) => !candidate.current);
  const preferredPath = pathButtons.find((candidate) => candidate.aria.startsWith('User:') && candidate.aria.includes(setupToken)) ||
    pathButtons.find((candidate) => candidate.aria.startsWith('User:')) ||
    pathButtons[pathButtons.length - 1] ||
    null;
  const messageCandidates = [...document.querySelectorAll('button,[role=button],[role=group],article,li,div')]
    .filter((element) => visible(element))
    .filter((element) => element !== document.body && element.tagName !== 'TEXTAREA')
    .filter((element) => !element.closest('nav[aria-label="Workspace path"]'))
    .filter((element) => !element.closest('[data-testid="chat-send-button"]'))
    .filter((element) => (element.innerText || element.textContent || '').includes(setupToken))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.textContent || '').trim();
      return { element, text, area: rect.width * rect.height };
    })
    .filter((candidate) => candidate.area > 100 && candidate.text.length < 1200)
    .sort((left, right) => left.text.length - right.text.length || left.area - right.area);
  const parentTarget = preferredPath?.element || messageCandidates[0]?.element || null;
  if (!parentTarget) {
    throw new Error('completed parent target not found ' + JSON.stringify({
      sample: sampleDom(),
      pathButtons: pathButtons.map(({ aria, text, current }) => ({ aria, text, current })).slice(0, 12),
      messageCandidateCount: messageCandidates.length,
    }));
  }
  const parentText = (parentTarget.getAttribute('aria-label') || parentTarget.innerText || parentTarget.textContent || '').trim().slice(0, 180);
  const beforeFocusId = workspaceStore?.getState?.().focusedMessageId ?? null;
  let focusChangeMs = null;
  const unsubscribeFocus = workspaceStore?.subscribe?.((state, previousState) => {
    if (focusChangeMs !== null) return;
    if (state.focusedMessageId !== previousState.focusedMessageId) {
      focusChangeMs = Number((performance.now() - clickStartedAt).toFixed(2));
    }
  });
  let firstRafMs = null;
  let sendLabelMutationMs = null;
  const observer = new MutationObserver(() => {
    if (sendLabelMutationMs !== null) return;
    const button = findSendButton({ includeCancel: true });
    if (elementLabel(button) === 'Send') {
      sendLabelMutationMs = Number((performance.now() - clickStartedAt).toFixed(2));
    }
  });
  observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
  const clickStartedAt = performance.now();
  parentTarget.click();
  const clickReturnMs = Number((performance.now() - clickStartedAt).toFixed(2));
  requestAnimationFrame(() => {
    firstRafMs = Number((performance.now() - clickStartedAt).toFixed(2));
  });
  const retargeted = await waitFor(() => {
    const button = findSendButton({ includeCancel: true });
    return elementLabel(button) === 'Send' ? button : null;
  }, ${JSON.stringify(WAIT_MS)}, 16);
  unsubscribeFocus?.();
  observer.disconnect();
  return {
    beforeFocusId,
    afterFocusId: workspaceStore?.getState?.().focusedMessageId ?? null,
    clickReturnMs,
    firstRafMs,
    focusChangeMs,
    parentText,
    retargetMs: Number((performance.now() - clickStartedAt).toFixed(2)),
    sendLabelMutationMs,
    waitElapsedMs: retargeted.elapsedMs,
    retargeted: Boolean(retargeted.value),
    sample: sampleDom(),
    pathButtons: pathButtons.map(({ aria, text, current }) => ({ aria, text, current })).slice(0, 12),
    messageCandidateCount: messageCandidates.length,
  };
})()
`, Math.max(30000, WAIT_MS + 10000));
    report.metrics.completedParentRetargetMs = retarget.retargetMs;
    if (!retarget.retargeted) {
      throw new Error(`completed parent did not retarget: ${JSON.stringify(retarget)}`);
    }

    const reply = await step(report, 'send-reply-to-completed-parent', `
(async () => {
  ${DOM_HELPERS_SOURCE}
  const composer = findComposer();
  if (!composer) throw new Error('composer missing for reply');
  setTextarea(composer, ${JSON.stringify(REPLY_PROMPT)});
  const readyStartedAt = performance.now();
  const ready = await waitFor(() => {
    const button = findSendButton({ includeCancel: false });
    return elementLabel(button) === 'Send' && !button.disabled ? button : null;
  }, ${JSON.stringify(WAIT_MS)}, 16);
  if (!ready.value) throw new Error('reply send not ready ' + JSON.stringify(sampleDom()));
  const clickStartedAt = performance.now();
  ready.value.click();
  const clickReturnMs = Number((performance.now() - clickStartedAt).toFixed(2));
  const immediateSample = sampleDom();
  const feedback = await waitFor(() => {
    const current = sampleDom();
    return current.buttonLabel === 'Cancel sending message' && current.composerValueLength === 0 ? current : null;
  }, ${JSON.stringify(THRESHOLD_MS)}, 16);
  const cancelButton = findSendButton({ includeCancel: true });
  if (elementLabel(cancelButton) === 'Cancel sending message') cancelButton.click();
  return {
    enabledMs: Number((performance.now() - readyStartedAt).toFixed(2)),
    clickReturnMs,
    immediateSample,
    feedbackVisibleMs: feedback.value ? Number((performance.now() - clickStartedAt).toFixed(2)) : null,
    feedbackWaitElapsedMs: feedback.elapsedMs,
    feedbackSample: feedback.value,
    finalSample: sampleDom(),
  };
})()
`, Math.max(30000, WAIT_MS + 10000));
    report.metrics.replySendEnabledAfterTypingMs = reply.enabledMs;
    report.metrics.replyClickReturnMs = reply.clickReturnMs;
    report.metrics.replyFeedbackVisibleMs = reply.feedbackVisibleMs;
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'main', message: error.message, stack: error.stack });
  } finally {
    const collect = await collectPerf();
    report.exportStatus = collect.value?.exportStatus ?? null;
    report.perfEvents = collect.value?.perfEvents ?? [];
  }

  report.validation = validateMetrics(report.metrics);

  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({ reportPath, report });

  const output = {
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.exportStatus?.exportPath ?? null,
    thresholdMs: THRESHOLD_MS,
    metrics: report.metrics,
    validation: report.validation,
    errors: report.errors.map((error) => error.message),
    perfEventCount: report.perfEvents.length,
  };
  console.log(JSON.stringify(output, null, 2));

  if (report.errors.length > 0 || !report.validation.ok) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
