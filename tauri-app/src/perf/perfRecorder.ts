import { devInfo } from '../lib/appLogger';
import { exportPerfCaptureBundle } from './captureExport';
import type { PerfEvent, PerfExportStatus, PerfSession } from './types';

const PERF_STORAGE_KEY = 'agentree.perf.events.v1';
const PERF_SESSION_STORAGE_KEY = 'agentree.perf.active-session.v1';
const PERF_EXPORT_STATUS_KEY = 'agentree.perf.export-status.v1';
const PERF_STORAGE_LIMIT = 1200;
const PERF_LOG_PREFIX = '[PERF_TRACE]';
const PERF_SESSION_EVENT = 'agentree:perf-session-change';
const PERF_EXPORT_EVENT = 'agentree:perf-export-change';
const PERF_STORAGE_WRITE_DELAY_MS = 500;

let storedEventsCache: PerfEvent[] | null = null;
let storedEventsWriteTimer: number | null = null;

declare global {
  interface Window {
    __APP_START_TIME__?: number;
    __AGENTREE_PERF__?: {
      read: () => PerfEvent[];
      clear: () => void;
      exportJson: () => string;
      startCapture: (label?: string) => PerfSession;
      stopCapture: () => Promise<void>;
      getActiveSession: () => PerfSession | null;
      readLatestSession: () => PerfEvent[];
      getExportStatus: () => PerfExportStatus;
    };
  }
}

const isEnabled = () => import.meta.env.DEV || import.meta.env.VITE_ENABLE_PERF_TRACE === 'true';

const defaultExportStatus = (): PerfExportStatus => ({
  state: 'idle',
  sessionId: null,
  exportPath: null,
  error: null,
  exportedAt: null,
});

const readEventsFromStorage = (): PerfEvent[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PERF_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const persistEventsToStorage = (events: PerfEvent[]) => {
  if (typeof window === 'undefined') return;
  const limits = [PERF_STORAGE_LIMIT, 900, 600, 300, 100, 0];
  for (const limit of limits) {
    try {
      window.localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(limit > 0 ? events.slice(-limit) : []));
      return;
    } catch {
      // Try smaller windows below.
    }
  }
};

const readStoredEvents = (): PerfEvent[] => {
  if (storedEventsCache) return storedEventsCache;
  storedEventsCache = readEventsFromStorage();
  return storedEventsCache;
};

const flushStoredEvents = () => {
  if (typeof window === 'undefined') return;
  if (storedEventsWriteTimer !== null) {
    window.clearTimeout(storedEventsWriteTimer);
    storedEventsWriteTimer = null;
  }
  persistEventsToStorage(storedEventsCache ?? []);
};

const scheduleStoredEventsWrite = () => {
  if (typeof window === 'undefined' || storedEventsWriteTimer !== null) return;
  storedEventsWriteTimer = window.setTimeout(() => {
    storedEventsWriteTimer = null;
    persistEventsToStorage(storedEventsCache ?? []);
  }, PERF_STORAGE_WRITE_DELAY_MS);
};

const writeStoredEvents = (events: PerfEvent[], options?: { defer?: boolean }) => {
  storedEventsCache = events.slice(-PERF_STORAGE_LIMIT);
  if (options?.defer) {
    scheduleStoredEventsWrite();
    return;
  }
  flushStoredEvents();
};

const readActiveSession = (): PerfSession | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PERF_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return parsed as PerfSession;
  } catch {
    return null;
  }
};

const writeActiveSession = (session: PerfSession | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (!session) {
      window.localStorage.removeItem(PERF_SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(PERF_SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage failures in perf tooling.
  }
};

const readExportStatus = (): PerfExportStatus => {
  if (typeof window === 'undefined') return defaultExportStatus();
  try {
    const raw = window.localStorage.getItem(PERF_EXPORT_STATUS_KEY);
    if (!raw) return defaultExportStatus();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.state !== 'string') {
      return defaultExportStatus();
    }
    return parsed as PerfExportStatus;
  } catch {
    return defaultExportStatus();
  }
};

const writeExportStatus = (status: PerfExportStatus) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PERF_EXPORT_STATUS_KEY, JSON.stringify(status));
  } catch {
    // Ignore export status persistence failures.
  }
};

const emitSessionChange = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PERF_SESSION_EVENT));
};

const emitExportChange = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PERF_EXPORT_EVENT));
};

const setExportStatus = (status: PerfExportStatus) => {
  writeExportStatus(status);
  emitExportChange();
};

const sanitizeDetails = (details?: Record<string, unknown>) => {
  if (!details) return undefined;
  try {
    return JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
  } catch {
    return { note: 'details_not_serializable' };
  }
};

const shouldLogPerfEvent = (name: string, hasActiveSession: boolean) => {
  if (!hasActiveSession) return true;
  return (
    name.startsWith('perf.') ||
    name.startsWith('send-flow.') ||
    name.startsWith('run-status.') ||
    name.startsWith('query.message-deltas.') ||
    name.startsWith('chat.focus-scroll.') ||
    name === 'browser.long-task'
  );
};

