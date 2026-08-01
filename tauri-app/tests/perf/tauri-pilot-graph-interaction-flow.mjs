import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-graph-interaction-${Date.now()}`;
const TEST_AGENT_MODEL = process.env.AGENTREE_TAURI_PILOT_AGENT_MODEL ?? 'gpt-5.4-mini';
const RUN_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_RUN_TIMEOUT_MS ?? 240000);
const FOCUS_ONLY_CLICKS = Number(process.env.AGENTREE_TAURI_PILOT_FOCUS_ONLY_CLICKS ?? 0);
const PROMPTS = (process.env.AGENTREE_TAURI_PILOT_PROMPTS
  ? JSON.parse(process.env.AGENTREE_TAURI_PILOT_PROMPTS)
  : [
      'Reply with OK only.',
      'Reply with OK only.',
      'Reply with OK only.',
    ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const desktopPreflight = () => {
  const raw = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  }).trim();
  const processes = raw
    ? raw
        .split('\n')
        .map((line) => {
          const match = line.match(/^\s*(\d+)\s+(.*)$/);
          return match ? { pid: match[1], command: match[2] } : null;
        })
        .filter(Boolean)
        .filter((process) => (
          process.command.includes('target/debug/agentree') ||
          process.command.includes('/Applications/agentree.app/Contents/MacOS/agentree')
        ))
    : [];
  const devProcesses = processes.filter((process) => process.command.includes('target/debug/agentree'));
  const packagedProcesses = processes.filter((process) => process.command.includes('/Applications/agentree.app/Contents/MacOS/agentree'));

  if (packagedProcesses.length > 0) {
    throw new Error(`desktop preflight failed: close packaged Agentree before perf tests: ${packagedProcesses.map((process) => `${process.pid}:${process.command}`).join(' | ')}`);
  }
  if (devProcesses.length !== 1) {
    throw new Error(`desktop preflight failed: expected exactly one dev Agentree process, found ${devProcesses.length}: ${processes.map((process) => `${process.pid}:${process.command}`).join(' | ')}`);
  }
  return { processes, devProcess: devProcesses[0] };
};

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

const install = async () => pilotEval(`
(async () => {
  const label = ${JSON.stringify(LABEL)};
  const prompts = ${JSON.stringify(PROMPTS)};
  const testAgentModel = ${JSON.stringify(TEST_AGENT_MODEL)};
  const runTimeoutMs = ${JSON.stringify(RUN_TIMEOUT_MS)};
  const focusOnlyClicks = ${JSON.stringify(FOCUS_ONLY_CLICKS)};
  if (document.visibilityState !== 'visible') {
    throw new Error('desktop visibility preflight failed: document.visibilityState=' + document.visibilityState);
  }
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_FUNDAMENTALS__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  window.__GRAPH_INTERACTION_FLOW__?.cleanup?.();

  const probe = {
    label,
    testAgentModel,
    prompts,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    actions: [],
    samples: [],
    errors: [],
    sends: [],
    focusOnlyClicks,
    focusWalkClickedNodeIds: [],
    rafStalls: [],
    intervalStalls: [],
    longTasks: [],
    maxRafGapMs: 0,
    maxIntervalGapMs: 0,
    visibilityPreflight: {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      capturedAt: new Date().toISOString(),
    },
    done: false,
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nowElapsed = () => Number((performance.now() - probe.startedAt).toFixed(2));
  const logAction = (type, details = {}) => probe.actions.push({ type, at: new Date().toISOString(), elapsedMs: nowElapsed(), ...details });
  const summarizeEvent = (event) => event ? ({
    name: event.name ?? null,
    ts: event.ts ?? null,
    source: event.source ?? null,
    details: event.details ? {
      status: event.details.status ?? null,
      nextStatus: event.details.nextStatus ?? null,
      flowId: event.details.flowId ?? null,
      assistantId: event.details.assistantId ?? null,
      userId: event.details.userId ?? null,
    } : null,
  }) : null;
  const summarizeProbe = () => ({
    label: probe.label,
    testAgentModel: probe.testAgentModel,
    prompts: probe.prompts,
    focusOnlyClicks: probe.focusOnlyClicks,
    startedAtIso: probe.startedAtIso,
    done: probe.done,
    sends: probe.sends,
    actions: probe.actions.slice(-80),
    samples: probe.samples.slice(-140),
    errors: probe.errors,
    maxRafGapMs: probe.maxRafGapMs,
    maxIntervalGapMs: probe.maxIntervalGapMs,
    visibilityPreflight: probe.visibilityPreflight,
    rafStallCount: probe.rafStalls.length,
    intervalStallCount: probe.intervalStalls.length,
    longTaskCount: probe.longTasks.length,
    rafStalls: probe.rafStalls.slice(-40),
    intervalStalls: probe.intervalStalls.slice(-40),
    longTasks: probe.longTasks.slice(-40),
  });
  const findComposer = () => document.querySelector('[data-testid="chat-composer-textarea"]') || document.querySelector('textarea');
  const sendButton = () => document.querySelector('[data-testid="chat-send-button"]');
  const buttonLabel = () => {
    const button = sendButton();
    return button ? (button.getAttribute('aria-label') || button.textContent || '').trim() : null;
  };
  const isSendReady = () => {
    const textarea = findComposer();
    const button = sendButton();
    const label = buttonLabel();
    return Boolean(textarea && !textarea.disabled && button && !button.disabled && label !== 'Cancel sending message' && label !== 'Cancel');
  };
  const isComposerReadyForPrompt = () => {
    const textarea = findComposer();
    const label = buttonLabel();
    return Boolean(textarea && !textarea.disabled && label !== 'Cancel sending message' && label !== 'Cancel');
  };
  const ensureLatestRunnableFocus = async (label) => {
    const currentFocusedMessageId = (() => {
      try {
        return new URL(location.href).searchParams.get('messageId');
      } catch {
        return null;
      }
    })();
    const workspaceStore = await import(new URL('/src/stores/workspaceStore.ts', location.origin).href);
    const apiModule = await import(new URL('/src/lib/api.ts', location.origin).href);
    const gitNodeUtils = await import(new URL('/src/lib/gitNodeUtils.ts', location.origin).href);
    const workspaceId = workspaceStore.useWorkspaceStore?.getState?.().selectedWorkspaceId ?? null;
    if (!workspaceId) {
      throw new Error('latest runnable focus preflight failed: no selected workspace');
    }
    const response = await apiModule.api.get('/workspaces/' + workspaceId + '/messages');
    const messages = Array.isArray(response.data) ? response.data : [];
    const sortedMessages = messages.slice().sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || left.updatedAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || right.updatedAt || '') || 0;
      return rightTime - leftTime;
    });
    const absoluteLatest = sortedMessages[0] ?? null;
    const latestRunnable = sortedMessages.find((message) => gitNodeUtils.resolveNodeCommit(message, messages, null));
    if (!latestRunnable) {
      throw new Error('latest runnable focus preflight failed: no message can resolve a git base commit');
    }
    const latestRunnableCommit = gitNodeUtils.resolveNodeCommit(latestRunnable, messages, null);
    if (latestRunnable.id === currentFocusedMessageId) {
      logAction('latest-runnable-focus-ready', {
        label,
        messageId: latestRunnable.id,
        commitSha: latestRunnableCommit,
        absoluteLatestMessageId: absoluteLatest?.id ?? null,
        absoluteLatestRunnable: absoluteLatest?.id === latestRunnable.id,
        source: 'url',
      });
      return latestRunnable.id;
    }
    workspaceStore.useWorkspaceStore?.getState?.().dispatchFocus?.({
      messageId: latestRunnable.id,
      source: 'system',
      metadata: { reason: 'perf-latest-runnable-focus', label },
    });
    await sleep(500);
    const focused = workspaceStore.useWorkspaceStore?.getState?.().focusedMessageId ?? null;
    if (focused !== latestRunnable.id) {
      throw new Error('latest runnable focus preflight failed: expected focus ' + latestRunnable.id + ', got ' + focused);
    }
    logAction('latest-runnable-focus-set', {
      label,
      previousMessageId: currentFocusedMessageId,
      messageId: latestRunnable.id,
      role: latestRunnable.role ?? null,
      status: latestRunnable.status ?? null,
      commitSha: latestRunnableCommit,
      createdAt: latestRunnable.createdAt ?? null,
      absoluteLatestMessageId: absoluteLatest?.id ?? null,
      absoluteLatestCreatedAt: absoluteLatest?.createdAt ?? null,
      absoluteLatestRunnable: absoluteLatest?.id === latestRunnable.id,
      absoluteLatestStatus: absoluteLatest?.status ?? null,
      skippedLatestReason: absoluteLatest?.id === latestRunnable.id ? null : 'latest message has no resolvable git base commit',
      text: (latestRunnable.aiLabel || latestRunnable.content || '').trim().slice(0, 100),
    });
    sample('latest-runnable-focus-' + label);
    return latestRunnable.id;
  };
  const latestTerminalAfter = (sentAtIso) => {
    const sentAt = Date.parse(sentAtIso);
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared')
      .slice()
      .reverse()
      .find((event) => {
        const status = event?.details?.nextStatus || event?.details?.status;
        if (!['failed', 'completed', 'cancelled'].includes(status)) return false;
        const eventAt = Date.parse(event?.ts || '');
        return Number.isFinite(eventAt) && eventAt >= sentAt;
      }) || null;
  };
  const latestFlowStartedAfter = (sentAtIso) => {
    const sentAt = Date.parse(sentAtIso);
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => event?.name === 'send-flow.flow.started')
      .slice()
      .reverse()
      .find((event) => {
        const eventAt = Date.parse(event?.ts || '');
        return Number.isFinite(eventAt) && eventAt >= sentAt - 100;
      }) || null;
  };
  const flowTerminalEvent = (flowId) => {
    if (!flowId) return null;
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => ['send-flow.lifecycle.completed', 'send-flow.lifecycle.failed', 'send-flow.lifecycle.cancelled'].includes(event?.name))
      .slice()
      .reverse()
      .find((event) => event?.details?.flowId === flowId) || null;
  };
  const flowCleanupEvent = (flowId) => {
    if (!flowId) return null;
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => event?.name === 'send-flow.cleanup.finished')
      .slice()
      .reverse()
      .find((event) => event?.details?.flowId === flowId) || null;
  };
  const flowMarkEvent = (flowId, markNames) => {
    if (!flowId) return null;
    const names = new Set(Array.isArray(markNames) ? markNames : [markNames]);
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => event?.name === 'send-flow.mark' && names.has(event?.details?.markName))
      .slice()
      .reverse()
      .find((event) => event?.details?.flowId === flowId) || null;
  };
  const graphCounts = () => ({
    nodes: document.querySelectorAll('.react-flow__node').length,
    edges: document.querySelectorAll('.react-flow__edge').length,
    transform: document.querySelector('.react-flow__viewport')?.style.transform || null,
  });
  const hoverCardCount = () => document.querySelectorAll('[data-agentree-node-hover-card="true"], [data-radix-hover-card-content]').length;
  const cssEscape = (value) => {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  };
  const getGraphDiagnosticCapture = async (label) => {
    const debug = window.__AGENTREE_GRAPH_DEBUG__;
    try {
      if (debug?.capture) return debug.capture(label) ?? null;
      const graphDiagnosticsModule = await import(new URL('/src/lib/graphDiagnostics.ts', location.origin).href);
      return graphDiagnosticsModule.captureGraphDiagnostics?.(label) ?? null;
    } catch (error) {
      logAction('graph-diagnostic-capture-failed', { label, message: String(error?.message || error) });
      return null;
    }
  };
  const getGraphNodeElement = (id) => (
    document.querySelector('.react-flow__node[data-id="' + cssEscape(id) + '"]') ||
    document.querySelector('[data-agentree-graph-node-id="' + cssEscape(id) + '"]')?.closest('.react-flow__node')
  );
  const isClickableGraphNodeElement = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 20 || rect.height <= 20) return false;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false;
    return true;
  };
  const isSemanticFocusCandidate = (node) => {
    if (!node?.id) return false;
    if (node.parentNode) return false;
    if (node.type === 'turn_group_hull') return false;
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
  const pickSemanticClickableNode = async (label) => {
    const capture = await getGraphDiagnosticCapture('semantic-click-' + label);
    const payload = capture?.payload ?? {};
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const edges = Array.isArray(payload.edges) ? payload.edges : [];
    const focusedMessageId = payload.focusedMessageId ?? null;
    const semanticNodes = nodes.filter(isSemanticFocusCandidate);
    const nodeById = new Map(semanticNodes.map((node) => [node.id, node]));
    const focusedNode = nodeById.get(focusedMessageId) ?? semanticNodes.find((node) => node.id === focusedMessageId) ?? null;
    const clickedIds = new Set(probe.focusWalkClickedNodeIds);
    const adjacentIds = focusedNode
      ? edges.flatMap((edge) => {
          if (edge.source === focusedNode.id) return [edge.target];
          if (edge.target === focusedNode.id) return [edge.source];
          return [];
        })
      : [];
    const adjacentNodes = adjacentIds.map((id) => nodeById.get(id)).filter(Boolean);
    const semanticPool = (adjacentNodes.length > 0 ? adjacentNodes : semanticNodes)
      .filter((node) => node.id !== focusedMessageId)
      .sort((left, right) => {
        const leftClicked = clickedIds.has(left.id) ? 1 : 0;
        const rightClicked = clickedIds.has(right.id) ? 1 : 0;
        if (leftClicked !== rightClicked) return leftClicked - rightClicked;
        if (focusedNode) return distanceBetweenNodes(left, focusedNode) - distanceBetweenNodes(right, focusedNode);
        return String(left.id).localeCompare(String(right.id));
      });
    const mountedCandidates = semanticPool
      .map((node) => ({ node, element: getGraphNodeElement(node.id) }))
      .filter((entry) => isClickableGraphNodeElement(entry.element));
    const chosen = mountedCandidates[0] ?? null;
    logAction('semantic-click-candidates', {
      label,
      captureId: capture?.id ?? null,
      focusedMessageId,
      totalLayoutNodes: nodes.length,
      totalEdges: edges.length,
      semanticCandidateCount: semanticNodes.length,
      adjacentCandidateCount: adjacentNodes.length,
      mountedCandidateCount: mountedCandidates.length,
      chosenId: chosen?.node?.id ?? null,
      chosenRole: chosen?.node?.data?.role ?? null,
    });
    return chosen;
  };
  const movePointerToNeutralPane = async (label) => {
    const pane = document.querySelector('.react-flow__pane') || document.querySelector('.react-flow');
    if (!pane) return false;
    const rect = pane.getBoundingClientRect();
    const x = rect.left + Math.min(Math.max(18, rect.width - 18), rect.width * 0.94);
    const y = rect.top + Math.min(Math.max(18, rect.height - 18), rect.height * 0.94);
    const events = [
      new PointerEvent('pointermove', { bubbles: true, pointerId: 88, pointerType: 'mouse', button: -1, buttons: 0, clientX: x, clientY: y }),
      new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: x, clientY: y }),
    ];
    for (const event of events) pane.dispatchEvent(event);
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 88, pointerType: 'mouse', button: -1, buttons: 0, clientX: x, clientY: y }));
    await sleep(140);
    logAction('pointer-neutralized', { label, x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), hoverCardCount: hoverCardCount() });
    return true;
  };
  const sample = (label) => {
    const textarea = findComposer();
    const item = {
      label,
      at: new Date().toISOString(),
      elapsedMs: nowElapsed(),
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      buttonLabel: buttonLabel(),
      buttonDisabled: sendButton()?.disabled ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      textareaValueLength: textarea?.value?.length ?? null,
      graph: graphCounts(),
      hoverCardCount: hoverCardCount(),
      selectedNodeIds: [...document.querySelectorAll('.react-flow__node.selected')].map((node) => node.getAttribute('data-id')).filter(Boolean),
      chatTextLength: (document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body).textContent?.length ?? 0,
    };
    probe.samples.push(item);
    return item;
  };

  const clearSelectionState = async (label) => {
    const before = {
      selectedNodeCount: document.querySelectorAll('.react-flow__node.selected').length,
      overlayText: [...document.querySelectorAll('[role="status"], [role="dialog"], button')]
        .map((element) => (element.textContent || '').trim())
        .find((text) => text.includes('Select Merge Target')) || null,
    };
    try {
      const mergeModule = await import(new URL('/src/stores/mergeStore.ts', location.origin).href);
      mergeModule.useMergeStore?.getState?.().exitSelectionMode?.();
    } catch (error) {
      logAction('clear-selection-merge-import-failed', { label, message: String(error?.message || error) });
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', code: 'Escape' }));
    const pane = document.querySelector('.react-flow__pane');
    if (pane) {
      const rect = pane.getBoundingClientRect();
      const x = rect.left + Math.min(Math.max(24, rect.width * 0.1), Math.max(24, rect.width - 24));
      const y = rect.top + Math.min(Math.max(24, rect.height * 0.1), Math.max(24, rect.height - 24));
      pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 99, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
      pane.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: x, clientY: y }));
    }
    await sleep(80);
    const after = {
      selectedNodeCount: document.querySelectorAll('.react-flow__node.selected').length,
      selectionOverlayPresent: [...document.querySelectorAll('[role="status"], [role="dialog"], button')]
        .some((element) => (element.textContent || '').includes('Select Merge Target')),
    };
    logAction('clear-selection-state', { label, before, after });
    return after;
  };

  const clearHoverCards = async (label) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', code: 'Escape' }));
    const nodes = [...document.querySelectorAll('[data-agentree-graph-node-id], [data-graph-commit-id]')];
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const x = rect.left + Math.min(Math.max(1, rect.width / 2), Math.max(1, rect.width - 1));
      const y = rect.top + Math.min(Math.max(1, rect.height / 2), Math.max(1, rect.height - 1));
      node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerId: 77, pointerType: 'mouse', clientX: x, clientY: y }));
      node.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerId: 77, pointerType: 'mouse', clientX: x, clientY: y }));
      node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, clientX: x, clientY: y }));
      node.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, clientX: x, clientY: y }));
    }
    await movePointerToNeutralPane('clear-hover-' + label);
    await sleep(180);
    logAction('clear-hover-cards', { label, hoverCardCount: hoverCardCount() });
  };

  let expectedInterval = performance.now() + 100;
  let longTaskObserver = null;
  try {
    if (typeof PerformanceObserver === 'function') {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.longTasks.push({
            at: new Date(performance.timeOrigin + entry.startTime).toISOString(),
            elapsedMs: Number(entry.startTime.toFixed(2)),
            durationMs: Number(entry.duration.toFixed(2)),
            name: entry.name,
            entryType: entry.entryType,
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    }
  } catch (error) {
    logAction('longtask-observer-unavailable', { message: String(error?.message || error) });
    longTaskObserver = null;
  }

  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.intervalStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)), sample: graphCounts() });
    expectedInterval = now + 100;
  }, 100);

  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.rafStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)), sample: graphCounts() });
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const setPromptAndSend = async (prompt, index) => {
    const textarea = findComposer();
    const button = sendButton();
    if (!textarea || !button) throw new Error('composer or send button missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
    if (!isSendReady()) throw new Error('send not ready; label=' + buttonLabel());
    button.click();
    const send = { index, at: new Date().toISOString(), elapsedMs: nowElapsed(), promptLength: prompt.length };
    for (let attempt = 0; attempt < 10; attempt += 1) {
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
    sample('send-' + index + '-clicked');
    return send;
  };

  const panGraph = async (label) => {
    const root = document.querySelector('.react-flow');
    const pane = document.querySelector('.react-flow__pane') || root;
    if (!root || !pane) {
      logAction('pan-missing-target', { label });
      return false;
    }
    const before = graphCounts();
    const rect = root.getBoundingClientRect();
    const x = rect.left + Math.max(80, rect.width * 0.45);
    const y = rect.top + Math.max(80, rect.height * 0.45);
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    for (let i = 1; i <= 8; i += 1) {
      pane.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x + i * 18, clientY: y + i * 8 }));
      await sleep(25);
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: x + 144, clientY: y + 64 }));
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 120, deltaY: 90, clientX: x, clientY: y }));
    await sleep(250);
    const after = graphCounts();
    logAction('pan', { label, before, after });
    await movePointerToNeutralPane('after-pan-' + label);
    sample('after-pan-' + label);
    return true;
  };

  const clickAnotherNode = async (label) => {
    const chosen = await pickSemanticClickableNode(label);
    if (!chosen?.element) {
      logAction('click-node-missing', { label, reason: 'no-mounted-semantic-candidate' });
      return null;
    }
    const node = chosen.element;
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(rect.height / 2, 38);
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: x, clientY: y }));
    await sleep(80);
    await movePointerToNeutralPane('after-click-' + label);
    await sleep(220);
    const id = chosen.node.id;
    probe.focusWalkClickedNodeIds.push(id);
    logAction('click-node', { label, id, role: chosen.node.data?.role ?? null, text: (node.textContent || '').trim().slice(0, 80), hoverCardCount: hoverCardCount() });
    sample('after-click-' + label);
    return id;
  };

  const waitUntilReady = async (label, timeoutMs = runTimeoutMs) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const current = sample('wait-ready-' + label);
      if (isComposerReadyForPrompt()) return current;
      await sleep(500);
    }
    throw new Error('timed out waiting ready: ' + label);
  };

  const waitTerminal = async (send, label, timeoutMs = runTimeoutMs) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const terminal = flowTerminalEvent(send.flowId) || (!send.flowId ? latestTerminalAfter(send.at) : null);
      if (terminal) {
        logAction('terminal', { label, terminal: summarizeEvent(terminal) });
        sample('terminal-' + label);
        if (terminal?.name === 'send-flow.lifecycle.failed') {
          const message = terminal?.details?.errorMessage || 'send flow failed';
          throw new Error('terminal failed for ' + label + ': ' + message);
        }
        return terminal;
      }
      await sleep(500);
    }
    throw new Error('timed out waiting terminal: ' + label);
  };

  const waitFlowMark = async (send, label, markNames, timeoutMs = 45000) => {
    if (!send.flowId) return null;
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const terminal = flowTerminalEvent(send.flowId);
      if (terminal) {
        logAction('mark-wait-terminal-before-mark', { label, markNames, terminal: summarizeEvent(terminal) });
        return null;
      }
      const mark = flowMarkEvent(send.flowId, markNames);
      if (mark) {
        logAction('mark-observed', { label, mark: summarizeEvent(mark), markName: mark?.details?.markName ?? null });
        sample('mark-' + label);
        return mark;
      }
      await sleep(250);
    }
    logAction('mark-wait-timeout', { label, markNames });
    return null;
  };

  const waitForFocusCenterSettled = async (label, timeoutMs = 5000) => {
    const startedAtWall = Date.now();
    const startedAtPerf = performance.now();
    while (performance.now() - startedAtPerf < timeoutMs) {
      const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
      const endEvent = perfEvents
        .slice()
        .reverse()
        .find((event) => event?.name === 'graph.focus-center.end' && Date.parse(event?.ts || '') >= startedAtWall);
      if (endEvent) {
        logAction('focus-center-settled', { label, event: summarizeEvent(endEvent) });
        await sleep(160);
        return endEvent;
      }
      await sleep(100);
    }
    logAction('focus-center-settle-timeout', { label, timeoutMs });
    return null;
  };

  const waitCleanup = async (send, label, timeoutMs = 15000) => {
    if (!send.flowId) return null;
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const cleanup = flowCleanupEvent(send.flowId);
      if (cleanup) {
        logAction('cleanup', { label, cleanup: summarizeEvent(cleanup) });
        sample('cleanup-' + label);
        return cleanup;
      }
      await sleep(250);
    }
    logAction('cleanup-timeout', { label, flowId: send.flowId });
    return null;
  };

  const run = async () => {
    try {
      sample('installed');
      await clearHoverCards('initial');
      await clearSelectionState('initial');
      await ensureLatestRunnableFocus('initial');
      await waitForFocusCenterSettled('initial-latest-focus');
      if (focusOnlyClicks > 0) {
        for (let i = 0; i < focusOnlyClicks; i += 1) {
          const id = await clickAnotherNode('focus-only-' + (i + 1));
          if (!id) {
            throw new Error('focus-only click ' + (i + 1) + ' found no mounted semantic graph candidate');
          }
          await clearSelectionState('focus-only-' + (i + 1));
          await clearHoverCards('focus-only-' + (i + 1));
          await sleep(300);
        }
        probe.done = true;
        sample('done');
        return;
      }
      for (let i = 0; i < prompts.length; i += 1) {
        await clearSelectionState('before-send-' + (i + 1));
        await waitUntilReady('before-send-' + (i + 1));
        const send = await setPromptAndSend(prompts[i], i + 1);
        await sleep(700);
        await panGraph('run-' + (i + 1) + '-active');
        await clickAnotherNode('run-' + (i + 1) + '-active');
        if (!isSendReady()) {
          logAction('parallel-send-unavailable', { afterSend: i + 1, buttonLabel: buttonLabel(), textareaDisabled: findComposer()?.disabled ?? null });
        } else {
          logAction('parallel-send-available', { afterSend: i + 1 });
        }
        const streamMark = await waitFlowMark(send, 'send-' + (i + 1) + '-streaming', ['first_visible_text_rendered', 'first_assistant_delta']);
        if (streamMark && !flowTerminalEvent(send.flowId)) {
          await panGraph('run-' + (i + 1) + '-streaming');
          await clickAnotherNode('run-' + (i + 1) + '-streaming');
        }
        await waitTerminal(send, 'send-' + (i + 1));
        await waitCleanup(send, 'send-' + (i + 1));
        await clearSelectionState('after-terminal-' + (i + 1));
      }
      probe.done = true;
      sample('done');
    } catch (error) {
      probe.errors.push({ at: new Date().toISOString(), elapsedMs: nowElapsed(), message: String(error?.message || error), stack: error?.stack || null });
      sample('error');
      probe.done = true;
    }
  };

  probe.cleanup = () => {
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
    longTaskObserver?.disconnect?.();
  };
  window.__GRAPH_INTERACTION_FLOW__ = probe;
  window.__GRAPH_INTERACTION_FLOW_SUMMARY__ = summarizeProbe;
  window.setTimeout(run, 250);
  return { label, url: location.href, promptCount: prompts.length, focusOnlyClicks, testAgentModel };
})()
`);

const waitDone = async () => {
  const startedAt = Date.now();
  let evalTimeouts = 0;
  while (Date.now() - startedAt < RUN_TIMEOUT_MS * Math.max(1, PROMPTS.length)) {
    let value = null;
    try {
      ({ value } = await pilotEval(`
