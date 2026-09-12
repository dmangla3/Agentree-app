import { lazy, Suspense, useCallback, useEffect, useState, useMemo, useRef } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { useAuthStore } from '../stores/authStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AgentRunLiveStreamCoordinator } from '../agent-runs/AgentRunLiveStreamCoordinatorMount';
import { ChatInput } from '../components/ChatInput';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../@/components/ui/resizable";
import { Sidebar } from '../components/Sidebar';
import { WorkspaceNavigator, type WorkspaceThreadNavigationModel } from '../components/navigation/WorkspaceNavigator';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { AppHeader } from '../components/AppHeader';
import { useOnboardingStore } from '../stores/onboardingStore';
import { trackScreenViewed } from '../lib/analytics';
import { devLogLazy } from '../lib/appLogger';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { DEFAULT_GRAPH_CHAT_SPLIT, getGraphChatRestoreSplit, readRememberedGraphChatSplit, rememberGraphChatSplit } from '../lib/graphChatSplitLayout';
import { resolveWorkspaceRouteState } from '../lib/workspaceRouteState';
import { LOGIN_PROFILES_NAVIGATION_EVENT, type LoginProfilesNavigationDetail } from '../lib/loginNavigationEvents';
import { useAppFontSizeHotkeys } from '../hotkeys/appFontSizeHotkeys';
import { useOpenSearchHotkey } from '../hotkeys/searchHotkeys';
import { useCreateThreadHotkey } from '../hotkeys/threadHotkeys';
import { agentClient } from '../lib/agentClient';
import { PanelRightClose, PanelRightOpen, X } from 'lucide-react';

const AdvancedSearchPanel = lazy(() => import('../components/AdvancedSearchPanel').then((module) => ({ default: module.AdvancedSearchPanel })));
const ChatInterface = lazy(() => import('../components/ChatInterface').then((module) => ({ default: module.ChatInterface })));
const FirstRunExperience = lazy(() => import('../components/onboarding/FirstRunExperience').then((module) => ({ default: module.FirstRunExperience })));
const GraphComposerDock = lazy(() => import('../components/GraphComposerDock').then((module) => ({ default: module.GraphComposerDock })));
const GraphView = lazy(() => import('../components/GraphView').then((module) => ({ default: module.GraphView })));
const KnowledgeBase = lazy(() => import('../components/KnowledgeBase/KnowledgeBase').then((module) => ({ default: module.KnowledgeBase })));
const LoginProfilesPanel = lazy(() => import('../components/logins/LoginProfilesPanel').then((module) => ({ default: module.LoginProfilesPanel })));
const OrchestrationPanel = lazy(() => import('../components/orchestration/OrchestrationPanel').then((module) => ({ default: module.OrchestrationPanel })));
const SkillsPanel = lazy(() => import('../components/SkillsPanel').then((module) => ({ default: module.SkillsPanel })));
const TrackingDashboard = lazy(() => import('../components/TrackingDashboard').then((module) => ({ default: module.TrackingDashboard })));

function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-background/80 p-6">
      <div className="w-full max-w-md space-y-3">
        <div className="app-skeleton h-8 w-40" />
        <div className="app-skeleton h-24 w-full" />
        <div className="app-skeleton h-24 w-5/6" />
      </div>
    </div>
  );
}

