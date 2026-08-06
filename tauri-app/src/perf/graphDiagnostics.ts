import { devInfo } from '../lib/appLogger';
import { getElapsedSinceAppStartMs, recordPerfEvent } from './perfRecorder';

export interface GraphDiagnosticCapture {
  id: string;
  label: string;
  capturedAt: string;
  elapsedSinceAppStartMs: number | null;
  summary: {
    nodeCount: number;
    edgeCount: number;
    renderedNodeCount: number;
    layoutOverlapCount: number;
    domOverlapCount: number;
    maxHeightDelta: number | null;
    staleMeasuredHeightCount: number;
  };
  payload: Record<string, unknown>;
}

type GraphDiagnosticProvider = (label?: string) => GraphDiagnosticCapture;

const GRAPH_DIAGNOSTIC_STORAGE_KEY = 'agentree.graph-diagnostics.v1';
const GRAPH_DIAGNOSTIC_EVENT = 'agentree:graph-diagnostic-capture';
const GRAPH_DIAGNOSTIC_LOG_PREFIX = '[GRAPH_DIAGNOSTIC]';
const GRAPH_DIAGNOSTIC_STORAGE_LIMIT = 20;

let activeProvider: GraphDiagnosticProvider | null = null;

declare global {
  interface Window {
    __AGENTREE_GRAPH_DEBUG__?: {
      capture: (label?: string) => GraphDiagnosticCapture | null;
      latest: () => GraphDiagnosticCapture | null;
      read: () => GraphDiagnosticCapture[];
      exportLatestJson: () => string;
      clear: () => void;
    };
  }
}

const readStoredCaptures = (): GraphDiagnosticCapture[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(GRAPH_DIAGNOSTIC_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeStoredCaptures = (captures: GraphDiagnosticCapture[]) => {
  if (typeof window === 'undefined') return;
  try {
    const compactCaptures = captures.slice(-GRAPH_DIAGNOSTIC_STORAGE_LIMIT).map((capture) => ({
      ...capture,
      payload: compactPayloadForStorage(capture.payload),
    }));
    window.localStorage.setItem(
      GRAPH_DIAGNOSTIC_STORAGE_KEY,
      JSON.stringify(compactCaptures)
    );
  } catch {
    // Diagnostic capture should never affect the graph itself.
  }
};

const compactPayloadForStorage = (payload: Record<string, unknown>) => {
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  return {
    omitted: true,
    reason: 'Full graph diagnostic payload is returned to callers but not persisted.',
    payloadKeys: Object.keys(payload),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    workspaceId: payload.workspaceId ?? null,
    activeScopeId: payload.activeScopeId ?? null,
    focusedMessageId: payload.focusedMessageId ?? null,
    viewMode: payload.viewMode ?? null,
    layoutMode: payload.layoutMode ?? null,
    laneStrategy: payload.laneStrategy ?? null,
    viewport: payload.viewport ?? null,
    counts: payload.counts ?? null,
    queryStatus: payload.queryStatus ?? null,
  };
};

const summarizeCaptureForLog = (capture: GraphDiagnosticCapture) => {
  const nodes = Array.isArray(capture.payload.nodes) ? capture.payload.nodes : [];
  const edges = Array.isArray(capture.payload.edges) ? capture.payload.edges : [];
  return {
    id: capture.id,
    label: capture.label,
    capturedAt: capture.capturedAt,
    elapsedSinceAppStartMs: capture.elapsedSinceAppStartMs,
    summary: capture.summary,
    payload: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      focusedMessageId: capture.payload.focusedMessageId ?? null,
      viewport: capture.payload.viewport ?? null,
      counts: capture.payload.counts ?? null,
      queryStatus: capture.payload.queryStatus ?? null,
    },
  };
};

const latestCapture = () => {
  const captures = readStoredCaptures();
  return captures[captures.length - 1] ?? null;
};

const saveCapture = (capture: GraphDiagnosticCapture) => {
  const captures = readStoredCaptures();
  captures.push(capture);
  writeStoredCaptures(captures);
  recordPerfEvent('graph.diagnostic.capture', {
    id: capture.id,
    label: capture.label,
    ...capture.summary,
  }, { source: 'graph-diagnostics' });
  devInfo(GRAPH_DIAGNOSTIC_LOG_PREFIX, summarizeCaptureForLog(capture));
  window.dispatchEvent(new CustomEvent(GRAPH_DIAGNOSTIC_EVENT, { detail: capture }));
};

export const createGraphDiagnosticCapture = (
  label: string | undefined,
  summary: GraphDiagnosticCapture['summary'],
  payload: Record<string, unknown>
): GraphDiagnosticCapture => ({
  id: `graph-diag-${Date.now()}`,
  label: label?.trim() || 'graph-layout-capture',
  capturedAt: new Date().toISOString(),
  elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
  summary,
  payload,
});

export const registerGraphDiagnosticProvider = (provider: GraphDiagnosticProvider) => {
  activeProvider = provider;
  installGraphDiagnosticConsoleApi();
  return () => {
    if (activeProvider === provider) {
      activeProvider = null;
    }
  };
};

export const captureGraphDiagnostics = (label?: string): GraphDiagnosticCapture | null => {
  installGraphDiagnosticConsoleApi();
  if (!activeProvider) {
    recordPerfEvent('graph.diagnostic.capture-missing-provider', {
      label: label ?? null,
    }, { source: 'graph-diagnostics' });
    return null;
  }

  const capture = activeProvider(label);
  saveCapture(capture);
  return capture;
};

export const readGraphDiagnosticCaptures = () => readStoredCaptures();
export const readLatestGraphDiagnosticCapture = () => latestCapture();
export const clearGraphDiagnosticCaptures = () => writeStoredCaptures([]);

export const subscribeGraphDiagnosticCaptures = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(GRAPH_DIAGNOSTIC_EVENT, handler);
  return () => window.removeEventListener(GRAPH_DIAGNOSTIC_EVENT, handler);
};

export const installGraphDiagnosticConsoleApi = () => {
  if (typeof window === 'undefined') return;
  window.__AGENTREE_GRAPH_DEBUG__ = {
    ...(window.__AGENTREE_GRAPH_DEBUG__ ?? {}),
    capture: (label?: string) => captureGraphDiagnostics(label),
    latest: () => latestCapture(),
    read: () => readStoredCaptures(),
    exportLatestJson: () => JSON.stringify(latestCapture(), null, 2),
    clear: () => writeStoredCaptures([]),
  };
};