(() => {
  const probe = window.__GRAPH_INTERACTION_FLOW__;
  return {
    done: Boolean(probe?.done),
    sends: probe?.sends?.length ?? 0,
    errors: probe?.errors ?? [],
    maxRafGapMs: probe?.maxRafGapMs ?? null,
    maxIntervalGapMs: probe?.maxIntervalGapMs ?? null,
  };
})()
`, 30000));
    } catch (error) {
      evalTimeouts += 1;
      if (evalTimeouts >= 3) {
        return { done: false, evalTimeouts, lastError: error.message };
      }
      await sleep(5000);
      continue;
    }
    if (value?.done) return value;
    await sleep(5000);
  }
  return { done: false, timedOut: true, evalTimeouts };
};

const collect = async () => pilotEval(`
(async () => {
  const probe = window.__GRAPH_INTERACTION_FLOW__;
  probe?.cleanup?.();
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe: window.__GRAPH_INTERACTION_FLOW_SUMMARY__?.() ?? null,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    fundamentals: window.__AGENTREE_FUNDAMENTALS__?.read?.() ?? null,
  };
})()
`, 120000);

const summarizeGraphEventContract = (fundamentals, sendsAttempted) => {
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
    Number(graphComputationBreakdown['mode:active-refresh-pinned'] || 0);
  const activeHeldCheckCount = Number(graphComputationBreakdown['mode:active-held'] || 0);
  const liveComputationCount = Number(graphComputationBreakdown['mode:live'] || 0);
  const unitCount = sendsAttempted;
  const eventBudgetPerSend = unitCount > 0 ? 5 : null;
  const graphComputationPerSend = unitCount > 0
    ? Number(((graphComputation?.count ?? 0) / unitCount).toFixed(2))
    : null;
  const graphChangingComputationPerSend = unitCount > 0
    ? Number((activeRefreshCount / unitCount).toFixed(2))
    : null;
  return {
    sendsAttempted,
    measuredUnitCount: unitCount,
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
    desktopPreflight: null,
    install: null,
    wait: null,
    collect: null,
    errors: [],
  };
  try {
    report.desktopPreflight = desktopPreflight();
    report.install = (await install()).value;
    report.wait = await waitDone();
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'install-or-wait', message: error.message, stack: error.stack });
  }
  if (report.install) {
    try {
      report.collect = (await collect()).value;
    } catch (error) {
      report.errors.push({ at: new Date().toISOString(), phase: 'collect', message: error.message, stack: error.stack });
    }
  }
  const graphEventContract = summarizeGraphEventContract(
    report.collect?.fundamentals,
    report.collect?.probe?.sends?.length ?? 0
  );
  if (report.collect) {
    report.collect.graphEventContract = graphEventContract;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    reportPath,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    sendsAttempted: report.collect?.probe?.sends?.length ?? 0,
    done: report.collect?.probe?.done ?? false,
    errors: [
      ...report.errors.map((error) => error.message),
      ...(report.collect?.probe?.errors ?? []).map((error) => error.message),
    ],
    maxRafGapMs: report.collect?.probe?.maxRafGapMs ?? null,
    maxIntervalGapMs: report.collect?.probe?.maxIntervalGapMs ?? null,
    rafStallCount: report.collect?.probe?.rafStalls?.length ?? null,
    intervalStallCount: report.collect?.probe?.intervalStalls?.length ?? null,
    graphEventContract,
    fundamentals: report.collect?.fundamentals ?? null,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
