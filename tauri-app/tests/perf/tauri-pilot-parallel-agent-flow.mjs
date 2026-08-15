import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const FRONTEND_LOG_PATH = process.env.AGENTREE_TAURI_PILOT_FRONTEND_LOG ?? 'runtime-logs/frontend.log';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-parallel-agent-${Date.now()}`;
const TEST_AGENT_MODEL = process.env.AGENTREE_TAURI_PILOT_AGENT_MODEL ?? 'gpt-5.4-mini';
const RUN_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_RUN_TIMEOUT_MS ?? 360000);
const NO_PROGRESS_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_NO_PROGRESS_TIMEOUT_MS ?? 120000);
const SEND_SPACING_MS = Number(process.env.AGENTREE_TAURI_PILOT_SEND_SPACING_MS ?? 2500);
const DISABLE_GRAPH_INTERACTIONS = process.env.AGENTREE_TAURI_PILOT_DISABLE_GRAPH_INTERACTIONS === 'true';
const DISABLE_GRAPH_CLICKS = process.env.AGENTREE_TAURI_PILOT_DISABLE_GRAPH_CLICKS === 'true';
const GRAPH_INTERACTIONS_DURING_LAUNCH = process.env.AGENTREE_TAURI_PILOT_GRAPH_INTERACTIONS_DURING_LAUNCH !== 'false';
const DISABLE_PERF_CAPTURE = process.env.AGENTREE_TAURI_PILOT_DISABLE_PERF_CAPTURE === 'true';
const PROMPTS = (process.env.AGENTREE_TAURI_PILOT_PROMPTS
  ? JSON.parse(process.env.AGENTREE_TAURI_PILOT_PROMPTS)
  : [
      'Write 3-4 concise paragraphs explaining why interface focus should follow user intent while background agents continue running. Do not use bullets.',
      'Write 3-4 concise paragraphs explaining a practical testing strategy for many parallel coding agents in a graph workspace. Do not use bullets.',
      'Write 3-4 concise paragraphs explaining how a team should understand running agent activity without having their current work interrupted. Do not use bullets.',
    ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pilotEval = async (script, timeoutMs = 120000) => {
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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

const install = async () => pilotEval(`
(() => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompts = ${JSON.stringify(PROMPTS)};
  const testAgentModel = ${JSON.stringify(TEST_AGENT_MODEL)};
  const sendSpacingMs = ${JSON.stringify(SEND_SPACING_MS)};
  const runTimeoutMs = ${JSON.stringify(RUN_TIMEOUT_MS)};
  const disableGraphInteractions = ${JSON.stringify(DISABLE_GRAPH_INTERACTIONS)};
  const disableGraphClicks = ${JSON.stringify(DISABLE_GRAPH_CLICKS)};
  const graphInteractionsDuringLaunch = ${JSON.stringify(GRAPH_INTERACTIONS_DURING_LAUNCH)};
  const disablePerfCapture = ${JSON.stringify(DISABLE_PERF_CAPTURE)};

  const probe = {
    label,
    testAgentModel,
    prompts,
      disableGraphInteractions,
      graphInteractionsDuringLaunch,
      disablePerfCapture,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    actions: [],
    samples: [],
    sends: [],
    runningGraphInteractions: [],
    errors: [],
    rafStalls: [],
    intervalStalls: [],
    maxRafGapMs: 0,
    maxIntervalGapMs: 0,
    done: false,
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nowElapsed = () => Number((performance.now() - probe.startedAt).toFixed(2));
  const emit = (type, details = {}) => {
    const payload = { ...details, label, type, at: new Date().toISOString(), elapsedMs: nowElapsed() };
    console.log('[PARALLEL_AGENT_FLOW]', JSON.stringify(payload));
  };
  const logAction = (type, details = {}) => {
    const action = { type, at: new Date().toISOString(), elapsedMs: nowElapsed(), ...details };
    probe.actions.push(action);
    emit(type, details);
  };
  let workspaceStore = null;
  let runStatusStore = null;
  let mergeStore = null;
  const ensureStores = async () => {
    if (workspaceStore && runStatusStore && mergeStore) return true;
    try {
      const [workspaceModule, runStatusModule, mergeModule] = await Promise.all([
        import(new URL('/src/stores/workspaceStore.ts', location.origin).href),
        import(new URL('/src/stores/runStatusStore.ts', location.origin).href),
        import(new URL('/src/stores/mergeStore.ts', location.origin).href),
      ]);
      workspaceStore = workspaceModule.useWorkspaceStore;
      runStatusStore = runStatusModule.useRunStatusStore;
      mergeStore = mergeModule;
      logAction('stores-loaded');
      return true;
    } catch (error) {
      probe.errors.push({ at: new Date().toISOString(), elapsedMs: nowElapsed(), phase: 'store-import', message: String(error?.message || error), stack: error?.stack || null });
      return false;
    }
  };
  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const findComposer = () => chatHotPath.findComposer();
  const statusButton = () => chatHotPath.findSendButton({ includeCancel: true });
  const sendButton = () => chatHotPath.findSendButton();
  const installHarnessStyle = () => {
    const existing = document.getElementById('agentree-parallel-agent-flow-style');
    existing?.remove?.();
    const style = document.createElement('style');
    style.id = 'agentree-parallel-agent-flow-style';
    style.textContent = [
      'button[title="Select this node as a merge source"] { pointer-events: none !important; }',
      '[data-agentree-merge-source-button] { pointer-events: none !important; }',
    ].join('\\n');
    document.head.appendChild(style);
    return style;
  };
  const selectionDialogPresent = () => [...document.querySelectorAll('[role="status"], [role="dialog"], button, [data-state="open"]')]
    .some((element) => (element.textContent || '').includes('Select Merge Target'));
  const buttonLabel = () => {
    const button = statusButton();
    return button ? (button.getAttribute('aria-label') || button.textContent || '').trim() : null;
  };
  const graphCounts = () => ({
    nodes: document.querySelectorAll('.react-flow__node').length,
    edges: document.querySelectorAll('.react-flow__edge').length,
    transform: document.querySelector('.react-flow__viewport')?.style.transform || null,
  });
  const hoverCardCount = () => document.querySelectorAll('[data-agentree-node-hover-card="true"], [data-radix-hover-card-content]').length;
  const focusState = () => {
    if (!workspaceStore || !runStatusStore) {
      return { storesReady: false };
    }
    const state = workspaceStore.getState();
    return {
      selectedWorkspaceId: state.selectedWorkspaceId,
      focusedMessageId: state.focusedMessageId,
      lastFocusSource: state.lastFocusSource,
      lastFocusMetadata: state.lastFocusMetadata,
      activeSendFlowFocus: state.activeSendFlowFocus,
      runningCount: runStatusStore.getState().getRunningCount(state.selectedWorkspaceId),
    };
  };
  const sample = (label) => {
    const textarea = findComposer();
    const chatViewport = document.querySelector('[data-radix-scroll-area-viewport]') ?? null;
    const item = {
      label,
      at: new Date().toISOString(),
      elapsedMs: nowElapsed(),
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      buttonLabel: buttonLabel(),
      buttonDisabled: statusButton()?.disabled ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      textareaValueLength: textarea?.value?.length ?? null,
      graph: graphCounts(),
      hoverCardCount: hoverCardCount(),
      focus: focusState(),
      selectedNodeIds: [...document.querySelectorAll('.react-flow__node.selected')].map((node) => node.getAttribute('data-id')).filter(Boolean),
      chatTextContentLength: chatViewport?.textContent?.length ?? null,
    };
    probe.samples.push(item);
    return item;
  };
  const summarizeEvent = (event) => event ? ({
    name: event.name ?? null,
    ts: event.ts ?? null,
    source: event.source ?? null,
    details: event.details ? {
      flowId: event.details.flowId ?? null,
      nodeId: event.details.nodeId ?? null,
      status: event.details.status ?? null,
      nextStatus: event.details.nextStatus ?? null,
      phase: event.details.phase ?? null,
    } : null,
  }) : null;
  const summarizeProbe = () => ({
    label: probe.label,
    testAgentModel: probe.testAgentModel,
    prompts: probe.prompts,
    startedAtIso: probe.startedAtIso,
    done: probe.done,
    sends: probe.sends,
    runningGraphInteractions: probe.runningGraphInteractions,
    actions: probe.actions.slice(-120),
    samples: probe.samples.slice(-180),
    errors: probe.errors,
    maxRafGapMs: probe.maxRafGapMs,
    maxIntervalGapMs: probe.maxIntervalGapMs,
    rafStallCount: probe.rafStalls.length,
    intervalStallCount: probe.intervalStalls.length,
    rafStalls: probe.rafStalls.slice(-50),
    intervalStalls: probe.intervalStalls.slice(-50),
    latestPan: probe.actions.slice().reverse().find((action) => action.type === 'pan') ?? null,
    latestClick: probe.actions.slice().reverse().find((action) => action.type === 'click-node' || action.type === 'click-node-missing' || action.type === 'click-node-no-safe-target') ?? null,
  });
  const summarizeCompactProbe = () => ({
    label: probe.label,
    testAgentModel: probe.testAgentModel,
    done: probe.done,
    sends: probe.sends,
    runningGraphInteractions: probe.runningGraphInteractions,
    actions: probe.actions.slice(-80),
    samples: probe.samples.slice(-30),
    errors: probe.errors,
    maxRafGapMs: probe.maxRafGapMs,
    maxIntervalGapMs: probe.maxIntervalGapMs,
    rafStallCount: probe.rafStalls.length,
    intervalStallCount: probe.intervalStalls.length,
    rafStalls: probe.rafStalls.slice(-20),
    intervalStalls: probe.intervalStalls.slice(-20),
    latestPan: probe.actions.slice().reverse().find((action) => action.type === 'pan') ?? null,
    latestClick: probe.actions.slice().reverse().find((action) => action.type === 'click-node' || action.type === 'click-node-missing' || action.type === 'click-node-no-safe-target') ?? null,
  });
  const perfEvents = () => window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  const awaitWithProgress = async (promise, label, intervalMs = 10000) => {
    let settled = false;
    let tick = 0;
    const heartbeat = window.setInterval(() => {
      if (settled) return;
      tick += 1;
      logAction('await-progress', { actionLabel: label, tick, waitedMs: tick * intervalMs });
    }, intervalMs);
    try {
      return await promise;
    } finally {
      settled = true;
      window.clearInterval(heartbeat);
    }
  };
  const ensureLatestRunnableFocus = async (label) => {
    const workspaceId = workspaceStore?.getState?.().selectedWorkspaceId ?? null;
    if (!workspaceId) throw new Error('parallel preflight failed: no selected workspace');
    const apiModule = await import(new URL('/src/lib/api.ts', location.origin).href);
    const gitNodeUtils = await import(new URL('/src/lib/gitNodeUtils.ts', location.origin).href);
    try {
      logAction('latest-runnable-focus-fetch-start', { actionLabel: label, workspaceId });
      const response = await awaitWithProgress(
        apiModule.api.get('/workspaces/' + workspaceId + '/messages'),
        'latest-runnable-focus-fetch-' + label
      );
      const messages = Array.isArray(response.data) ? response.data : [];
      logAction('latest-runnable-focus-fetch-finished', { actionLabel: label, workspaceId, messageCount: messages.length });
      const sortedMessages = messages.slice().sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || left.updatedAt || '') || 0;
        const rightTime = Date.parse(right.createdAt || right.updatedAt || '') || 0;
        return rightTime - leftTime;
      });
      const latestRunnable = sortedMessages.find((message) => {
        if (['running', 'pending', 'initializing', 'streaming'].includes(String(message.status || ''))) return false;
        return gitNodeUtils.resolveNodeCommit(message, messages, null);
      });
      if (latestRunnable) {
        workspaceStore.getState().dispatchFocus?.({
          messageId: latestRunnable.id,
          source: 'system',
          metadata: { reason: 'parallel-perf-latest-runnable-focus', label },
        });
        logAction('latest-runnable-focus-set', {
          actionLabel: label,
          messageId: latestRunnable.id,
          role: latestRunnable.role ?? null,
          status: latestRunnable.status ?? null,
          text: (latestRunnable.aiLabel || latestRunnable.content || '').trim().slice(0, 100),
        });
        return latestRunnable.id;
      }
      logAction('latest-runnable-focus-missing', { actionLabel: label, workspaceId, messageCount: messages.length });
    } catch (error) {
      logAction('latest-runnable-focus-fetch-failed', { actionLabel: label, workspaceId, message: String(error?.message || error) });
    }

    const visibleGraphNode = [...document.querySelectorAll('.react-flow__node-assistant_message, .react-flow__node-user_message')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const id = element.getAttribute('data-id');
        const text = (element.textContent || '').trim();
        return { element, id, rect, text };
      })
      .filter((entry) => entry.id && entry.rect.width > 20 && entry.rect.height > 20 && entry.rect.right > 0 && entry.rect.bottom > 0 && entry.rect.left < window.innerWidth && entry.rect.top < window.innerHeight)
      .filter((entry) => !/\\b(pending|creating|initializing|running|streaming)\\b/i.test(entry.text))
      .sort((left, right) => {
        const roleScore = (entry) => entry.element.classList.contains('react-flow__node-assistant_message') ? 0 : 1;
        return roleScore(left) - roleScore(right) || right.rect.top - left.rect.top;
      })[0] ?? null;
    if (visibleGraphNode?.id) {
      workspaceStore.getState().dispatchFocus?.({
        messageId: visibleGraphNode.id,
        source: 'system',
        metadata: { reason: 'parallel-perf-visible-graph-focus', label },
      });
      logAction('visible-graph-focus-set', {
        actionLabel: label,
        messageId: visibleGraphNode.id,
        text: visibleGraphNode.text.slice(0, 100),
      });
      return visibleGraphNode.id;
    }
    throw new Error('parallel preflight failed: no latest runnable node');
  };
  const focusMessage = async (messageId, label) => {
    if (!messageId) throw new Error('parallel focus failed: missing message id');
    workspaceStore.getState().dispatchFocus?.({
      messageId,
      source: 'system',
      metadata: { reason: 'parallel-perf-parent-focus', label },
    });
    logAction('parent-focus-set', { actionLabel: label, messageId });
    await sleep(250);
  };
  const waitForFocusCenterSettled = async (label, timeoutMs = 6000) => {
    const startedAtWall = Date.now();
    const startedAtPerf = performance.now();
    while (performance.now() - startedAtPerf < timeoutMs) {
      const endEvent = perfEvents()
        .slice()
        .reverse()
        .find((event) => event?.name === 'graph.focus-center.end' && Date.parse(event?.ts || '') >= startedAtWall);
      if (endEvent) {
        logAction('focus-center-settled', { actionLabel: label, event: summarizeEvent(endEvent) });
        await sleep(200);
        return true;
      }
      await sleep(100);
    }
    logAction('focus-center-settle-timeout', { actionLabel: label, timeoutMs });
    return false;
  };
  const latestFlowStartedAfter = (sentAtIso) => {
    const sentAt = Date.parse(sentAtIso);
    return perfEvents()
      .filter((event) => event?.name === 'send-flow.flow.started')
      .slice()
      .reverse()
      .find((event) => {
        const eventAt = Date.parse(event?.ts || '');
        return Number.isFinite(eventAt) && eventAt >= sentAt - 100;
      }) || null;
  };
  const flowTerminalEvent = (flowId) => perfEvents()
    .filter((event) => ['send-flow.lifecycle.completed', 'send-flow.lifecycle.failed', 'send-flow.lifecycle.cancelled'].includes(event?.name))
    .slice()
    .reverse()
    .find((event) => event?.details?.flowId === flowId) || null;
  const flowCleanupEvent = (flowId) => perfEvents()
    .filter((event) => event?.name === 'send-flow.cleanup.finished')
    .slice()
    .reverse()
    .find((event) => event?.details?.flowId === flowId) || null;
  const isComposerReadyForPrompt = () => {
    const textarea = findComposer();
    const label = buttonLabel();
    return Boolean(textarea && !textarea.disabled && label !== 'Cancel sending message' && label !== 'Cancel');
  };
  const isSendReady = () => {
    const textarea = findComposer();
    const button = sendButton();
    const label = buttonLabel();
    return Boolean(textarea && !textarea.disabled && button && !button.disabled && label !== 'Cancel sending message' && label !== 'Cancel');
  };
  const clearSelectionState = async (label) => {
    mergeStore?.useMergeStore?.getState?.().exitSelectionMode?.();
    await sleep(120);
    logAction('clear-selection-state', {
      actionLabel: label,
      selectedNodeCount: document.querySelectorAll('.react-flow__node.selected').length,
      selectionOverlayPresent: selectionDialogPresent(),
    });
  };
  const clearStaleCancelState = async (label) => {
    const labelText = buttonLabel();
    const runningCount = focusState()?.runningCount ?? 0;
    if ((labelText === 'Cancel sending message' || labelText === 'Cancel') && runningCount === 0) {
      statusButton()?.click();
      await sleep(250);
      logAction('clear-stale-cancel-state', {
        actionLabel: label,
        beforeLabel: labelText,
        afterLabel: buttonLabel(),
        runningCount,
      });
    }
  };
  const setPromptAndSend = async (prompt, index) => {
    await chatHotPath.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
    const textarea = findComposer();
    if (!textarea) throw new Error('composer textarea missing');
    const before = sample('before-send-' + index);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    const promptSetAt = performance.now();
    let readyAfterPrompt = false;
    while (performance.now() - promptSetAt < 5000) {
      if (isSendReady()) {
        readyAfterPrompt = true;
        break;
      }
      await sleep(100);
    }
    sample('prompt-set-' + index);
    if (!readyAfterPrompt) {
      const currentButton = sendButton();
      const failure = {
        index,
        at: new Date().toISOString(),
        elapsedMs: nowElapsed(),
        promptLength: prompt.length,
        blocked: true,
        before,
        buttonLabel: buttonLabel(),
        textareaDisabled: findComposer()?.disabled ?? null,
        textareaValueLength: findComposer()?.value?.length ?? null,
        buttonDisabled: currentButton?.disabled ?? null,
        promptReadyWaitMs: Number((performance.now() - promptSetAt).toFixed(2)),
      };
      probe.sends.push(failure);
      logAction('send-blocked', failure);
      return failure;
    }
    logAction('prompt-ready', {
      index,
      promptReadyWaitMs: Number((performance.now() - promptSetAt).toFixed(2)),
      textareaValueLength: findComposer()?.value?.length ?? null,
    });
    const button = sendButton();
    if (!button) throw new Error('send button missing after prompt for run ' + index);
    button.click();
    const send = { index, at: new Date().toISOString(), elapsedMs: nowElapsed(), promptLength: prompt.length, blocked: false };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const startedEvent = latestFlowStartedAfter(send.at);
      const flowId = startedEvent?.details?.flowId;
      if (flowId) {
        send.flowId = flowId;
        send.optimisticAssistantMessageId = startedEvent?.details?.optimisticAssistantMessageId ?? null;
        send.optimisticUserMessageId = startedEvent?.details?.optimisticUserMessageId ?? null;
        break;
      }
      await sleep(50);
    }
    probe.sends.push(send);
    logAction('send-clicked', send);
    sample('send-' + index + '-clicked');
    return send;
  };
  const panGraph = async (label) => {
    const root = document.querySelector('.react-flow');
    const pane = document.querySelector('.react-flow__pane') || root;
    if (!root || !pane) {
      logAction('pan-missing-target', { actionLabel: label });
      return false;
    }
    const before = graphCounts();
    const rect = root.getBoundingClientRect();
    const x = rect.left + Math.max(80, rect.width * 0.45);
    const y = rect.top + Math.max(80, rect.height * 0.45);
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    for (let i = 1; i <= 8; i += 1) {
      pane.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 1, clientX: x + i * 16, clientY: y + i * 7 }));
      await sleep(25);
    }
    pane.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 0, clientX: x + 128, clientY: y + 56 }));
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 80, deltaY: 70, clientX: x, clientY: y }));
    await sleep(250);
    const after = graphCounts();
    logAction('pan', { actionLabel: label, before, after });
    sample('after-pan-' + label);
    return true;
  };
  const isUnsafeClickTarget = (element) => {
    const target = element instanceof Element ? element : null;
    return Boolean(target?.closest?.('button, a, input, textarea, select, [data-radix-popper-content-wrapper]'));
  };
  const isVisiblyActiveRunElement = (element) => {
    const target = element instanceof Element ? element : null;
    if (!target) return false;
    const text = (target.textContent || '').trim().toLowerCase();
    return /\\b(pending|creating|initializing|running|streaming)\\b/.test(text);
  };
  const cssEscape = (value) => {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  };
  const getGraphDiagnosticCapture = async (label) => {
    try {
      if (window.__AGENTREE_GRAPH_DEBUG__?.capture) {
        return window.__AGENTREE_GRAPH_DEBUG__.capture(label) ?? null;
      }
      const graphDiagnosticsModule = await import(new URL('/src/lib/graphDiagnostics.ts', location.origin).href);
      return graphDiagnosticsModule.captureGraphDiagnostics?.(label) ?? null;
    } catch (error) {
      logAction('graph-diagnostic-capture-failed', { actionLabel: label, message: String(error?.message || error) });
      return null;
    }
  };
  const getGraphNodeElement = (id) => (
    document.querySelector('.react-flow__node[data-id="' + cssEscape(id) + '"]') ||
    document.querySelector('[data-agentree-graph-node-id="' + cssEscape(id) + '"]')?.closest('.react-flow__node')
  );
  const isSemanticFocusCandidate = (node) => {
    if (!node?.id || node.type === 'turn_group_hull') return false;
    const role = node.data?.role ?? null;
    if (role && role !== 'user' && role !== 'assistant') return false;
    if (!role && node.type !== 'user_message' && node.type !== 'assistant_message') return false;
    const width = node.dimensions?.styleWidth ?? node.dimensions?.reactFlowWidth ?? 0;
    const height = node.dimensions?.styleHeight ?? node.dimensions?.reactFlowHeight ?? 0;
    return width > 20 && height > 20;
  };
  const getNodeCenter = (node) => {
    const position = node?.absolutePosition ?? node?.position ?? { x: 0, y: 0 };
    const width = node?.dimensions?.styleWidth ?? node?.dimensions?.reactFlowWidth ?? 0;
    const height = node?.dimensions?.styleHeight ?? node?.dimensions?.reactFlowHeight ?? 0;
    return { x: (position.x ?? 0) + width / 2, y: (position.y ?? 0) + height / 2 };
  };
  const distanceBetweenNodes = (left, right) => {
    const a = getNodeCenter(left);
    const b = getNodeCenter(right);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const activeRunNodeIds = () => {
    const ids = new Set();
    const statuses = runStatusStore?.getState?.().byNodeId ?? {};
    for (const [nodeId, entry] of Object.entries(statuses)) {
      if (['pending', 'creating', 'initializing', 'running', 'streaming'].includes(String(entry?.status || ''))) {
        ids.add(nodeId);
      }
    }
    for (const send of probe.sends) {
      if (send.terminal) continue;
      if (send.optimisticUserMessageId) ids.add(send.optimisticUserMessageId);
      if (send.optimisticAssistantMessageId) ids.add(send.optimisticAssistantMessageId);
    }
    return ids;
  };
  const pickSemanticClickableNode = async (label, avoidIds = [], options = {}) => {
    const avoid = new Set(avoidIds.filter(Boolean));
    if (options.avoidActiveRuns) {
      for (const id of activeRunNodeIds()) avoid.add(id);
    }
    const capture = await getGraphDiagnosticCapture('parallel-semantic-click-' + label);
    const payload = capture?.payload ?? {};
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const edges = Array.isArray(payload.edges) ? payload.edges : [];
    const focusedMessageId = payload.focusedMessageId ?? focusState().focusedMessageId ?? null;
    const semanticNodes = nodes.filter((node) => isSemanticFocusCandidate(node) && !avoid.has(node.id));
    const nodeById = new Map(semanticNodes.map((node) => [node.id, node]));
    const focusedNode = nodeById.get(focusedMessageId) ?? null;
    const adjacentIds = focusedNode
      ? edges.flatMap((edge) => {
          if (edge.source === focusedNode.id) return [edge.target];
          if (edge.target === focusedNode.id) return [edge.source];
          return [];
        })
      : [];
    const adjacentNodes = adjacentIds.map((id) => nodeById.get(id)).filter(Boolean);
    const sortPool = (pool) => pool
      .filter((node) => node.id !== focusedMessageId)
      .sort((left, right) => focusedNode ? distanceBetweenNodes(left, focusedNode) - distanceBetweenNodes(right, focusedNode) : String(left.id).localeCompare(String(right.id)));
    const getMountedCandidates = (pool) => pool
      .map((node) => ({ node, element: getGraphNodeElement(node.id) }))
      .filter((entry) => {
        const rect = entry.element?.getBoundingClientRect?.();
        return rect && rect.width > 20 && rect.height > 20 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight && !(options.avoidActiveRuns && isVisiblyActiveRunElement(entry.element));
      });
    const adjacentMountedCandidates = getMountedCandidates(sortPool(adjacentNodes));
    const fallbackMountedCandidates = adjacentMountedCandidates.length > 0
      ? []
      : getMountedCandidates(sortPool(semanticNodes));
    const mountedCandidates = adjacentMountedCandidates.length > 0 ? adjacentMountedCandidates : fallbackMountedCandidates;
    const domFallbackCandidates = mountedCandidates.length > 0
      ? []
      : [...document.querySelectorAll('.react-flow__node-user_message, .react-flow__node-assistant_message')]
          .filter((element) => {
            const id = element.getAttribute('data-id');
            if (!id || avoid.has(id) || id === focusedMessageId) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 20 && rect.height > 20 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight && !(options.avoidActiveRuns && isVisiblyActiveRunElement(element));
          })
          .map((element) => ({
            node: { id: element.getAttribute('data-id'), data: { role: null } },
            element,
            source: 'dom-fallback',
          }));
    const chosen = mountedCandidates[0]
      ? { ...mountedCandidates[0], source: 'semantic' }
      : (domFallbackCandidates[0] ?? null);
    logAction('semantic-click-candidates', {
      actionLabel: label,
      focusedMessageId,
      avoidActiveRuns: Boolean(options.avoidActiveRuns),
      avoidedNodeCount: avoid.size,
      semanticCandidateCount: semanticNodes.length,
      adjacentCandidateCount: adjacentNodes.length,
      adjacentMountedCandidateCount: adjacentMountedCandidates.length,
      fallbackMountedCandidateCount: fallbackMountedCandidates.length,
      domFallbackCandidateCount: domFallbackCandidates.length,
      mountedCandidateCount: mountedCandidates.length,
      chosenId: chosen?.node?.id ?? null,
      chosenSource: chosen?.source ?? null,
    });
    return chosen;
  };
  const clickVisibleNode = async (label, avoidIds = [], options = {}) => {
    const chosen = await pickSemanticClickableNode(label, avoidIds, options);
    if (!chosen?.element) {
      logAction('click-node-missing', { actionLabel: label, avoidIds });
      sample('after-click-missing-' + label);
      return null;
    }
    let node = null;
    let x = 0;
    let y = 0;
    let pointTarget = null;
    for (const candidate of [chosen.element]) {
      const rect = candidate.getBoundingClientRect();
      const points = [
        [rect.left + rect.width * 0.5, rect.top + Math.min(rect.height * 0.55, 56)],
        [rect.left + rect.width * 0.35, rect.top + Math.min(rect.height * 0.5, 48)],
        [rect.left + rect.width * 0.65, rect.top + Math.min(rect.height * 0.5, 48)],
      ];
      const safePoint = points.find(([pointX, pointY]) => {
        const element = document.elementFromPoint(pointX, pointY);
        return element && candidate.contains(element) && !isUnsafeClickTarget(element);
      });
      const fallbackPoint = points.find(([pointX, pointY]) => {
        const element = document.elementFromPoint(pointX, pointY);
        return element && candidate.contains(element) && !isUnsafeClickTarget(element);
      });
      const chosenPoint = safePoint ?? fallbackPoint ?? points[0];
      if (chosenPoint) {
        node = candidate;
        [x, y] = chosenPoint;
        pointTarget = document.elementFromPoint(x, y);
        break;
      }
    }
    if (!node) {
      logAction('click-node-no-safe-target', { actionLabel: label, candidateCount: 1, candidateId: chosen.node.id });
      sample('after-click-no-safe-target-' + label);
      return null;
    }
    if (options.avoidActiveRuns) {
      const activeElement = pointTarget?.closest?.('.react-flow__node') || pointTarget || node;
      if (isVisiblyActiveRunElement(activeElement)) {
        logAction('click-node-active-target-skipped', {
          actionLabel: label,
          id: chosen.node.id,
          targetTag: pointTarget?.tagName ?? null,
          targetText: (pointTarget?.textContent || '').trim().slice(0, 80),
          text: (node.textContent || '').trim().slice(0, 120),
        });
        sample('after-click-active-target-skipped-' + label);
        return null;
      }
    }
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 22, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 22, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: x, clientY: y }));
    await sleep(350);
    const id = chosen.node.id;
    const openedSelection = selectionDialogPresent();
    logAction('click-node', {
      actionLabel: label,
      id,
      openedSelection,
      targetTag: pointTarget?.tagName ?? null,
      targetTitle: pointTarget?.getAttribute?.('title') ?? null,
      targetText: (pointTarget?.textContent || '').trim().slice(0, 80),
      text: (node.textContent || '').trim().slice(0, 120),
    });
    if (openedSelection) {
      await clearSelectionState('after-unexpected-selection-' + label);
      probe.errors.push({ at: new Date().toISOString(), elapsedMs: nowElapsed(), phase: 'click-node', message: 'node click unexpectedly opened merge selection', nodeId: id });
    }
    sample('after-click-' + label);
    return id;
  };
  const interactWithGraphDuringRun = async (label, clickedIds) => {
    const beforeFocus = focusState();
    const runningBefore = Number(beforeFocus?.runningCount ?? 0);
    const beforeGraph = graphCounts();
    const panOk = await panGraph(label);
    let clickedId = null;
    if (disableGraphClicks) {
      logAction('graph-click-skipped', { actionLabel: label });
    } else {
      clickedId = await clickVisibleNode(label, clickedIds, { avoidActiveRuns: true });
      if (clickedId) clickedIds.push(clickedId);
    }
    const afterFocus = focusState();
    const interaction = {
      label,
      at: new Date().toISOString(),
      elapsedMs: nowElapsed(),
      runningBefore,
      runningAfter: Number(afterFocus?.runningCount ?? 0),
      panOk,
      clickedId,
      focusedBefore: beforeFocus?.focusedMessageId ?? null,
      focusedAfter: afterFocus?.focusedMessageId ?? null,
      focusChanged: Boolean(clickedId && beforeFocus?.focusedMessageId !== afterFocus?.focusedMessageId),
      graphTransformBefore: beforeGraph.transform,
      graphTransformAfter: graphCounts().transform,
    };
    probe.runningGraphInteractions.push(interaction);
    logAction('running-graph-interaction', interaction);
    return interaction;
  };
  const waitComposerReady = async (label, timeoutMs = 12000) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (isComposerReadyForPrompt()) {
        sample('composer-ready-' + label);
        return true;
      }
      sample('composer-wait-' + label);
      await sleep(500);
    }
    logAction('composer-not-ready', { actionLabel: label, buttonLabel: buttonLabel(), textareaDisabled: findComposer()?.disabled ?? null });
    return false;
  };
  const waitAllTerminals = async (timeoutMs = runTimeoutMs) => {
    const startedAt = performance.now();
    let zeroRunningSince = null;
    const openSends = () => probe.sends.filter((send) => !send.blocked && send.flowId && !send.terminal);
    while (performance.now() - startedAt < timeoutMs) {
      for (const send of openSends()) {
        const terminal = flowTerminalEvent(send.flowId);
        if (terminal) {
          send.terminal = summarizeEvent(terminal);
          logAction('terminal', { index: send.index, terminal: send.terminal });
          sample('terminal-send-' + send.index);
        }
      }
      if (openSends().length === 0) return true;

      const runningCount = focusState()?.runningCount ?? null;
      const composerIdle = isComposerReadyForPrompt();
      if (runningCount === 0 && composerIdle) {
        zeroRunningSince = zeroRunningSince ?? performance.now();
        if (performance.now() - zeroRunningSince > 5000) {
          for (const send of openSends()) {
            send.terminal = {
              name: 'harness.inferred-terminal',
              ts: new Date().toISOString(),
              source: 'tauri-pilot-parallel-agent-flow',
              details: {
                flowId: send.flowId,
                status: 'unknown',
                nextStatus: 'unknown',
                phase: 'running-count-zero',
              },
            };
          }
          logAction('terminal-inferred-running-count-zero', {
            inferredCount: probe.sends.filter((send) => send.terminal?.name === 'harness.inferred-terminal').length,
            reason: 'runningCount=0 and composer idle but terminal perf events were missing',
          });
          sample('terminal-inferred-running-count-zero');
          return true;
        }
      } else {
        zeroRunningSince = null;
      }

      await panGraph('wait-terminals');
      if (disableGraphClicks) {
        logAction('graph-click-skipped', { actionLabel: 'wait-terminals' });
      } else {
        await clickVisibleNode('wait-terminals', probe.sends.map((send) => send.optimisticAssistantMessageId));
      }
      await sleep(1000);
    }
    return false;
  };
  const waitCleanups = async (timeoutMs = 20000) => {
    const startedAt = performance.now();
    const openSends = () => probe.sends.filter((send) => !send.blocked && send.flowId && !send.cleanup);
    while (performance.now() - startedAt < timeoutMs) {
      for (const send of openSends()) {
        const cleanup = flowCleanupEvent(send.flowId);
        if (cleanup) {
          send.cleanup = summarizeEvent(cleanup);
          logAction('cleanup', { index: send.index, cleanup: send.cleanup });
          sample('cleanup-send-' + send.index);
        }
      }
      if (openSends().length === 0) return true;
      await sleep(500);
    }
    return false;
  };

  let expectedInterval = performance.now() + 100;
  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.intervalStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)), sample: graphCounts(), focus: focusState() });
    expectedInterval = now + 100;
  }, 100);

  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.rafStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)), sample: graphCounts(), focus: focusState() });
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const run = async () => {
    try {
      try {
        if (disablePerfCapture) {
          logAction('perf-capture-skipped');
        } else {
          window.__AGENTREE_PERF__?.clear?.();
          await window.__AGENTREE_PERF__?.startCapture?.(label);
          logAction('perf-capture-started');
        }
      } catch (error) {
        probe.errors.push({ at: new Date().toISOString(), elapsedMs: nowElapsed(), phase: 'perf-start', message: String(error?.message || error), stack: error?.stack || null });
      }
      installHarnessStyle();
      sample('installed');
      await ensureStores();
      sample('stores-ready');
      await clearSelectionState('initial');
      await clearStaleCancelState('initial');
      const parallelParentId = await ensureLatestRunnableFocus('initial');
      await waitForFocusCenterSettled('initial');
      const preflightGraph = sample('parallel-preflight-centered').graph;
      if (preflightGraph.nodes === 0) {
        throw new Error('parallel preflight failed: graph is blank after centering, nodes=' + preflightGraph.nodes + ', edges=' + preflightGraph.edges);
      }
      const clickedIds = [];
      for (let index = 1; index <= prompts.length; index += 1) {
        await focusMessage(parallelParentId, 'before-send-' + index);
        const ready = await waitComposerReady('before-send-' + index);
        if (!ready) break;
        const send = await setPromptAndSend(prompts[index - 1], index);
        await sleep(sendSpacingMs);
        if (disableGraphInteractions) {
          logAction('graph-interactions-skipped', { actionLabel: 'after-send-' + index });
        } else if (!graphInteractionsDuringLaunch) {
          logAction('launch-graph-interactions-deferred', { actionLabel: 'after-send-' + index });
        } else {
          await interactWithGraphDuringRun('after-send-' + index, clickedIds);
        }
        if (send.blocked) break;
      }
      logAction('launch-phase-complete', {
        attempted: prompts.length,
        started: probe.sends.filter((send) => !send.blocked).length,
        blocked: probe.sends.filter((send) => send.blocked).length,
      });
      if (disableGraphInteractions) {
        logAction('active-observation-skipped');
        await sleep(4500);
      } else {
        for (let i = 0; i < 5; i += 1) {
          await interactWithGraphDuringRun('active-observation-' + (i + 1), clickedIds);
          await sleep(900);
        }
      }
      await waitAllTerminals();
      await waitCleanups();
      probe.done = true;
      sample('done');
      emit('done', {
        started: probe.sends.filter((send) => !send.blocked).length,
        blocked: probe.sends.filter((send) => send.blocked).length,
        terminalCount: probe.sends.filter((send) => send.terminal).length,
        cleanupCount: probe.sends.filter((send) => send.cleanup).length,
        errorCount: probe.errors.length,
      });
      emit('done-summary', { summary: summarizeCompactProbe() });
    } catch (error) {
      probe.errors.push({ at: new Date().toISOString(), elapsedMs: nowElapsed(), message: String(error?.message || error), stack: error?.stack || null });
      sample('error');
      probe.done = true;
      emit('error', {
        message: String(error?.message || error),
        errorCount: probe.errors.length,
      });
      emit('error-summary', { summary: summarizeCompactProbe() });
    }
  };

  probe.cleanup = () => {
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
  };
  window.__PARALLEL_AGENT_FLOW__ = probe;
  window.__PARALLEL_AGENT_FLOW_SUMMARY__ = summarizeProbe;
  window.setTimeout(run, 250);
  return { label, url: location.href, promptCount: prompts.length, testAgentModel, sendSpacingMs, disableGraphInteractions, graphInteractionsDuringLaunch, disablePerfCapture };
})()
`);

let frontendLogOffset = 0;
let frontendLogBuffer = '';
const parseFlowLogEvents = () => {
  try {
    const stat = statSync(FRONTEND_LOG_PATH);
    if (stat.size < frontendLogOffset) {
      frontendLogOffset = 0;
      frontendLogBuffer = '';
    }
    if (stat.size === frontendLogOffset) return [];
    const length = stat.size - frontendLogOffset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(FRONTEND_LOG_PATH, 'r');
    try {
      readSync(fd, buffer, 0, length, frontendLogOffset);
    } finally {
      closeSync(fd);
    }
    frontendLogOffset = stat.size;
    frontendLogBuffer += buffer.toString('utf8');
  } catch {
    return [];
  }
  const lines = frontendLogBuffer.split('\n');
  frontendLogBuffer = lines.pop() ?? '';
  return lines
    .filter((line) => line.includes('[PARALLEL_AGENT_FLOW]') && line.includes(LABEL))
    .map((line) => {
      const markerIndex = line.indexOf('[PARALLEL_AGENT_FLOW]');
      const jsonStart = line.indexOf('{', markerIndex);
      if (jsonStart < 0) return null;
      try {
        return JSON.parse(line.slice(jsonStart));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const summarizeEvents = (events) => {
  const sends = events
    .filter((event) => event.type === 'send-clicked' || event.type === 'send-blocked')
    .map((event) => ({
      index: event.index,
      at: event.at,
      elapsedMs: event.elapsedMs,
      promptLength: event.promptLength,
      blocked: event.type === 'send-blocked' || Boolean(event.blocked),
      flowId: event.flowId ?? null,
      optimisticAssistantMessageId: event.optimisticAssistantMessageId ?? null,
      optimisticUserMessageId: event.optimisticUserMessageId ?? null,
    }));
  const latestLaunch = events.slice().reverse().find((event) => event.type === 'launch-phase-complete');
  const latestPan = events.slice().reverse().find((event) => event.type === 'pan');
  const latestClick = events.slice().reverse().find((event) => event.type === 'click-node' || event.type === 'click-node-missing' || event.type === 'click-node-no-safe-target');
  const runningGraphInteractions = events.filter((event) => event.type === 'running-graph-interaction');
  const latestSample = events.slice().reverse().find((event) => event.type === 'done' || event.type === 'error')?.summary?.samples?.slice?.(-1)?.[0] ?? null;
  return {
    label: LABEL,
    done: false,
    sends,
    runningGraphInteractions,
    actions: events.slice(-80),
    samples: latestSample ? [latestSample] : [],
    errors: events
      .filter((event) => event.type === 'error')
      .map((event) => ({ at: event.at, elapsedMs: event.elapsedMs, message: 'parallel harness emitted error', summary: event.summary ?? null })),
    launch: latestLaunch ? {
      attempted: latestLaunch.attempted,
      started: latestLaunch.started,
      blocked: latestLaunch.blocked,
    } : null,
    latestPan: latestPan ? {
      actionLabel: latestPan.actionLabel,
      before: latestPan.before,
      after: latestPan.after,
      at: latestPan.at,
      elapsedMs: latestPan.elapsedMs,
    } : null,
    latestClick: latestClick ? {
      type: latestClick.type,
      actionLabel: latestClick.actionLabel,
      id: latestClick.id ?? null,
      openedSelection: latestClick.openedSelection ?? null,
      at: latestClick.at,
      elapsedMs: latestClick.elapsedMs,
    } : null,
    lastEvents: events.slice(-30),
  };
};

const waitDoneFromLog = async () => {
  const startedAt = Date.now();
  const allEvents = [];
  let lastEventCount = 0;
  let lastProgressAt = Date.now();
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const nextEvents = parseFlowLogEvents();
    if (nextEvents.length > 0) {
      allEvents.push(...nextEvents);
    }
    if (allEvents.length > lastEventCount) {
      lastEventCount = allEvents.length;
      lastProgressAt = Date.now();
    }
    const terminal = allEvents.slice().reverse().find((event) => event.type === 'done' || event.type === 'error');
    if (terminal) {
      return {
        done: terminal.type === 'done',
        terminalType: terminal.type,
        eventCount: allEvents.length,
        summary: terminal.summary ?? null,
      };
    }
    if (allEvents.length > 0 && Date.now() - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
      return {
        done: false,
        noProgressTimedOut: true,
        noProgressTimeoutMs: NO_PROGRESS_TIMEOUT_MS,
        eventCount: allEvents.length,
        summary: summarizeEvents(allEvents),
        lastEvents: allEvents.slice(-30),
      };
    }
    await sleep(1000);
  }
  const events = [...allEvents, ...parseFlowLogEvents()];
  return {
    done: false,
    timedOut: true,
    eventCount: events.length,
    summary: summarizeEvents(events),
    lastEvents: events.slice(-30),
  };
};

const collect = async () => pilotEval(`
(async () => {
  const probe = window.__PARALLEL_AGENT_FLOW__;
  probe?.cleanup?.();
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe: window.__PARALLEL_AGENT_FLOW_SUMMARY__?.() ?? null,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    fundamentals: window.__AGENTREE_FUNDAMENTALS__?.read?.() ?? null,
    lifecycleFailures: (window.__AGENTREE_PERF__?.readLatestSession?.() ?? [])
      .filter((event) => event?.name === 'send-flow.lifecycle.failed')
      .map((event) => ({
        ts: event.ts ?? null,
        flowId: event.details?.flowId ?? null,
        nodeId: event.details?.nodeId ?? null,
        errorType: event.details?.errorType ?? null,
        errorMessage: event.details?.errorMessage ?? null,
      })),
  };
})()
`, 120000);

const summarizeGraphEventContract = (fundamentals, sendsStarted) => {
  if (!fundamentals) return null;
  const graphComputation = fundamentals['graph.computation-messages'] ?? null;
  const graphRenderRefs = fundamentals['graph.render.refs'] ?? null;
  const graphLayout = fundamentals['graph.layout'] ?? null;
  const graphVisualApply = fundamentals['graph.visual.apply'] ?? null;
  const graphComputationBreakdown = graphComputation?.breakdown ?? {};
  const activeComputationCount = Object.entries(graphComputation?.breakdown ?? {})
    .filter(([key]) => key.startsWith('activeSendFlow:true'))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const activeRefreshCount =
    Number(graphComputationBreakdown['mode:active-refresh'] || 0) +
    Number(graphComputationBreakdown['mode:active-refresh-pinned'] || 0) +
    Number(graphComputationBreakdown['mode:active-refresh-structural'] || 0);
  const activeHeldCheckCount = Number(graphComputationBreakdown['mode:active-held'] || 0);
  const liveComputationCount = Number(graphComputationBreakdown['mode:live'] || 0);
  const eventBudgetPerSend = sendsStarted > 0 ? 5 : null;
  const graphComputationPerSend = sendsStarted > 0
    ? Number(((graphComputation?.count ?? 0) / sendsStarted).toFixed(2))
    : null;
  const graphChangingComputationPerSend = sendsStarted > 0
    ? Number((activeRefreshCount / sendsStarted).toFixed(2))
    : null;
  return {
    sendsStarted,
    targetGraphChangingUpdatesPerSend: eventBudgetPerSend,
    graphComputationCount: graphComputation?.count ?? 0,
    graphComputationPerSend,
    graphChangingComputationCount: activeRefreshCount,
    graphChangingComputationPerSend,
    activeHeldCheckCount,
    liveComputationCount,
    activeGraphComputationCount: activeComputationCount,
    graphComputationBreakdown: graphComputation?.breakdown ?? null,
    graphRenderRefCount: graphRenderRefs?.count ?? 0,
    graphRenderBreakdown: graphRenderRefs?.breakdown ?? null,
    graphLayoutCount: graphLayout?.count ?? 0,
    graphLayoutBreakdown: graphLayout?.breakdown ?? null,
    graphVisualApplyCount: graphVisualApply?.count ?? 0,
    status: graphChangingComputationPerSend === null
      ? 'not-measured'
      : graphChangingComputationPerSend <= eventBudgetPerSend
        ? 'within-target'
        : 'over-target',
  };
};

const main = async () => {
  const report = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    install: null,
    wait: null,
    collect: null,
    errors: [],
  };
  try {
    report.install = (await install()).value;
    report.wait = await waitDoneFromLog();
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'install-or-wait', message: error.message, stack: error.stack });
  }
  if (report.wait?.done) {
    try {
      report.collect = (await collect()).value;
    } catch (error) {
      report.errors.push({ at: new Date().toISOString(), phase: 'collect', message: error.message, stack: error.stack });
    }
  }
  const summary = report.collect?.probe ?? report.wait?.summary ?? null;
  const sendsStarted = summary?.sends?.filter?.((send) => !send.blocked)?.length ?? 0;
  const sendsBlocked = summary?.sends?.filter?.((send) => send.blocked)?.length ?? 0;
  const lifecycleFailures = report.collect?.lifecycleFailures ?? [];
  const validationErrors = [];
  if (sendsBlocked > 0) {
    validationErrors.push(`${sendsBlocked} send(s) were blocked during launch`);
  }
  if ((summary?.sends?.length ?? 0) < PROMPTS.length) {
    validationErrors.push(`only ${summary?.sends?.length ?? 0}/${PROMPTS.length} send(s) were attempted`);
  }
  if (lifecycleFailures.length > 0) {
    validationErrors.push(`${lifecycleFailures.length} send flow(s) ended with lifecycle.failed`);
  }
  const runningGraphInteractions = summary?.runningGraphInteractions ?? [];
  const activeRunningGraphInteractions = runningGraphInteractions.filter((interaction) => Number(interaction.runningBefore ?? 0) > 0);
  if (!DISABLE_GRAPH_INTERACTIONS && activeRunningGraphInteractions.length === 0) {
    validationErrors.push('graph was not dragged/click-focused while agents were running');
  }
  const activePanCount = activeRunningGraphInteractions.filter((interaction) => interaction.panOk).length;
  if (!DISABLE_GRAPH_INTERACTIONS && activePanCount === 0) {
    validationErrors.push('no successful graph drag was observed while agents were running');
  }
  const activeFocusCount = activeRunningGraphInteractions.filter((interaction) => interaction.clickedId && interaction.focusChanged).length;
  if (!DISABLE_GRAPH_INTERACTIONS && !DISABLE_GRAPH_CLICKS && activeFocusCount === 0) {
    validationErrors.push('no successful graph node focus click was observed while agents were running');
  }
  const graphEventContract = summarizeGraphEventContract(report.collect?.fundamentals, sendsStarted);
  if (report.collect) {
    report.collect.graphEventContract = graphEventContract;
    report.collect.validationErrors = validationErrors;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    reportPath,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    sendsAttempted: summary?.sends?.length ?? 0,
    sendsStarted,
    sendsBlocked,
    done: report.collect?.probe?.done ?? report.wait?.done ?? false,
    errors: [
      ...report.errors.map((error) => error.message),
      ...(summary?.errors ?? []).map((error) => error.message),
      ...validationErrors,
    ],
    lifecycleFailures,
    maxRafGapMs: summary?.maxRafGapMs ?? null,
    maxIntervalGapMs: summary?.maxIntervalGapMs ?? null,
    rafStallCount: summary?.rafStallCount ?? null,
    intervalStallCount: summary?.intervalStallCount ?? null,
    noProgressTimedOut: report.wait?.noProgressTimedOut ?? false,
    timedOut: report.wait?.timedOut ?? false,
    latestPan: summary?.latestPan ?? null,
    latestClick: summary?.latestClick ?? null,
    graphEventContract,
  }, null, 2));
  if (report.errors.length > 0 || (summary?.errors?.length ?? 0) > 0 || validationErrors.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
