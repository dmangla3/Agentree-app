import './localeGuard';
import './debug-init';
import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { KindeProvider } from "@kinde-oss/kinde-auth-react";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { initAnalytics } from './lib/analytics';
import { applyStoredAppFontSizePreference } from './lib/appFontSizePreference';
import { devLogLazy } from './lib/appLogger';
import { getKindeRedirectUri, initKindeDeepLinkHandler, restoreDesktopCloudSession, shouldUseDesktopBrowserAuth } from './lib/kindeDesktopAuth';
import { getElapsedSinceAppStartMs, recordPerfEvent } from './lib/perfRecorder';
import { registerAgentRunEffectsQueryClient } from './agent-runs/agentRunEffects';

const ReactQueryDevtools = lazy(() =>
  import('@tanstack/react-query-devtools').then((module) => ({
    default: module.ReactQueryDevtools,
  })),
);

const scheduleAnalyticsInit = () => {
  const initialize = () => {
    void initAnalytics();
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(initialize, { timeout: 3000 });
    return;
  }
  globalThis.setTimeout(initialize, 1500);
};

devLogLazy(() => [`[PERF][main.tsx] ${Date.now()} - All imports complete, creating QueryClient...`]);
applyStoredAppFontSizePreference();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes - keep unused data in cache longer
      retry: 1,
    },
  },
});
registerAgentRunEffectsQueryClient(queryClient);
if (import.meta.env.DEV) {
  (window as any).__AGENTREE_QUERY_CLIENT__ = queryClient;
}

devLogLazy(() => [`[PERF][main.tsx] ${Date.now()} - QueryClient created, calling createRoot...`]);
const root = createRoot(document.getElementById('root')!);
devLogLazy(() => [`[PERF][main.tsx] ${Date.now()} - Root created, preparing bootstrap...`]);

let hardCrashRecoveryScheduled = false;
const isLikelyAssetLoadFailure = (details: unknown) => {
  const message = details instanceof Error
    ? `${details.name}: ${details.message}`
    : String(details ?? '');
  return (
    message.includes('ChunkLoadError') ||
    message.includes('Loading chunk') ||
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
};

const scheduleHardCrashRecovery = (reason: string, details: unknown) => {
  if (hardCrashRecoveryScheduled) return;
  hardCrashRecoveryScheduled = true;
  console.error(`[RECOVERY] Scheduling hard reload due to ${reason}`, details);
  window.setTimeout(() => {
    window.location.reload();
  }, 900);
};

const handleGlobalRuntimeFailure = (reason: string, details: unknown) => {
  console.error(`[GLOBAL_ERROR] ${reason}`, details);
  if (!import.meta.env.DEV && isLikelyAssetLoadFailure(details)) {
    scheduleHardCrashRecovery(reason, details);
  }
};

window.addEventListener('error', (event) => {
  handleGlobalRuntimeFailure('window.error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  handleGlobalRuntimeFailure('unhandledrejection', event.reason);
});

const bootstrap = async () => {
  const bootstrapStartedAt = performance.now();
  recordPerfEvent('main.bootstrap.start', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
  }, { source: 'main.tsx' });

  const deepLinkStartedAt = performance.now();
  await initKindeDeepLinkHandler().catch((error) => {
    console.error('[Auth] Failed to initialize Kinde deep-link handler:', error);
    recordPerfEvent('main.bootstrap.deep-link.error', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      message: error instanceof Error ? error.message : String(error),
    }, { source: 'main.tsx' });
  });
  recordPerfEvent('main.bootstrap.deep-link.ready', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
  }, {
    source: 'main.tsx',
    durationMs: Number((performance.now() - deepLinkStartedAt).toFixed(2)),
  });

  await restoreDesktopCloudSession().catch((error) => {
    console.error('[Auth] Failed to restore desktop cloud session:', error);
  });

  const kindeRedirectUri = getKindeRedirectUri();
  const kindeLogoutUri = import.meta.env.VITE_KINDE_LOGOUT_URI || kindeRedirectUri;

  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <KindeProvider
            clientId={import.meta.env.VITE_KINDE_CLIENT_ID}
            domain={import.meta.env.VITE_KINDE_DOMAIN}
            forceChildrenRender={shouldUseDesktopBrowserAuth()}
            logoutUri={kindeLogoutUri}
            redirectUri={kindeRedirectUri}
          >
            <App />
          </KindeProvider>
          {import.meta.env.DEV && (
            <Suspense fallback={null}>
              <ReactQueryDevtools initialIsOpen={false} />
            </Suspense>
          )}
        </QueryClientProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
  scheduleAnalyticsInit();
  devLogLazy(() => [`[PERF][main.tsx] ${Date.now()} - render() called`]);
  recordPerfEvent('main.bootstrap.render-called', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
  }, {
    source: 'main.tsx',
    durationMs: Number((performance.now() - bootstrapStartedAt).toFixed(2)),
  });
};

void bootstrap();
