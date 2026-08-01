import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { useAuthStore } from './stores/authStore';
import { ToastProvider } from './components/Toast';
import { DiffProvider } from './contexts/DiffContext';
import { MergeSelectionOverlay } from './components/SyncButton';
import { configureAuthSession } from './lib/authSession';
import { isDesktopBrowserAuthenticated, shouldUseDesktopBrowserAuth } from './lib/kindeDesktopAuth';
import { TooltipProvider } from '../@/components/ui/tooltip';
import { UpdateManager } from './components/updates/UpdateManager';
import { identifyUser, trackScreenViewed } from './lib/analytics';
import { devLogLazy } from './lib/appLogger';
import { getElapsedSinceAppStartMs, recordPerfEvent } from './lib/perfRecorder';
import './App.css';

const Agentation = lazy(() => import('agentation').then((module) => ({ default: module.Agentation })));
const HomePage = lazy(() => import('./pages/HomePage').then((module) => ({ default: module.HomePage })));
const LoginPage = lazy(() => import('./pages/auth/LoginPage').then((module) => ({ default: module.LoginPage })));
const MergePreviewDialog = lazy(() => import('./components/MergePreviewDialog').then((module) => ({ default: module.MergePreviewDialog })));
const MergeProgressDialog = lazy(() => import('./components/MergeProgressDialog').then((module) => ({ default: module.MergeProgressDialog })));
const PerfCapturePanel = lazy(() => import('./components/PerfCapturePanel').then((module) => ({ default: module.PerfCapturePanel })));

function AppShellSkeleton({ label = 'Preparing workspace' }: { label?: string }) {
  return (
    <div className="app-shell-background flex min-h-screen flex-col text-foreground">
      <div className="app-toolbar flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <div className="app-skeleton h-7 w-28" />
          <div className="h-5 w-px bg-border/60" />
          <div className="app-skeleton h-8 w-48" />
        </div>
        <div className="flex items-center gap-2">
          <div className="app-skeleton h-8 w-28" />
          <div className="app-skeleton h-8 w-8" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="app-side-rail flex w-16 shrink-0 flex-col items-center gap-2 py-4">
          <div className="app-skeleton h-10 w-11" />
          <div className="app-skeleton h-10 w-11" />
          <div className="app-skeleton h-10 w-11" />
          <div className="mt-auto app-skeleton h-9 w-9 rounded-lg" />
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(16rem,0.36fr)_1fr] gap-px bg-border/50">
          <div className="flex min-w-0 flex-col bg-background/80 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="app-skeleton h-5 w-28" />
              <div className="app-skeleton h-7 w-20" />
            </div>
            <div className="flex-1 rounded-xl border border-border/60 bg-card/65 p-4">
              <div className="app-skeleton h-8 w-40" />
              <div className="mt-8 space-y-4">
                <div className="app-skeleton h-16 w-56" />
                <div className="app-skeleton ml-16 h-16 w-60" />
                <div className="app-skeleton ml-8 h-16 w-52" />
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-col bg-background/90">
            <div className="flex h-11 items-center border-b border-border/60 px-4">
              <div className="app-skeleton h-7 w-40" />
            </div>
            <div className="flex-1 space-y-4 p-6">
              <div className="app-skeleton h-20 w-full max-w-xl" />
              <div className="app-skeleton ml-auto h-28 w-full max-w-2xl" />
              <div className="app-skeleton h-24 w-full max-w-xl" />
            </div>
            <div className="border-t border-border/60 p-4">
              <div className="app-skeleton h-14 w-full" />
            </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg border border-border/70 bg-background/90 px-3 py-2 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur">
        {label}
      </div>
    </div>
  );
}

function RouteLoading() {
  return <AppShellSkeleton label="Loading view" />;
}

