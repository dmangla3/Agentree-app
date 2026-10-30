import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { ArrowSquareOut, Check, Copy, PaintBrush, X } from '@phosphor-icons/react';
import { useAuthStore } from './stores/authStore';
import { ToastProvider } from './components/Toast';
import { DiffProvider } from './contexts/DiffContext';
import { MergeSelectionOverlay } from './components/SyncButton';
import { configureAuthSession } from './lib/authSession';
import { readDesktopUserFromSession, shouldUseDesktopBrowserAuth } from './lib/kindeDesktopAuth';
import { TooltipProvider } from '../@/components/ui/tooltip';
import { UpdateManager } from './components/updates/UpdateManager';
import { trackScreenViewed } from './lib/analytics';
import { devLogLazy } from './lib/appLogger';
import { getElapsedSinceAppStartMs, recordPerfEvent } from './lib/perfRecorder';
import { hasAppAccess } from './lib/appAccess';
import { usesMacOSOverlayTitleBar } from './hooks/useTauriWorkspace';
import {
  DESIGN_REVIEW_NAVIGATION_EVENT,
  createDesignReviewLocation,
  dispatchOpenDesignReviewSurface,
  type DesignReviewNavigationDetail,
  type DesignReviewSurfaceId,
  type DesignReviewVersion,
} from './lib/designReviewNavigation';

if (import.meta.env.DEV) {
  void import('./App.css');
}

const Agentation = lazy(() => import('agentation').then((module) => ({ default: module.Agentation })));
const HomePage = lazy(() => import('./pages/HomePage').then((module) => ({ default: module.HomePage })));
const LoginPage = lazy(() => import('./pages/auth/LoginPage').then((module) => ({ default: module.LoginPage })));
const MergePreviewDialog = lazy(() => import('./components/MergePreviewDialog').then((module) => ({ default: module.MergePreviewDialog })));
const MergeProgressDialog = lazy(() => import('./components/MergeProgressDialog').then((module) => ({ default: module.MergeProgressDialog })));

const DESIGN_REVIEW_STORAGE_KEY = 'agentree:design-review:v1';
const DESIGN_REVIEW_AREAS = [
  { id: 'auth', label: 'Login', detail: 'Authentication screen' },
  { id: 'onboarding', label: 'Onboarding', detail: 'Setup and first workspace' },
  { id: 'shell', label: 'Workspace', detail: 'Home and application frame' },
  { id: 'navigation', label: 'Navigation', detail: 'Header, rail, and workspace list' },
  { id: 'graph', label: 'Graph', detail: 'Canvas, controls, and overlays' },
  { id: 'chat', label: 'Chat', detail: 'Conversation and composer' },
  { id: 'nodes', label: 'Nodes', detail: 'Graph, chat, and list nodes' },
  { id: 'panels', label: 'Panels', detail: 'Search, settings, merge, and knowledge' },
  { id: 'controls', label: 'Controls', detail: 'Buttons, fields, menus, and dialogs' },
] as const satisfies ReadonlyArray<{ id: DesignReviewSurfaceId; label: string; detail: string }>;

type DesignReviewAreaId = (typeof DESIGN_REVIEW_AREAS)[number]['id'];
type DesignReviewState = Record<DesignReviewAreaId, { version: DesignReviewVersion; comment: string }>;

const createDefaultDesignReviewState = (): DesignReviewState => Object.fromEntries(
  DESIGN_REVIEW_AREAS.map(({ id }) => [id, { version: 'after', comment: '' }])
) as DesignReviewState;