export const getAppStartTimeMs = (): number | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.__APP_START_TIME__;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

export const getElapsedSinceAppStartMs = (): number | null => {
  const appStartTime = getAppStartTimeMs();
  if (appStartTime === null) return null;
  return Number((Date.now() - appStartTime).toFixed(2));
};

export const recordPerfEvent = (
  name: string,
  details?: Record<string, unknown>,
  options?: { source?: string; durationMs?: number }
) => {
  if (!isEnabled()) return;

  const activeSession = readActiveSession();
  const event: PerfEvent = {
    ts: new Date().toISOString(),
    name,
    source: options?.source,
    durationMs: options?.durationMs,
    sessionId: activeSession?.id ?? null,
    sessionLabel: activeSession?.label ?? null,
    details: sanitizeDetails(details),
  };

  const current = readStoredEvents();
  current.push(event);
  writeStoredEvents(current, { defer: true });
  if (shouldLogPerfEvent(name, Boolean(activeSession))) {
    devInfo(PERF_LOG_PREFIX, event);
  }
};

export const startPerfCapture = (label = 'send-message-capture'): PerfSession => {
  const session: PerfSession = {
    id: `perf-${Date.now()}`,
    label,
    startedAt: new Date().toISOString(),
  };
  writeActiveSession(session);
  setExportStatus({
    state: 'idle',
    sessionId: session.id,
    exportPath: null,
    error: null,
    exportedAt: null,
  });
  emitSessionChange();
  recordPerfEvent('perf.capture.start', {
    startedAt: session.startedAt,
  }, { source: 'perf-recorder' });
  return session;
};

export const stopPerfCapture = async () => {
  const activeSession = readActiveSession();
  if (!activeSession) return;
  const stoppedAt = new Date().toISOString();
  recordPerfEvent('perf.capture.stop', {
    startedAt: activeSession.startedAt,
    stoppedAt,
  }, { source: 'perf-recorder' });
  flushStoredEvents();
  const sessionEvents = readStoredEvents().filter((event) => event.sessionId === activeSession.id);
  writeActiveSession(null);
  emitSessionChange();
  setExportStatus({
    state: 'exporting',
    sessionId: activeSession.id,
    exportPath: null,
    error: null,
    exportedAt: null,
  });
  try {
    const result = await exportPerfCaptureBundle(activeSession, sessionEvents, stoppedAt);
    setExportStatus({
      state: 'succeeded',
      sessionId: activeSession.id,
      exportPath: result.exportDir,
      error: null,
      exportedAt: new Date().toISOString(),
    });
  } catch (error) {
    setExportStatus({
      state: 'failed',
      sessionId: activeSession.id,
      exportPath: null,
      error: error instanceof Error ? error.message : String(error),
      exportedAt: new Date().toISOString(),
    });
  }
};

export const subscribePerfSession = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(PERF_SESSION_EVENT, handler);
  return () => window.removeEventListener(PERF_SESSION_EVENT, handler);
};

export const subscribePerfExport = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(PERF_EXPORT_EVENT, handler);
  return () => window.removeEventListener(PERF_EXPORT_EVENT, handler);
};

export const getActivePerfSession = () => readActiveSession();
export const getPerfExportStatus = () => readExportStatus();

export const readLatestPerfSessionEvents = (): PerfEvent[] => {
  const events = readStoredEvents();
  const latestSessionId = [...events].reverse().find((event) => event.sessionId)?.sessionId ?? null;
  if (!latestSessionId) return [];
  return events.filter((event) => event.sessionId === latestSessionId);
};

export const timePerfSync = <T,>(
  name: string,
  fn: () => T,
  details?: Record<string, unknown>,
  options?: { source?: string }
): T => {
  if (!isEnabled()) return fn();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    recordPerfEvent(name, details, {
      source: options?.source,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
  }
};

export const installDevPerformanceObservers = () => {
  if (!isEnabled() || typeof window === 'undefined') return;
  if (window.__AGENTREE_PERF__) return;

  window.__AGENTREE_PERF__ = {
    read: () => readStoredEvents(),
    clear: () => writeStoredEvents([]),
    exportJson: () => JSON.stringify(readStoredEvents(), null, 2),
    startCapture: (label?: string) => startPerfCapture(label),
    stopCapture: () => stopPerfCapture(),
    getActiveSession: () => getActivePerfSession(),
    readLatestSession: () => readLatestPerfSessionEvents(),
    getExportStatus: () => getPerfExportStatus(),
  };

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          recordPerfEvent('browser.long-task', {
            entryType: entry.entryType,
            startTime: Number(entry.startTime.toFixed(2)),
          }, {
            source: 'browser',
            durationMs: Number(entry.duration.toFixed(2)),
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] as string[] });
    } catch {
      // Long task observer is optional.
    }
  }

  recordPerfEvent('perf.observers-installed', {
    storageKey: PERF_STORAGE_KEY,
    storageLimit: PERF_STORAGE_LIMIT,
  }, { source: 'perf-recorder' });
};
