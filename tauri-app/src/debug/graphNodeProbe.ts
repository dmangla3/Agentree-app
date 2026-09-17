type ProbeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProbeElementSummary = {
  tagName: string;
  id: string | null;
  className: string | null;
  text: string;
};

type GraphNodeProbeSample = {
  type: 'sample';
  at: string;
  elapsedMs: number;
  reason: string;
  present: boolean;
  rect: ProbeRect | null;
  style: {
    display: string | null;
    visibility: string | null;
    opacity: string | null;
    pointerEvents: string | null;
    transform: string | null;
  } | null;
  topElementAtCenter: ProbeElementSummary | null;
  hoverCardCount: number;
  hoverCardText: string[];
  graphNodeCount: number;
};

type GraphNodeProbeLogEvent = {
  type: 'console' | 'runtime-error';
  at: string;
  elapsedMs: number;
  level?: 'warn' | 'error';
  message: string;
  args?: string[];
};

type GraphNodeProbeDomEvent = {
  type: 'dom-event';
  at: string;
  elapsedMs: number;
  eventType: string;
  target: ProbeElementSummary | null;
};

export type GraphNodeProbeEvent = GraphNodeProbeSample | GraphNodeProbeLogEvent | GraphNodeProbeDomEvent;

export type GraphNodeProbeReport = {
  nodeId: string;
  installedAt: string;
  installedAtMs: number;
  sampleCount: number;
  events: GraphNodeProbeEvent[];
  perfEvents: unknown[];
};

type GraphNodeProbeOptions = {
  intervalMs: number;
  maxEvents: number;
  maxPerfEvents: number;
};

type ConsoleMethod = (...args: unknown[]) => void;

declare global {
  interface Window {
    __agentreeDebug?: {
      installGraphNodeProbe: (nodeId: string, options?: Partial<GraphNodeProbeOptions>) => GraphNodeProbeReport;
      readGraphNodeProbe: () => GraphNodeProbeReport | null;
      clearGraphNodeProbe: () => void;
    };
  }
}

const DEFAULT_OPTIONS: GraphNodeProbeOptions = {
  intervalMs: 250,
  maxEvents: 800,
  maxPerfEvents: 200,
};

const HOVER_CARD_SELECTOR = [
  '[data-radix-hover-card-content]',
  '[data-radix-popper-content-wrapper]',
  '[role="tooltip"]',
].join(',');

let activeProbe: {
  nodeId: string;
  installedAt: string;
  installedAtMs: number;
  options: GraphNodeProbeOptions;
  events: GraphNodeProbeEvent[];
  sampleCount: number;
  observer: MutationObserver | null;
  interval: number | null;
  restoreConsole: () => void;
  removeListeners: () => void;
} | null = null;

const elapsedMs = () => {
  if (!activeProbe) return 0;
  return Number((performance.now() - activeProbe.installedAtMs).toFixed(2));
};

const stringFromArg = (arg: unknown): string => {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
};

const cssEscape = (value: string) => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
};

const summarizeElement = (element: Element | null): ProbeElementSummary | null => {
  if (!element) return null;
  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    className: typeof element.className === 'string' ? element.className || null : null,
    text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
  };
};

const rectFromElement = (element: Element): ProbeRect => {
  const rect = element.getBoundingClientRect();
  return {
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
  };
};