function AppShellSkeleton({ label = 'Preparing workspace' }: { label?: string }) {
  const usesOverlayTitleBar = usesMacOSOverlayTitleBar();
  return (
    <div className="app-shell-background flex min-h-[100dvh] flex-col text-foreground" data-design-scope="shell">
      <div
        data-tauri-drag-region={usesOverlayTitleBar ? true : undefined}
        className={`app-toolbar flex h-12 shrink-0 items-center justify-between pr-4 ${usesOverlayTitleBar ? 'pl-[84px]' : 'pl-4'}`}
      >
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
        <div className="app-side-rail flex w-14 shrink-0 flex-col items-center gap-2 py-2">
          <div className="app-skeleton h-9 w-9" />
          <div className="app-skeleton h-9 w-9" />
          <div className="app-skeleton h-9 w-9" />
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
function ProtectedRoute({ children, hasAccess }: { children: React.JSX.Element; hasAccess: boolean }) {
  if (!hasAccess) {
    devLogLazy(() => ['[ROUTE][ProtectedRoute] Redirecting to /login because authentication is missing']);
    return <Navigate to="/login" replace />;
  }

  devLogLazy(() => ['[ROUTE][ProtectedRoute] Rendering authenticated route']);
  return children;
}

// Main application content component handling initialization and routing logic
function AppContent() {
  const renderStartTime = performance.now();
  devLogLazy(() => ['[PERF][App] AppContent render starting']);
  const { user: kindeUser, isAuthenticated, isLoading, getToken, logout } = useKindeAuth();
  devLogLazy(() => [`[PERF][App] useKindeAuth returned: isLoading=${isLoading}, isAuthenticated=${isAuthenticated} (${(performance.now() - renderStartTime).toFixed(1)}ms)`]);
  const {
    user: desktopUser,
    desktopSession,
    isDesktopSessionRestoring,
    setUser,
  } = useAuthStore();
  const authScreenTrackedRef = React.useRef(false);
  const location = useLocation();
  const navigate = useNavigate();
  devLogLazy(() => [`[ROUTE][AppContent] location=${location.pathname}`]);

  const [isSyncing, setIsSyncing] = React.useState(true);
  const appReadyLoggedRef = React.useRef(false);
  const devBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
  const useDesktopAuth = shouldUseDesktopBrowserAuth();
  const authLoading = useDesktopAuth ? isDesktopSessionRestoring : isLoading;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handleOpenDesignReviewSurface = (event: Event) => {
      const { surface, version } = (event as CustomEvent<DesignReviewNavigationDetail>).detail ?? {};
      if (!surface) return;

      if (version && typeof document !== 'undefined') {
        document.documentElement.setAttribute(`data-design-${surface}`, version);
      }

      navigate(createDesignReviewLocation(
        surface,
        location.pathname,
        location.search,
        String(Date.now()),
      ));
    };

    window.addEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, handleOpenDesignReviewSurface);
    return () => window.removeEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, handleOpenDesignReviewSurface);
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!useDesktopAuth && !authLoading && !isAuthenticated && !devBypass && !authScreenTrackedRef.current) {
      trackScreenViewed('login');
      authScreenTrackedRef.current = true;
    }
  }, [authLoading, devBypass, isAuthenticated, useDesktopAuth]);

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
          return;
        }

        if (useDesktopAuth && desktopSession) {
          const sessionUser = readDesktopUserFromSession(desktopSession);
          if (sessionUser && (
            desktopUser?.id !== sessionUser.id ||
            desktopUser?.email !== sessionUser.email ||
            desktopUser?.name !== sessionUser.name ||
            desktopUser?.pictureUrl !== sessionUser.pictureUrl
          )) {
            setUser(sessionUser);
          }
          return;
        }

        if (useDesktopAuth) {
          if (!desktopUser || !desktopSession) {
            setUser(null);
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
        } else if (!authLoading && !isAuthenticated) {
          setUser(null);
        }
      } catch (error) {
        console.error('[App] Failed to synchronize auth state:', error);
        setUser(null);
      } finally {
        devLogLazy(() => [`[PERF][App] syncAuth complete in ${(performance.now() - syncStartTime).toFixed(1)}ms, setting isSyncing=false`]);
        setIsSyncing(false);
      }
    };

    if (!authLoading) {
      devLogLazy(() => ['[PERF][App] isLoading=false, calling syncAuth']);
      syncAuth();
    } else {
      devLogLazy(() => ['[PERF][App] isLoading=true, waiting for Kinde...']);
    }
  }, [authLoading, desktopSession, desktopUser, devBypass, getToken, isAuthenticated, kindeUser, setUser, useDesktopAuth]);

  if (authLoading || isSyncing) {
    devLogLazy(() => [`[ROUTE][AppContent] Rendering initializing state isLoading=${authLoading} isSyncing=${isSyncing}`]);
    return <AppShellSkeleton label="Synchronizing session" />;
  }

  const isLoggedIn = hasAppAccess({
    devAuthBypass: devBypass,
    usesDesktopAuth: useDesktopAuth,
    hasDesktopUser: Boolean(desktopUser),
    hasDesktopSession: Boolean(desktopSession),
    isKindeAuthenticated: isAuthenticated,
  });

  if (!appReadyLoggedRef.current) {
    appReadyLoggedRef.current = true;
    recordPerfEvent('app.auth-ready', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      useDesktopAuth,
      isLoggedIn,
    }, { source: 'AppContent' });
  }

  devLogLazy(() => [`[ROUTE][AppContent] Ready desktop=${useDesktopAuth} isLoggedIn=${isLoggedIn}`]);

  return (
    <div className="app-shell-background h-[100dvh]" data-design-scope="shell">
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<Suspense fallback={<RouteLoading />}><LoginPage /></Suspense>} />

        {/* Protected Routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute hasAccess={isLoggedIn}>
              <Suspense fallback={<RouteLoading />}>
                <HomePage />
              </Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/workspaces/:workspaceId"
          element={
            <ProtectedRoute hasAccess={isLoggedIn}>
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

function DesignReviewPlayground() {
  const [isDesignReviewOpen, setIsDesignReviewOpen] = React.useState(false);
  const [isDesignReviewCopied, setIsDesignReviewCopied] = React.useState(false);
  const [activeDesignReviewArea, setActiveDesignReviewArea] = React.useState<DesignReviewAreaId | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const copiedTimerRef = React.useRef<number | null>(null);
  const [designReview, setDesignReview] = React.useState<DesignReviewState>(() => {
    const defaults = createDefaultDesignReviewState();
    if (typeof window === 'undefined') return defaults;

    try {
      const stored = window.localStorage.getItem(DESIGN_REVIEW_STORAGE_KEY);
      if (!stored) return defaults;
      const parsed = JSON.parse(stored) as Partial<DesignReviewState>;
      return Object.fromEntries(DESIGN_REVIEW_AREAS.map(({ id }) => {
        const saved = parsed[id];
        return [id, {
          version: saved?.version === 'before' ? 'before' : 'after',
          comment: typeof saved?.comment === 'string' ? saved.comment : '',
        }];
      })) as DesignReviewState;
    } catch {
      return defaults;
    }
  });

  React.useEffect(() => {
    if (typeof document === 'undefined') return;

    for (const { id } of DESIGN_REVIEW_AREAS) {
      document.documentElement.setAttribute(`data-design-${id}`, designReview[id].version);
    }
    try {
      window.localStorage.setItem(DESIGN_REVIEW_STORAGE_KEY, JSON.stringify(designReview));
    } catch (error) {
      console.warn('[DesignReview] Unable to persist review state:', error);
    }
  }, [designReview]);

  const closeDesignReview = React.useCallback(() => {
    setIsDesignReviewOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  React.useEffect(() => {
    if (!isDesignReviewOpen) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDesignReview();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeDesignReview, isDesignReviewOpen]);

  React.useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const selectDesignReviewVersion = (id: DesignReviewAreaId, version: DesignReviewVersion) => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute(`data-design-${id}`, version);
    }
    setDesignReview((current) => ({
      ...current,
      [id]: { ...current[id], version },
    }));
    openDesignReviewArea(id, version);
  };

  const updateDesignReviewComment = (id: DesignReviewAreaId, comment: string) => {
    setDesignReview((current) => ({
      ...current,
      [id]: { ...current[id], comment },
    }));
  };

  const copyDesignReview = async () => {
    const reviewText = DESIGN_REVIEW_AREAS.map(({ id, label }) => {
      const selection = designReview[id];
      return `${label}: ${selection.version}\n${selection.comment.trim() || 'No comment'}`;
    }).join('\n\n');

    try {
      const value = `Agentree UI review\n\n${reviewText}`;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(value);
      }
      setIsDesignReviewCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setIsDesignReviewCopied(false);
        copiedTimerRef.current = null;
      }, 1600);
    } catch (error) {
      console.error('[DesignReview] Failed to copy review:', error);
    }
  };

  const openDesignReviewArea = (id: DesignReviewAreaId, version?: DesignReviewVersion) => {
    setActiveDesignReviewArea(id);
    dispatchOpenDesignReviewSurface(id, version);
  };

  return (
    <div className="app-design-review" data-open={isDesignReviewOpen ? 'true' : 'false'}>
          {isDesignReviewOpen ? (
            <section className="app-design-review-panel" role="dialog" aria-label="UI design review">
              <header className="app-design-review-header">
                <div className="min-w-0">
                  <p className="app-design-review-kicker">Developer playground</p>
                  <h2>Review the redesign</h2>
                  <p>Open each surface, compare versions in context, and leave notes for the next pass.</p>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  className="app-design-review-icon-button"
                  onClick={closeDesignReview}
                  aria-label="Close design review"
                >
                  <X size={16} weight="bold" />
                </button>
              </header>

              <div className="app-design-review-list custom-scrollbar">
                {DESIGN_REVIEW_AREAS.map(({ id, label, detail }) => {
                  const selection = designReview[id];
                  return (
                    <div className="app-design-review-row" key={id}>
                      <div className="app-design-review-row-heading">
                        <div>
                          <h3>{label}</h3>
                          <p>{detail}</p>
                        </div>
                        <div className="app-design-review-row-actions">
                          <button
                            type="button"
                            className="app-design-review-open"
                            data-active={activeDesignReviewArea === id ? 'true' : 'false'}
                            onClick={() => openDesignReviewArea(id)}
                            aria-label={`${id === 'auth' || id === 'onboarding' ? 'Preview' : 'Open'} ${label}`}
                          >
                            <ArrowSquareOut size={14} weight="bold" />
                            {activeDesignReviewArea === id ? 'Viewing' : id === 'auth' || id === 'onboarding' ? 'Preview' : 'Open'}
                          </button>
                          <div className="app-design-review-segment" aria-label={`${label} version`}>
                            {(['before', 'after'] as const).map((version) => (
                              <button
                                type="button"
                                key={version}
                                data-active={selection.version === version ? 'true' : 'false'}
                                aria-pressed={selection.version === version}
                                onClick={() => selectDesignReviewVersion(id, version)}
                              >
                                {version === 'before' ? 'Before' : 'After'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <textarea
                        value={selection.comment}
                        onChange={(event) => updateDesignReviewComment(id, event.target.value)}
                        placeholder={`Comment on ${label.toLowerCase()}`}
                        rows={2}
                        aria-label={`${label} review comment`}
                      />
                    </div>
                  );
                })}
              </div>

              <footer className="app-design-review-footer">
                <p>Selections and comments stay on this device.</p>
                <button type="button" onClick={() => void copyDesignReview()}>
                  {isDesignReviewCopied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
                  {isDesignReviewCopied ? 'Copied' : 'Copy review'}
                </button>
              </footer>
            </section>
          ) : (
            <button
              ref={triggerRef}
              type="button"
              className="app-design-review-trigger"
              onClick={() => setIsDesignReviewOpen(true)}
              aria-label="Open design review"
            >
              <PaintBrush size={17} weight="duotone" />
              {activeDesignReviewArea
                ? `Review ${DESIGN_REVIEW_AREAS.find(({ id }) => id === activeDesignReviewArea)?.label ?? 'UI'}`
                : 'Review UI'}
            </button>
          )}
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
                {import.meta.env.DEV && <Agentation />}
              </Suspense>
            </DiffProvider>
          </UpdateManager>
        </ToastProvider>
      </BrowserRouter>
      {import.meta.env.DEV ? <DesignReviewPlayground /> : null}
    </TooltipProvider>
  );
}

export default App;