export function HomePage() {
  const { user } = useAuthStore();
  const [localUserId, setLocalUserId] = useState<string | null>(null);
  const {
    selectedWorkspaceId,
    selectWorkspace,
    clearSelectedWorkspace,
    isFloatingChatInputOpen,
    floatingChatInputParentId,
    closeFloatingChatInput,
  } = useWorkspaceStore();
  const { data: workspacesData, isLoading: isLoadingWorkspaces, isFetching: isFetchingWorkspaces } = useWorkspaces();
  const navigate = useNavigate();
  const { workspaceId } = useParams();
  const [searchParams] = useSearchParams();
  const messageId = searchParams.get('messageId');

  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'orchestration' | 'tracking' | 'knowledge' | 'skills' | 'logins'>('chat');
  const [loginProviderIntent, setLoginProviderIntent] = useState<'codex' | 'claude' | null>(null);
  const [threadNavigationModelsByWorkspace, setThreadNavigationModelsByWorkspace] = useState<Record<string, WorkspaceThreadNavigationModel>>({});
  const [workspaceNavigatorThreadsFocused, setWorkspaceNavigatorThreadsFocused] = useState(false);
  const [isChatCollapsed, setIsChatCollapsed] = useState(true);
  const [worktreePolicyPromptRepoPath, setWorktreePolicyPromptRepoPath] = useState<string | null>(null);
  const shellReadyLoggedRef = useRef(false);
  const graphPanelRef = useRef<ImperativePanelHandle>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const rememberedGraphChatSplitRef = useRef(readRememberedGraphChatSplit() ?? DEFAULT_GRAPH_CHAT_SPLIT);
  const effectiveUserId = user?.id ?? localUserId;
  const effectiveUserName = user?.name || 'Local workspace';
  const hasCompletedOnboarding = useOnboardingStore((state) => state.hasCompletedForUser(effectiveUserId));
  const markCompletedOnboarding = useOnboardingStore((state) => state.markCompleted);
  const startLoginProfilesSync = useLoginProfilesStore((state) => state.startSync);
  const workspaces = workspacesData ?? [];
  useEffect(() => {
    let cancelled = false;
    agentClient.getLocalIdentity()
      .then((identity) => {
        if (!cancelled) setLocalUserId(identity.localUserId);
      })
      .catch((error) => {
        console.warn('[HomePage] Failed to load local identity:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const navigateToWorkspace = useCallback((id: string, options?: { replace?: boolean; messageId?: string | null }) => {
    const search = options?.messageId ? `?messageId=${encodeURIComponent(options.messageId)}` : '';
    navigate(`/workspaces/${encodeURIComponent(id)}${search}`, { replace: options?.replace ?? false });
  }, [navigate]);
  const selectAndNavigateWorkspace = useCallback((id: string, initialFocusId?: string | null, options?: { replace?: boolean }) => {
    selectWorkspace(id, initialFocusId);
    navigateToWorkspace(id, { replace: options?.replace, messageId: initialFocusId });
  }, [navigateToWorkspace, selectWorkspace]);
  const handleNavigatorWorkspaceSelect = useCallback((id: string, options?: { replace?: boolean }) => {
    recordPerfEvent('query.workspace-switch.selected', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      fromWorkspaceId: selectedWorkspaceId,
      toWorkspaceId: id,
      activeView,
    }, { source: 'HomePage' });
    selectAndNavigateWorkspace(id, null, options);
  }, [activeView, selectAndNavigateWorkspace, selectedWorkspaceId]);
  devLogLazy(() => [
    `[ROUTE][HomePage] user=${!!user} workspaceIdParam=${workspaceId ?? 'none'} selectedWorkspaceId=${selectedWorkspaceId ?? 'none'} workspaces=${workspaces.length} isLoadingWorkspaces=${isLoadingWorkspaces} hasCompletedOnboarding=${user ? hasCompletedOnboarding : 'no-user'}`
  ]);
  const selectedWorkspace = useMemo(() => {
    if (!workspaces.length || !selectedWorkspaceId) return null;
    return workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  }, [workspaces, selectedWorkspaceId]);
  const selectedThreadNavigationModel = useMemo(() => (
    selectedWorkspaceId ? threadNavigationModelsByWorkspace[selectedWorkspaceId] ?? null : null
  ), [selectedWorkspaceId, threadNavigationModelsByWorkspace]);
  const selectedWorkspaceRepoPath = selectedWorkspace
    ? selectedWorkspace.git_repo_path
      || selectedWorkspace.local_repo_path
      || selectedWorkspace.localRepoPath
      || selectedWorkspace.repo_path
      || selectedWorkspace.folderPath
      || null
    : null;
  const worktreePolicyRepoPath = worktreePolicyPromptRepoPath ?? selectedWorkspaceRepoPath;
  const routeState = useMemo(() => resolveWorkspaceRouteState({
    workspaceIdParam: workspaceId,
    selectedWorkspaceId,
    workspaces,
    isLoadingWorkspaces,
    isFetchingWorkspaces,
  }), [isFetchingWorkspaces, isLoadingWorkspaces, selectedWorkspaceId, workspaceId, workspaces]);
  const canOpenSelectedWorkspace = Boolean(
    selectedWorkspaceId &&
    selectedWorkspace &&
    (!workspaceId || workspaceId === selectedWorkspaceId)
  );

  useEffect(() => {
    if (!user) return;
    trackScreenViewed(hasCompletedOnboarding ? 'workspace' : 'onboarding', {
      active_view: activeView,
      has_workspace: Boolean(selectedWorkspaceId),
      workspace_count: workspaces.length,
    });
  }, [activeView, hasCompletedOnboarding, selectedWorkspaceId, user, workspaces.length]);

  useEffect(() => {
    const handleOpenLoginProfiles = (event: Event) => {
      const provider = (event as CustomEvent<LoginProfilesNavigationDetail>).detail?.provider;
      if (provider !== 'codex' && provider !== 'claude') return;
      setLoginProviderIntent(provider);
      setActiveView('logins');
    };

    window.addEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, handleOpenLoginProfiles);
    return () => window.removeEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, handleOpenLoginProfiles);
  }, []);

  // Handle deep linking from URL
  useEffect(() => {
    if (routeState.type === 'wait' || routeState.type === 'none') {
      return;
    }

    if (routeState.type === 'select') {
      devLogLazy(() => [`[HomePage] URL has workspaceId: ${routeState.workspaceId}, messageId: ${messageId}`]);
      selectWorkspace(routeState.workspaceId, messageId);
      setActiveView('chat');
      return;
    }

    if (routeState.type === 'redirect') {
      selectAndNavigateWorkspace(routeState.workspaceId, null, { replace: true });
      setActiveView('chat');
      return;
    }

    if (routeState.type === 'clear') {
      clearSelectedWorkspace();
      if (workspaceId) {
        navigate('/', { replace: true });
      }
    }
  }, [clearSelectedWorkspace, messageId, navigate, routeState, selectAndNavigateWorkspace, selectWorkspace, workspaceId]);

  useEffect(() => {
    if (!effectiveUserId || hasCompletedOnboarding || workspaces.length === 0) return;
    markCompletedOnboarding(effectiveUserId, selectedWorkspaceId ?? workspaces[0]?.id ?? null);
  }, [effectiveUserId, hasCompletedOnboarding, markCompletedOnboarding, selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!effectiveUserId) return undefined;
    return startLoginProfilesSync();
  }, [effectiveUserId, startLoginProfilesSync]);

  useOpenSearchHotkey(() => {
    setIsSearchPanelOpen(true);
  });
  useAppFontSizeHotkeys();

  // Handle navigation to message from search results
  const handleNavigateToMessage = (messageId: string, workspaceId: string) => {
    selectAndNavigateWorkspace(workspaceId, messageId);
    setIsSearchPanelOpen(false);
    setActiveView('chat'); // Switch to chat view
  };

  const handleRepositoryConnected = useCallback((repoPath: string) => {
    setWorktreePolicyPromptRepoPath(repoPath);
  }, []);

  const handleThreadNavigationModelChange = useCallback((model: WorkspaceThreadNavigationModel | null) => {
    if (!model) {
      return;
    }
    recordPerfEvent('query.workspace-switch.thread-navigation-received', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      selectedWorkspaceId: useWorkspaceStore.getState().selectedWorkspaceId,
      modelWorkspaceId: model.workspaceId,
      threadCount: model.threadItems.length,
    }, { source: 'HomePage' });
    if (!model.workspaceId) return;
    setThreadNavigationModelsByWorkspace((current) => (
      current[model.workspaceId as string] === model
        ? current
        : { ...current, [model.workspaceId as string]: model }
    ));
  }, []);

  useEffect(() => {
    if (!selectedThreadNavigationModel) return;
    recordPerfEvent('query.workspace-switch.home-model-state', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      selectedWorkspaceId,
      modelWorkspaceId: selectedThreadNavigationModel.workspaceId,
      accepted: selectedThreadNavigationModel.workspaceId === selectedWorkspaceId,
      threadCount: selectedThreadNavigationModel.threadItems.length,
    }, { source: 'HomePage' });
  }, [selectedThreadNavigationModel, selectedWorkspaceId]);

  const handleNavigatorThreadOpen = useCallback((threadRootId: string) => {
    setActiveView('chat');
    selectedThreadNavigationModel?.onThreadFocus(threadRootId);
  }, [selectedThreadNavigationModel]);

  const handleNavigatorCreateThread = useCallback(() => {
    setActiveView('chat');
    selectedThreadNavigationModel?.onCreateThread();
  }, [selectedThreadNavigationModel]);

  useCreateThreadHotkey({
    enabled: activeView === 'chat'
      && Boolean(selectedThreadNavigationModel)
      && !selectedThreadNavigationModel?.createThreadDisabled,
    createThread: handleNavigatorCreateThread,
  });

  const handleWorktreePolicyOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setWorktreePolicyPromptRepoPath(null);
    }
  }, []);

  const handleGraphChatLayout = useCallback((layout: number[]) => {
    const rememberedSplit = rememberGraphChatSplit(layout);
    if (rememberedSplit) {
      rememberedGraphChatSplitRef.current = rememberedSplit;
    }

    setIsChatCollapsed(layout[1] <= 1);
  }, []);

  const restoreChatPanel = useCallback(() => {
    const [graphPercent, chatPercent] = getGraphChatRestoreSplit(rememberedGraphChatSplitRef.current);
    graphPanelRef.current?.resize(graphPercent);
    chatPanelRef.current?.resize(chatPercent);
    setIsChatCollapsed(false);
    recordPerfEvent('workspace.chat-panel-restored', {
      selectedWorkspaceId,
      activeView,
    }, { source: 'HomePage' });
  }, [activeView, selectedWorkspaceId]);

  const toggleChatPanelCollapsed = useCallback(() => {
    if (isChatCollapsed) {
      restoreChatPanel();
      return;
    }

    const currentGraphPercent = graphPanelRef.current?.getSize();
    const currentChatPercent = chatPanelRef.current?.getSize();
    if (currentGraphPercent !== undefined && currentChatPercent !== undefined) {
      const rememberedSplit = rememberGraphChatSplit([currentGraphPercent, currentChatPercent]);
      if (rememberedSplit) {
        rememberedGraphChatSplitRef.current = rememberedSplit;
      }
    }

    chatPanelRef.current?.collapse();
    graphPanelRef.current?.resize(100);
    setIsChatCollapsed(true);
    recordPerfEvent('workspace.chat-panel-hidden', {
      selectedWorkspaceId,
      activeView,
    }, { source: 'HomePage' });
  }, [activeView, isChatCollapsed, restoreChatPanel, selectedWorkspaceId]);

  if (!effectiveUserId) {
    return <PanelLoading />;
  }

  if (!hasCompletedOnboarding && !isLoadingWorkspaces) {
    devLogLazy(() => ['[ROUTE][HomePage] Rendering FirstRunExperience']);
    return (
      <Suspense fallback={<PanelLoading />}>
        <FirstRunExperience
          userName={effectiveUserName}
          workspaces={workspaces}
          onSelectWorkspace={(workspaceId) => selectAndNavigateWorkspace(workspaceId, null, { replace: true })}
          onComplete={(workspaceId) => markCompletedOnboarding(effectiveUserId, workspaceId)}
          onRepositoryConnected={handleRepositoryConnected}
        />
      </Suspense>
    );
  }

  if (!shellReadyLoggedRef.current) {
    shellReadyLoggedRef.current = true;
    recordPerfEvent('app.workspace-shell-ready', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceCount: workspaces.length,
      selectedWorkspaceId,
      activeView,
    }, { source: 'HomePage' });
  }

  devLogLazy(() => ['[ROUTE][HomePage] Rendering main workspace shell']);
  return (
    <div className="app-shell-background flex h-screen w-full flex-col overflow-hidden">
      <AgentRunLiveStreamCoordinator />
      <AppHeader
        selectedWorkspaceId={selectedWorkspaceId}
        selectedWorkspaceName={selectedWorkspace?.name || null}
        onOpenSearch={() => setIsSearchPanelOpen(true)}
      />

      <div className="app-shell-content flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          activeView={activeView}
          onViewChange={setActiveView}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspace?.name || null}
          selectedWorkspaceRepoPath={worktreePolicyRepoPath}
          worktreePolicyOpen={worktreePolicyPromptRepoPath ? true : undefined}
          onWorktreePolicyOpenChange={worktreePolicyPromptRepoPath ? handleWorktreePolicyOpenChange : undefined}
        />
        {activeView === 'chat' ? (
          <WorkspaceNavigator
            selectedWorkspaceId={selectedWorkspaceId}
            activeView={activeView}
            onSelectWorkspace={handleNavigatorWorkspaceSelect}
            onOpenThread={handleNavigatorThreadOpen}
            onCreateThread={handleNavigatorCreateThread}
            onRepositoryConnected={handleRepositoryConnected}
            threadNavigation={selectedThreadNavigationModel}
            threadsFocused={workspaceNavigatorThreadsFocused}
            onThreadsFocusedChange={setWorkspaceNavigatorThreadsFocused}
          />
        ) : null}

        <main className="app-shell-stage flex h-full min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agentree workspace shell">
          {activeView === 'chat' ? (
            canOpenSelectedWorkspace ? (
              <>
                <ResizablePanelGroup
                  direction="horizontal"
                  className="min-h-0 w-full flex-1 border-0"
                  onLayout={handleGraphChatLayout}
                >
                  <ResizablePanel
                    ref={graphPanelRef}
                    defaultSize={isChatCollapsed ? 100 : rememberedGraphChatSplitRef.current[0]}
                    minSize={0}
                    collapsible={true}
                  >
                    {/* Left Panel: Graph View */}
                    <div className="relative flex min-w-0 flex-col h-full">
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <Suspense fallback={<PanelLoading />}>
                          <GraphView onThreadNavigationModelChange={handleThreadNavigationModelChange} />
                        </Suspense>
                      </div>
                      <Suspense fallback={null}>
                        <GraphComposerDock
                          isVisible={isChatCollapsed}
                        />
                      </Suspense>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle className="app-resizable-handle">
                    <button
                      type="button"
                      onClick={toggleChatPanelCollapsed}
                      className={`app-split-handle group ${isChatCollapsed ? 'h-10 w-10 -translate-x-2' : 'h-7 w-4 -translate-x-2'}`}
                      aria-label={isChatCollapsed ? 'Restore chat panel' : 'Hide chat panel'}
                      title={isChatCollapsed ? 'Restore chat panel' : 'Hide chat panel'}
                    >
                      {isChatCollapsed ? (
                        <PanelRightOpen className={`${isChatCollapsed ? 'h-4 w-4' : 'h-3.5 w-3.5'} transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,_0.72,_0,_1)] group-hover:translate-x-0.5`} />
                      ) : (
                        <PanelRightClose className="h-3.5 w-3.5 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,_0.72,_0,_1)] group-hover:-translate-x-0.5" />
                      )}
                    </button>
                  </ResizableHandle>
                  <ResizablePanel
                    ref={chatPanelRef}
                    defaultSize={isChatCollapsed ? 0 : rememberedGraphChatSplitRef.current[1]}
                    minSize={0}
                    collapsible={true}
                    collapsedSize={0}
                  >
                    {/* Right Panel: Chat */}
                    <div className="flex h-full min-w-0 flex-col overflow-hidden border-l border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel)/0.96)]">
                      {!isChatCollapsed && (
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <Suspense fallback={<PanelLoading />}>
                            <ChatInterface
                              key={selectedWorkspaceId}
                              onMarkThreadDone={(threadRootId) => selectedThreadNavigationModel?.onThreadDoneChange(threadRootId, true)}
                            />
                          </Suspense>
                        </div>
                      )}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </>
            ) : (
              <div className="app-view-surface flex h-full items-center justify-center px-6">
                <div className="app-panel max-w-md rounded-2xl p-6 text-center">
                  <div className="text-sm font-semibold text-foreground">No workspace selected</div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Choose a workspace in the navigator to load its graph, chat, and merge history.
                  </p>
                </div>
              </div>
            )
          ) : activeView === 'orchestration' ? (
            <div className="app-view-surface h-full w-full overflow-auto p-5">
              <div className="app-view-frame mx-auto flex h-full w-full max-w-6xl flex-col">
                <header className="app-view-header">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Workspace orchestration</p>
                    <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Orchestration</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      Manage reusable node prompts and natural-language orchestration prompts for the graph composer.
                    </p>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={<PanelLoading />}>
                    <OrchestrationPanel />
                  </Suspense>
                </div>
              </div>
            </div>
          ) : activeView === 'tracking' ? (
            <div className="app-view-surface h-full w-full overflow-auto p-5">
              <Suspense fallback={<PanelLoading />}>
                <TrackingDashboard workspace={selectedWorkspace} />
              </Suspense>
            </div>
          ) : activeView === 'logins' ? (
            <Suspense fallback={<PanelLoading />}>
              <LoginProfilesPanel initialProvider={loginProviderIntent} />
            </Suspense>
          ) : activeView === 'skills' ? (
            <div className="app-view-surface h-full w-full overflow-auto p-5">
              <div className="app-view-frame mx-auto flex h-full w-full max-w-5xl flex-col">
                <header className="app-view-header">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Workspace tools</p>
                    <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Skills</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      Manage installed skills and workspace knowledge from the same shell.
                    </p>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={<PanelLoading />}>
                    <SkillsPanel className="app-panel h-full overflow-hidden rounded-2xl" />
                  </Suspense>
                </div>
              </div>
            </div>
          ) : (
            <div className="app-view-surface h-full w-full p-5">
              <div className="app-view-frame mx-auto flex h-full w-full max-w-6xl flex-col">
                <header className="app-view-header">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Workspace context</p>
                    <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Knowledge base</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      Keep project documents, references, and folders close to the current workspace.
                    </p>
                  </div>
                </header>
                <div className="app-panel min-h-0 flex-1 overflow-hidden rounded-2xl">
                  <Suspense fallback={<PanelLoading />}>
                    <KnowledgeBase />
                  </Suspense>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {isFloatingChatInputOpen && floatingChatInputParentId && (
        <div className="fixed inset-x-0 bottom-5 z-[70] flex justify-center px-4 pointer-events-none">
          <div className="w-full max-w-3xl rounded-[22px] border border-border/70 bg-background/95 p-3 shadow-[0_28px_80px_-30px_rgba(15,23,42,0.45),0_10px_24px_-18px_rgba(15,23,42,0.25)] ring-1 ring-black/5 backdrop-blur-xl pointer-events-auto dark:ring-white/10">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div className="min-w-0 text-xs font-medium text-muted-foreground">
                Replying from hovercard
              </div>
              <button
                type="button"
                onClick={closeFloatingChatInput}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close floating reply input"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ChatInput
              parentMessageIdOverride={floatingChatInputParentId}
              autoFocus
              onRequestClose={closeFloatingChatInput}
              onSendComplete={closeFloatingChatInput}
            />
          </div>
        </div>
      )}

      {/* Advanced Search Panel */}
      <Suspense fallback={null}>
        <AdvancedSearchPanel
          isOpen={isSearchPanelOpen}
          onClose={() => setIsSearchPanelOpen(false)}
          onNavigateToMessage={handleNavigateToMessage}
        />
      </Suspense>

    </div>
  );
}
