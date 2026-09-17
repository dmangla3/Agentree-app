import { devLogLazy, installFrontendLogPersistence } from "@/lib/appLogger";
import { installDevPerformanceObservers, recordPerfEvent } from "@/lib/perfRecorder";
import { installAgentreeDebugHelpers } from "./debug/graphNodeProbe";

// This file is imported first to trace module loading
const initTime = Date.now();
installFrontendLogPersistence();
installDevPerformanceObservers();
if (import.meta.env.DEV) {
  installAgentreeDebugHelpers();
}
devLogLazy(() => [`[debug-init] ${initTime} - Module loading started`]);
recordPerfEvent('app.module-load-start', { initTime }, { source: 'debug-init' });

// Track when we're done loading
window.addEventListener('DOMContentLoaded', () => {
  devLogLazy(() => [`[debug-init] ${Date.now()} - DOMContentLoaded (${Date.now() - initTime}ms after init)`]);
  recordPerfEvent('app.dom-content-loaded', {
    elapsedMs: Date.now() - initTime,
  }, { source: 'debug-init' });
});

window.addEventListener('load', () => {
  devLogLazy(() => [`[debug-init] ${Date.now()} - Window load (${Date.now() - initTime}ms after init)`]);
  recordPerfEvent('app.window-load', {
    elapsedMs: Date.now() - initTime,
  }, { source: 'debug-init' });
});

export {};