const findNodeElement = (nodeId: string): HTMLElement | null => {
  const escaped = cssEscape(nodeId);
  return (
    document.querySelector<HTMLElement>(`[data-agentree-graph-node-id="${escaped}"]`)?.closest<HTMLElement>('.react-flow__node')
    ?? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`)
    ?? document.querySelector<HTMLElement>(`[data-agentree-graph-node-id="${escaped}"]`)
  );
};

const pushEvent = (event: GraphNodeProbeEvent) => {
  if (!activeProbe) return;
  activeProbe.events.push(event);
  if (activeProbe.events.length > activeProbe.options.maxEvents) {
    activeProbe.events.splice(0, activeProbe.events.length - activeProbe.options.maxEvents);
  }
};

const collectSample = (reason: string) => {
  if (!activeProbe) return;
  const node = findNodeElement(activeProbe.nodeId);
  const rect = node ? rectFromElement(node) : null;
  const style = node ? window.getComputedStyle(node) : null;
  const centerX = rect ? rect.x + rect.width / 2 : 0;
  const centerY = rect ? rect.y + rect.height / 2 : 0;
  const hoverCards = [...document.querySelectorAll<HTMLElement>(HOVER_CARD_SELECTOR)]
    .filter((element) => element.getClientRects().length > 0);

  activeProbe.sampleCount += 1;
  pushEvent({
    type: 'sample',
    at: new Date().toISOString(),
    elapsedMs: elapsedMs(),
    reason,
    present: Boolean(node),
    rect,
    style: style ? {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      transform: style.transform,
    } : null,
    topElementAtCenter: rect ? summarizeElement(document.elementFromPoint(centerX, centerY)) : null,
    hoverCardCount: hoverCards.length,
    hoverCardText: hoverCards.map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260)),
    graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
  });
};

const installConsoleCapture = () => {
  const originalWarn: ConsoleMethod = console.warn.bind(console);
  const originalError: ConsoleMethod = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    pushEvent({
      type: 'console',
      level: 'warn',
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      message: args.map(stringFromArg).join(' '),
      args: args.map(stringFromArg).slice(0, 6),
    });
    originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    pushEvent({
      type: 'console',
      level: 'error',
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      message: args.map(stringFromArg).join(' '),
      args: args.map(stringFromArg).slice(0, 6),
    });
    originalError(...args);
  };

  return () => {
    console.warn = originalWarn;
    console.error = originalError;
  };
};

const installRuntimeErrorCapture = () => {
  const onError = (event: ErrorEvent) => {
    pushEvent({
      type: 'runtime-error',
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      message: event.error instanceof Error ? event.error.stack || event.error.message : event.message,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    pushEvent({
      type: 'runtime-error',
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      message: stringFromArg(event.reason),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
};

const installDomEventCapture = (nodeId: string) => {
  const handler = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const node = findNodeElement(nodeId);
    if (!node || (target && !node.contains(target))) return;
    pushEvent({
      type: 'dom-event',
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      eventType: event.type,
      target: summarizeElement(target),
    });
  };
  const options = { capture: true, passive: true } as const;
  const eventTypes = ['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'focusin', 'focusout'];
  for (const eventType of eventTypes) {
    document.addEventListener(eventType, handler, options);
  }
  return () => {
    for (const eventType of eventTypes) {
      document.removeEventListener(eventType, handler, options);
    }
  };
};

const readPerfEvents = () => {
  if (!activeProbe) return [];
  const events = window.__AGENTREE_PERF__?.read?.();
  if (!Array.isArray(events)) return [];
  const installedAtMs = Date.parse(activeProbe.installedAt);
  return events
    .filter((event) => {
      if (!event || typeof event !== 'object') return false;
      const record = event as { ts?: unknown; name?: unknown };
      if (typeof record.name !== 'string' || !record.name.startsWith('graph.')) return false;
      if (typeof record.ts !== 'string') return true;
      const eventMs = Date.parse(record.ts);
      return Number.isNaN(eventMs) || eventMs >= installedAtMs;
    })
    .slice(-activeProbe.options.maxPerfEvents);
};

const readReport = (): GraphNodeProbeReport | null => {
  if (!activeProbe) return null;
  return {
    nodeId: activeProbe.nodeId,
    installedAt: activeProbe.installedAt,
    installedAtMs: activeProbe.installedAtMs,
    sampleCount: activeProbe.sampleCount,
    events: activeProbe.events.slice(),
    perfEvents: readPerfEvents(),
  };
};

const clearProbe = () => {
  if (!activeProbe) return;
  if (activeProbe.interval !== null) {
    window.clearInterval(activeProbe.interval);
  }
  activeProbe.observer?.disconnect();
  activeProbe.restoreConsole();
  activeProbe.removeListeners();
  activeProbe = null;
};

const installGraphNodeProbe = (nodeId: string, options?: Partial<GraphNodeProbeOptions>) => {
  clearProbe();
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  activeProbe = {
    nodeId,
    installedAt: new Date().toISOString(),
    installedAtMs: performance.now(),
    options: resolvedOptions,
    events: [],
    sampleCount: 0,
    observer: null,
    interval: null,
    restoreConsole: installConsoleCapture(),
    removeListeners: () => {},
  };
  const removeRuntimeListeners = installRuntimeErrorCapture();
  const removeDomListeners = installDomEventCapture(nodeId);
  activeProbe.removeListeners = () => {
    removeRuntimeListeners();
    removeDomListeners();
  };
  if (document.body) {
    activeProbe.observer = new MutationObserver(() => collectSample('mutation'));
    activeProbe.observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'data-state', 'data-id'],
    });
  }
  activeProbe.interval = window.setInterval(() => collectSample('interval'), resolvedOptions.intervalMs);
  collectSample('install');
  return readReport() as GraphNodeProbeReport;
};

export const installAgentreeDebugHelpers = () => {
  if (typeof window === 'undefined') return;
  window.__agentreeDebug = {
    ...(window.__agentreeDebug ?? {}),
    installGraphNodeProbe,
    readGraphNodeProbe: readReport,
    clearGraphNodeProbe: clearProbe,
  };
};

export {};