// Component to protect routes requiring authentication
function ProtectedRoute({ children }: { children: React.JSX.Element }) {
  const { isAuthenticated, isLoading } = useKindeAuth();
  const desktopUser = useAuthStore((state) => state.user);
  const desktopSession = useAuthStore((state) => state.desktopSession);
  const devBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
  const useDesktopAuth = shouldUseDesktopBrowserAuth();
  const isDesktopAuthenticated = useDesktopAuth && !!desktopUser && !!desktopSession;
  devLogLazy(() => [
    `[ROUTE][ProtectedRoute] desktop=${useDesktopAuth} devBypass=${devBypass} isLoading=${isLoading} kindeAuth=${isAuthenticated} desktopUser=${!!desktopUser} desktopSession=${!!desktopSession}`
  ]);

  if (isLoading) {
    devLogLazy(() => ['[ROUTE][ProtectedRoute] Rendering loading state']);
    return <AppShellSkeleton label="Checking session" />;
  }

  if (useDesktopAuth) {
    if (!devBypass && !isDesktopAuthenticated) {
      devLogLazy(() => ['[ROUTE][ProtectedRoute] Redirecting to /login because desktop auth is missing']);
      return <Navigate to="/login" replace />;
    }

    devLogLazy(() => ['[ROUTE][ProtectedRoute] Rendering protected desktop route']);
    return children;
  }

  if (!devBypass && !isAuthenticated) {
    devLogLazy(() => ['[ROUTE][ProtectedRoute] Redirecting to /login because web auth is missing']);
    return <Navigate to="/login" replace />;
  }

  devLogLazy(() => ['[ROUTE][ProtectedRoute] Rendering protected web route']);
  return children;
}

