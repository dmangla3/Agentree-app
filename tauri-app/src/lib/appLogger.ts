import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment } from "../hooks/useTauriWorkspace";

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
type FrontendLogThreshold = "debug" | "info" | "warn" | "error";

type LogPaths = {
  log_dir: string;
  frontend_log: string;
  backend_log: string;
};

declare global {
  interface Window {
    __AGENTREE_LOG_PATHS__?: LogPaths;
  }
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let installed = false;
let tauriAvailable = false;
let flushTimer: number | null = null;
let flushInFlight = false;
const pendingLines: string[] = [];
const MAX_PERSISTED_LOG_LINE_CHARS = 12_000;

const levelPriority: Record<ConsoleLevel, number> = {
  debug: 10,
  log: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const thresholdPriority: Record<FrontendLogThreshold, number> = {
  debug: 10,
  info: 30,
  warn: 40,
  error: 50,
};

const normalizeThreshold = (value: string | undefined): FrontendLogThreshold | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return null;
};

const minLogPriority = thresholdPriority[
  normalizeThreshold(import.meta.env.VITE_FRONTEND_LOG_LEVEL)
  ?? normalizeThreshold(import.meta.env.VITE_LOG_LEVEL)
  ?? (import.meta.env.DEV ? "debug" : "warn")
];

const isLevelEnabled = (level: ConsoleLevel) => levelPriority[level] >= minLogPriority;

const callOriginalConsole = (level: ConsoleLevel, args: unknown[]) => {
  if (!isLevelEnabled(level)) return;
  originalConsole[level](...args);
};

const serializeArg = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatLine = (level: ConsoleLevel, args: unknown[]) =>
  truncateLogLine(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.map(serializeArg).join(" ")}`);

const truncateLogLine = (line: string) => {
  if (line.length <= MAX_PERSISTED_LOG_LINE_CHARS) return line;
  return `${line.slice(0, MAX_PERSISTED_LOG_LINE_CHARS)} [truncated ${line.length - MAX_PERSISTED_LOG_LINE_CHARS} chars]`;
};

const scheduleFlush = (delayMs: number) => {
  if (!tauriAvailable) return;
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushLogs();
  }, delayMs);
};

const flushLogs = async () => {
  if (!tauriAvailable || flushInFlight || pendingLines.length === 0) return;
  flushInFlight = true;
  const lines = pendingLines.splice(0, pendingLines.length);
  try {
    await invoke("append_frontend_logs", { lines });
  } catch (error) {
    pendingLines.unshift(...lines);
    tauriAvailable = false;
    callOriginalConsole("error", ["[appLogger] Failed to persist frontend logs:", error]);
  } finally {
    flushInFlight = false;
    if (tauriAvailable && pendingLines.length > 0) {
      scheduleFlush(50);
    }
  }
};

export const flushFrontendLogs = async () => {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushLogs();
};

const enqueueLog = (level: ConsoleLevel, args: unknown[]) => {
  if (!isLevelEnabled(level)) return;
  if (!tauriAvailable) return;
  pendingLines.push(formatLine(level, args));
  if (level === "error" || level === "warn" || pendingLines.length >= 20) {
    void flushLogs();
    return;
  }
  scheduleFlush(50);
};

const wrapConsole = (level: ConsoleLevel) => {
  const target = console as unknown as Record<ConsoleLevel, (...args: unknown[]) => void>;
  target[level] = (...args: unknown[]) => {
    enqueueLog(level, args);
    callOriginalConsole(level, args);
  };
};

const installErrorMirrors = () => {
  window.addEventListener("error", (event) => {
    enqueueLog("error", [
      "[window.error]",
      event.message,
      event.filename,
      `line=${event.lineno}`,
      `col=${event.colno}`,
      event.error ?? "no-error-object",
    ]);
    void flushLogs();
  });

  window.addEventListener("unhandledrejection", (event) => {
    enqueueLog("error", ["[window.unhandledrejection]", event.reason ?? "unknown"]);
    void flushLogs();
  });

  window.addEventListener("beforeunload", () => {
    void flushLogs();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushLogs();
    }
  });
};

const loadLogPaths = async () => {
  if (!tauriAvailable) return;
  try {
    const paths = await invoke<LogPaths>("get_log_paths");
    window.__AGENTREE_LOG_PATHS__ = paths;
    enqueueLog("info", ["[appLogger] Persistent logs", paths]);
    void flushLogs();
    callOriginalConsole("info", ["[appLogger] Persistent logs:", paths]);
  } catch (error) {
    callOriginalConsole("error", ["[appLogger] Failed to read log paths:", error]);
  }
};

export const installFrontendLogPersistence = () => {
  if (installed || typeof window === "undefined") return;
  installed = true;
  tauriAvailable = isTauriEnvironment();

  wrapConsole("log");
  wrapConsole("info");
  wrapConsole("warn");
  wrapConsole("error");
  wrapConsole("debug");
  installErrorMirrors();

  enqueueLog("info", ["[appLogger] Frontend log persistence installed"]);
  void flushLogs();
  void loadLogPaths();
};

const emitDevConsole = (level: "log" | "info" | "debug", args: unknown[]) => {
  if (!isLevelEnabled(level)) return;
  console[level](...args);
};

export const devLog = (...args: unknown[]) => emitDevConsole("log", args);
export const devInfo = (...args: unknown[]) => emitDevConsole("info", args);
export const devDebug = (...args: unknown[]) => emitDevConsole("debug", args);
export const devLogLazy = (factory: () => unknown[]) => {
  if (!isLevelEnabled("log")) return;
  console.log(...factory());
};
export const devInfoLazy = (factory: () => unknown[]) => {
  if (!isLevelEnabled("info")) return;
  console.info(...factory());
};
export const devDebugLazy = (factory: () => unknown[]) => {
  if (!isLevelEnabled("debug")) return;
  console.debug(...factory());
};
