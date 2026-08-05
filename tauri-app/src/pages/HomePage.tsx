import { lazy, Suspense, useCallback, useEffect, useState, useMemo, useRef } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { useAuthStore } from '../stores/authStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChatInput } from '../components/ChatInput';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../@/components/ui/resizable";
import { WorkspaceSelectionDialog } from '../components/WorkspaceSelectionDialog';
import { Sidebar } from '../components/Sidebar';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useIntegrationStore } from '../stores/integrationStore';
import { AppHeader } from '../components/AppHeader';
import { ChatPanelHeader } from '../components/ChatPanelHeader';
import { useOnboardingStore } from '../stores/onboardingStore';
import { trackScreenViewed } from '../lib/analytics';
import { devLogLazy } from '../lib/appLogger';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { DEFAULT_GRAPH_CHAT_SPLIT, getGraphChatRestoreSplit, readRememberedGraphChatSplit, rememberGraphChatSplit } from '../lib/graphChatSplitLayout';
import { PanelRightClose, PanelRightOpen, X } from 'lucide-react';

const AdvancedSearchPanel = lazy(() => import('../components/AdvancedSearchPanel').then((module) => ({ default: module.AdvancedSearchPanel })));
const ChatInterface = lazy(() => import('../components/ChatInterface').then((module) => ({ default: module.ChatInterface })));
const FirstRunExperience = lazy(() => import('../components/onboarding/FirstRunExperience').then((module) => ({ default: module.FirstRunExperience })));
const GraphView = lazy(() => import('../components/GraphView').then((module) => ({ default: module.GraphView })));
const KnowledgeBase = lazy(() => import('../components/KnowledgeBase/KnowledgeBase').then((module) => ({ default: module.KnowledgeBase })));
const MergePanel = lazy(() => import('../components/MergePanel').then((module) => ({ default: module.MergePanel })));
const SkillsPanel = lazy(() => import('../components/SkillsPanel').then((module) => ({ default: module.SkillsPanel })));

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
  const {
    selectedWorkspaceId,
    selectWorkspace,
    clearSelectedWorkspace,
    rightPanelTab,
    setRightPanelTab,
    isFloatingChatInputOpen,
    floatingChatInputParentId,
    closeFloatingChatInput,
  } = useWorkspaceStore();
  const { data: workspacesData, isLoading: isLoadingWorkspaces } = useWorkspaces();
  const navigate = useNavigate();
  const { workspaceId } = useParams();
  const [searchParams] = useSearchParams();
  const messageId = searchParams.get('messageId');
  const mergeSession = useIntegrationStore((state) => state.session);
  const mergeTabAttentionNonce = useIntegrationStore((state) => state.mergeTabAttentionNonce);

  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'knowledge' | 'skills'>('chat');
  const [mergeTabAttentionActive, setMergeTabAttentionActive] = useState(false);
  const mergeSourceCount = mergeSession?.sources.length ?? 0;
  const [isWorkspaceSelectorOpen, setIsWorkspaceSelectorOpen] = useState(false);
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);
  const shellReadyLoggedRef = useRef(false);
  const graphPanelRef = useRef<ImperativePanelHandle>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const rememberedGraphChatSplitRef = useRef(readRememberedGraphChatSplit() ?? DEFAULT_GRAPH_CHAT_SPLIT);
  const hasCompletedOnboarding = useOnboardingStore((state) => state.hasCompletedForUser(user?.id));
  const markCompletedOnboarding = useOnboardingStore((state) => state.markCompleted);
  const workspaces = workspacesData ?? [];
  devLogLazy(() => [
    `[ROUTE][HomePage] user=${!!user} workspaceIdParam=${workspaceId ?? 'none'} selectedWorkspaceId=${selectedWorkspaceId ?? 'none'} workspaces=${workspaces.length} isLoadingWorkspaces=${isLoadingWorkspaces} hasCompletedOnboarding=${user ? hasCompletedOnboarding : 'no-user'}`
  ]);
  const selectedWorkspace = useMemo(() => {
    if (!workspaces.length || !selectedWorkspaceId) return null;
    return workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (mergeTabAttentionNonce <= 0) return;
    setMergeTabAttentionActive(true);
    const timeoutId = window.setTimeout(() => setMergeTabAttentionActive(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [mergeTabAttentionNonce]);

  useEffect(() => {
    if (!user) return;
    trackScreenViewed(hasCompletedOnboarding ? 'workspace' : 'onboarding', {
      active_view: activeView,
      has_workspace: Boolean(selectedWorkspaceId),
      workspace_count: workspaces.length,
    });
  }, [activeView, hasCompletedOnboarding, selectedWorkspaceId, user, workspaces.length]);

  // Handle deep linking from URL
  useEffect(() => {
    if (workspaceId) {
      devLogLazy(() => [`[HomePage] URL has workspaceId: ${workspaceId}, messageId: ${messageId}`]);
      selectWorkspace(workspaceId, messageId);
      setActiveView('chat');
    }
  }, [workspaceId, messageId, selectWorkspace]);

  useEffect(() => {
    if (!user || hasCompletedOnboarding || workspaces.length === 0) return;
    markCompletedOnboarding(user.id, selectedWorkspaceId ?? workspaces[0]?.id ?? null);
  }, [hasCompletedOnboarding, markCompletedOnboarding, selectedWorkspaceId, user, workspaces]);

  useEffect(() => {
    if (workspaceId || selectedWorkspaceId || workspaces.length === 0) return;
    selectWorkspace(workspaces[0].id);
  }, [selectedWorkspaceId, selectWorkspace, workspaceId, workspaces]);

  useEffect(() => {
    if (workspaceId || isLoadingWorkspaces || !selectedWorkspaceId) return;
    const selectedWorkspaceExists = workspaces.some((workspace) => workspace.id === selectedWorkspaceId);
    if (selectedWorkspaceExists) return;

    if (workspaces.length > 0) {
      selectWorkspace(workspaces[0].id);
      return;
    }

    clearSelectedWorkspace();
  }, [clearSelectedWorkspace, isLoadingWorkspaces, selectedWorkspaceId, selectWorkspace, workspaceId, workspaces]);

  // Keyboard shortcuts for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchPanelOpen(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle navigation to message from search results
  const handleNavigateToMessage = (messageId: string, workspaceId: string) => {
    selectWorkspace(workspaceId, messageId);
    setIsSearchPanelOpen(false);
    setActiveView('chat'); // Switch to chat view
  };

  const handleGraphChatLayout = useCallback((layout: number[]) => {
    const rememberedSplit = rememberGraphChatSplit(layout);
    if (rememberedSplit) {
      rememberedGraphChatSplitRef.current = rememberedSplit;
    }

    setIsChatCollapsed(layout[1] <= 1);
  }, []);

  const toggleChatPanelCollapsed = useCallback(() => {
    if (isChatCollapsed) {
      const [graphPercent, chatPercent] = getGraphChatRestoreSplit(rememberedGraphChatSplitRef.current);
      graphPanelRef.current?.resize(graphPercent);
      chatPanelRef.current?.resize(chatPercent);
      setIsChatCollapsed(false);
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
  }, [isChatCollapsed]);

  // If no user, ProtectedRoute should have redirected, but double-check
  useEffect(() => {
    if (!user) {
      navigate('/login', { replace: true });
    }
  }, [user, navigate]);

  if (!user) {
    devLogLazy(() => ['[ROUTE][HomePage] Returning null because user is missing']);
    return null; // Render nothing while redirecting
  }

  if (!hasCompletedOnboarding && !isLoadingWorkspaces) {
    devLogLazy(() => ['[ROUTE][HomePage] Rendering FirstRunExperience']);
    return (
      <Suspense fallback={<PanelLoading />}>
        <FirstRunExperience
          userName={user.name}
          workspaces={workspaces}
          onSelectWorkspace={selectWorkspace}
          onComplete={(workspaceId) => markCompletedOnboarding(user.id, workspaceId)}
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
    <div className="app-shell-background flex h-screen w-full flex-col">
      {/* Top Header - Full Width */}
      {activeView === 'chat' && (
        <AppHeader
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspace?.name || null}
          onOpenWorkspaceSelector={() => setIsWorkspaceSelectorOpen(true)}
          onOpenSearch={() => setIsSearchPanelOpen(true)}
        />
      )}

      {/* Main Content Area with Sidebar */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Sidebar Navigation Rail - Below Header */}
        <Sidebar
          activeView={activeView}
          onViewChange={setActiveView}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspace?.name || null}
        />

        {/* Content Area */}
        <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          {activeView === 'chat' ? (
            selectedWorkspaceId ? (
              <>
                {/* Panels */}
                <ResizablePanelGroup
                  direction="horizontal"
                  className="flex-1 min-h-0 w-full rounded-lg border-0"
                  onLayout={handleGraphChatLayout}
                >
                  <ResizablePanel
                    ref={graphPanelRef}
                    defaultSize={rememberedGraphChatSplitRef.current[0]}
                    minSize={0}
                    collapsible={true}
                  >
                    {/* Left Panel: Graph View */}
                    <div className="flex min-w-0 flex-col h-full">
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <Suspense fallback={<PanelLoading />}>
                          <GraphView />
                        </Suspense>
                      </div>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle>
                    <button
                      type="button"
                      onClick={toggleChatPanelCollapsed}
                      className={`group relative z-20 flex items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-[0_10px_28px_-16px_rgba(15,23,42,0.55)] ring-1 ring-black/5 transition-[width,height,background-color,color,box-shadow,transform] duration-300 [transition-timing-function:cubic-bezier(0.32,_0.72,_0,_1)] hover:bg-accent hover:text-foreground hover:shadow-[0_14px_34px_-18px_rgba(15,23,42,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95 dark:ring-white/10 ${isChatCollapsed ? 'h-11 w-14 -translate-x-3' : 'h-8 w-5 hover:w-7'}`}
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
                    defaultSize={rememberedGraphChatSplitRef.current[1]}
                    minSize={0}
                    collapsible={true}
                    collapsedSize={0}
                  >
                    {/* Right Panel: Chat/Merge */}
                    <div className="flex min-w-0 h-full flex-col overflow-hidden bg-background">
                      {/* Chat Sub-Header */}
                      <ChatPanelHeader
                        rightPanelTab={rightPanelTab}
                        onTabChange={setRightPanelTab}
                        mergeSourceCount={mergeSourceCount}
                        mergeTabAttentionActive={mergeTabAttentionActive}
                      />

                      {/* Tab Content */}
                      <div className="flex-1 min-w-0 overflow-hidden">
                        {rightPanelTab === 'chat' ? (
                          <Suspense fallback={<PanelLoading />}>
                            <ChatInterface key={selectedWorkspaceId} />
                          </Suspense>
                        ) : (
                          <Suspense fallback={<PanelLoading />}>
                            <MergePanel onClose={() => {
                              setRightPanelTab('chat');
                            }} />
                          </Suspense>
                        )}
                      </div>
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </>
            ) : (
              <div className="flex h-full items-center justify-center bg-background/70 px-6">
                <button
                  type="button"
                  onClick={() => setIsWorkspaceSelectorOpen(true)}
                  className="app-command-button app-focus-ring rounded-lg px-3 py-2 text-sm font-semibold"
                >
                  Select workspace
                </button>
              </div>
            )
          ) : activeView === 'skills' ? (
            <div className="h-full w-full overflow-auto bg-background/60 p-5">
              <div className="max-w-4xl mx-auto h-full">
                <Suspense fallback={<PanelLoading />}>
                  <SkillsPanel className="app-panel h-full rounded-xl" />
                </Suspense>
              </div>
            </div>
          ) : (
            /* Knowledge Base View */
            <div className="h-full w-full bg-background/60 p-5">
              <h1 className="mb-4 text-xl font-semibold tracking-[-0.01em]">Knowledge Base</h1>
              <div className="app-panel h-[calc(100%-3rem)] overflow-hidden rounded-xl">
                <Suspense fallback={<PanelLoading />}>
                  <KnowledgeBase />
                </Suspense>
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

      {/* Workspace Selector Dialog */}
      <WorkspaceSelectionDialog
        isOpen={isWorkspaceSelectorOpen}
        onOpenChange={setIsWorkspaceSelectorOpen}
      />
    </div>
  );
}