// Main application content component handling initialization and routing logic
function AppContent() {
  const renderStartTime = performance.now();
  devLogLazy(() => ['[PERF][App] AppContent render starting']);
  const { user: kindeUser, isAuthenticated, isLoading, getToken, logout } = useKindeAuth();
  devLogLazy(() => [`[PERF][App] useKindeAuth returned: isLoading=${isLoading}, isAuthenticated=${isAuthenticated} (${(performance.now() - renderStartTime).toFixed(1)}ms)`]);
  const { user: desktopUser, desktopSession, setUser } = useAuthStore();
  const authScreenTrackedRef = React.useRef(false);
  const location = useLocation();
  devLogLazy(() => [`[ROUTE][AppContent] location=${location.pathname}`]);

  const [isSyncing, setIsSyncing] = React.useState(true);
  const appReadyLoggedRef = React.useRef(false);
  const devBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
  const useDesktopAuth = shouldUseDesktopBrowserAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !devBypass && !authScreenTrackedRef.current) {
      trackScreenViewed('login');
      authScreenTrackedRef.current = true;
    }
  }, [devBypass, isAuthenticated, isLoading]);

  useEffect(() => {
    configureAuthSession({ getToken, logout });
    return () => {
      configureAuthSession({});
    };
  }, [getToken, logout]);

  useEffect(() => {
    const syncAuth = async () => {
      const syncStartTime = performance.now();
      devLogLazy(() => ['[PERF][App] syncAuth starting']);
      try {
        if (devBypass) {
          const devUserId = import.meta.env.VITE_DEV_AUTH_USER_ID || '11111111-1111-1111-1111-111111111111';
          const devEmail = import.meta.env.VITE_DEV_AUTH_EMAIL || 'dev@agentree.local';
          const devName = import.meta.env.VITE_DEV_AUTH_NAME || 'Dev User';
          if (
            desktopUser?.id !== devUserId ||
            desktopUser?.email !== devEmail ||
            desktopUser?.name !== devName
          ) {
            setUser({
              id: devUserId,
              email: devEmail,
              name: devName,
              pictureUrl: undefined
            });
          }
          identifyUser({ id: devUserId, email: devEmail });
          return;
        }

        if (useDesktopAuth) {
          if (desktopUser && desktopSession) {
            identifyUser({ id: desktopUser.id, email: desktopUser.email || null });
          } else {
            setUser(null);
            identifyUser(null);
          }
          return;
        }

        if (isAuthenticated && kindeUser) {
          await getToken();
          setUser({
            id: kindeUser.id || '',
            email: kindeUser.email || '',
            name: kindeUser.givenName || kindeUser.email || '',
            pictureUrl: kindeUser.picture || undefined
          });
          identifyUser({ id: kindeUser.id || '', email: kindeUser.email || null });
        } else if (!isLoading && !isAuthenticated) {
          setUser(null);
          identifyUser(null);
        }
      } catch (error) {
        console.error('[App] Failed to synchronize auth state:', error);
        setUser(null);
        identifyUser(null);
      } finally {
        devLogLazy(() => [`[PERF][App] syncAuth complete in ${(performance.now() - syncStartTime).toFixed(1)}ms, setting isSyncing=false`]);
        setIsSyncing(false);
      }
    };

    if (!isLoading) {
      devLogLazy(() => ['[PERF][App] isLoading=false, calling syncAuth']);
      syncAuth();
    } else {
      devLogLazy(() => ['[PERF][App] isLoading=true, waiting for Kinde...']);
    }
  }, [desktopSession, desktopUser, devBypass, getToken, isAuthenticated, isLoading, kindeUser, setUser, useDesktopAuth]);

  if (isLoading || isSyncing) {
    devLogLazy(() => [`[ROUTE][AppContent] Rendering initializing state isLoading=${isLoading} isSyncing=${isSyncing}`]);
    return <AppShellSkeleton label="Synchronizing session" />;
  }

  if (!appReadyLoggedRef.current) {
    appReadyLoggedRef.current = true;
    recordPerfEvent('app.auth-ready', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      useDesktopAuth,
      isLoggedIn: devBypass || (useDesktopAuth ? isDesktopBrowserAuthenticated() : isAuthenticated),
    }, { source: 'AppContent' });
  }

  const isLoggedIn = devBypass || (useDesktopAuth ? isDesktopBrowserAuthenticated() : isAuthenticated);
  devLogLazy(() => [`[ROUTE][AppContent] Ready desktop=${useDesktopAuth} isLoggedIn=${isLoggedIn}`]);

  return (
    <div className="app-shell-background h-screen">
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<Suspense fallback={<RouteLoading />}><LoginPage /></Suspense>} />

        {/* Protected Routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Suspense fallback={<RouteLoading />}>
                <HomePage />
              </Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/workspaces/:workspaceId"
          element={
            <ProtectedRoute>
              <Suspense fallback={<RouteLoading />}>
                <HomePage />
              </Suspense>
            </ProtectedRoute>
          }
        />

        {/* Fallback for unknown routes */}
        <Route path="*" element={<Navigate to={isLoggedIn ? "/" : "/login"} replace />} />
      </Routes>
    </div>
  );
}

// Root App component sets up the Router
function App() {
  // Stop the loading timer from index.html
  React.useEffect(() => {
    devLogLazy(() => [`[PERF][App] App component mounted at ${Date.now()}, stopping loading timer`]);
    recordPerfEvent('app.react-mounted', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
    }, { source: 'App' });
    if (typeof window !== 'undefined' && (window as any).__STOP_LOADING_TIMER__) {
      (window as any).__STOP_LOADING_TIMER__();
    }
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <BrowserRouter>
        <ToastProvider>
          <UpdateManager>
            <DiffProvider>
              <AppContent />
              {/* Merge UI Components */}
              <MergeSelectionOverlay />
              <Suspense fallback={null}>
                <MergePreviewDialog />
                <MergeProgressDialog />
                {import.meta.env.DEV && <PerfCapturePanel />}
                {import.meta.env.DEV && <Agentation />}
              </Suspense>
            </DiffProvider>
          </UpdateManager>
        </ToastProvider>
      </BrowserRouter>
    </TooltipProvider>
  );
}

export default App;
