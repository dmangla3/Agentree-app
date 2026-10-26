import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, SquareTerminal, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  OPEN_COMMIT_TERMINAL_EVENT,
  type OpenCommitTerminalDetail,
} from '../../lib/commitTerminalEvents';
import type { TerminalEvent, TerminalSessionInfo } from '../../generated/tauri-bindings';
import { useToast } from '../Toast';
import './terminalDock.css';

const TerminalPane = lazy(() => import('./TerminalPane').then((module) => ({
  default: module.TerminalPane,
})));

type TerminalExitEvent = Extract<TerminalEvent, { type: 'exit' }>;
type TerminalTabStatus = 'starting' | 'running' | 'closing' | 'failed';

interface TerminalTab {
  id: string;
  repoPath: string;
  commitSha: string;
  label: string;
  status: TerminalTabStatus;
  session: TerminalSessionInfo | null;
  error: string | null;
}

interface TerminalDockProps {
  onRequestShow?: () => void;
  onTabsChange?: (hasTabs: boolean) => void;
}

const newTab = (detail: OpenCommitTerminalDetail): TerminalTab => ({
  id: crypto.randomUUID(),
  repoPath: detail.repoPath,
  commitSha: detail.commitSha,
  label: detail.label?.trim() || `Commit ${detail.commitSha.slice(0, 7)}`,
  status: 'starting',
  session: null,
  error: null,
});

export function TerminalDock({ onRequestShow, onTabsChange }: TerminalDockProps) {
  const { addToast } = useToast();
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[tabs.length - 1] ?? null,
    [activeTabId, tabs],
  );

  const openTab = useCallback((detail: OpenCommitTerminalDetail) => {
    const tab = newTab(detail);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    onRequestShow?.();
  }, [onRequestShow]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenCommitTerminalDetail>).detail;
      if (!detail?.repoPath?.trim() || !detail?.commitSha?.trim()) return;
      openTab({
        repoPath: detail.repoPath.trim(),
        commitSha: detail.commitSha.trim(),
        label: detail.label?.trim() || null,
      });
    };
    window.addEventListener(OPEN_COMMIT_TERMINAL_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_COMMIT_TERMINAL_EVENT, handleOpen);
  }, [openTab]);

  useEffect(() => {
    onTabsChange?.(tabs.length > 0);
  }, [onTabsChange, tabs.length]);

  useEffect(() => {
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(tabs[tabs.length - 1]?.id ?? null);
  }, [activeTabId, tabs]);

  const removeTab = useCallback((tabId: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
  }, []);

  const requestClose = useCallback((tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.status === 'failed') {
      removeTab(tabId);
      return;
    }
    setTabs((current) => current.map((candidate) => candidate.id === tabId
      ? { ...candidate, status: 'closing' as const, error: null }
      : candidate));
  }, [removeTab, tabs]);

  const handleSessionReady = useCallback((tabId: string, session: TerminalSessionInfo) => {
    setTabs((current) => current.map((tab) => {
      if (tab.id !== tabId || tab.status === 'failed') return tab;
      return {
          ...tab,
          session,
          status: tab.status === 'closing' ? 'closing' : 'running',
          commitSha: session.commitSha,
      };
    }));
  }, []);

  const handleExit = useCallback((tabId: string, event: TerminalExitEvent) => {
    if (event.cleanup_message) {
      addToast({
        title: event.worktree_disposition === 'retainedDirty'
          ? 'Terminal changes were preserved'
          : 'Terminal worktree was retained',
        description: event.cleanup_message,
        variant: event.worktree_disposition === 'retainedDirty' ? 'warning' : 'error',
        duration: 10_000,
      });
    }

    setTabs((current) => current.filter((candidate) => candidate.id !== tabId));
  }, [addToast]);

  const handleError = useCallback((tabId: string, message: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId
      ? { ...tab, status: 'failed', error: message }
      : tab));
  }, []);

  const handleCloseRequestFailed = useCallback((tabId: string, message: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId
      ? { ...tab, status: tab.session ? 'running' : 'failed', error: message }
      : tab));
    addToast({
      title: 'Could not close terminal',
      description: message,
      variant: 'error',
      duration: 8_000,
    });
  }, [addToast]);

  const duplicateActiveCommit = useCallback(() => {
    if (!activeTab) return;
    openTab({
      repoPath: activeTab.repoPath,
      commitSha: activeTab.commitSha,
      label: activeTab.label,
    });
  }, [activeTab, openTab]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[hsl(var(--app-bg)/0.98)] shadow-[0_-14px_40px_-34px_hsl(var(--foreground)/0.5)]"
      aria-label="Commit terminals"
    >
      <div className="flex h-10 shrink-0 items-stretch border-b border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.9)]">
        <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-xs font-semibold text-foreground">
          <SquareTerminal className="h-4 w-4 text-[hsl(var(--app-accent))]" />
          <span>Terminal</span>
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Terminal tabs">
          <div className="flex min-w-max items-stretch">
            {tabs.map((tab) => {
              const active = tab.id === activeTab?.id;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group flex h-10 max-w-[260px] items-stretch border-l border-[hsl(var(--app-border)/0.52)] transition-[background-color,box-shadow] duration-150',
                    active
                      ? 'bg-[hsl(var(--app-bg))] shadow-[inset_0_-2px_0_hsl(var(--app-accent))]'
                      : 'bg-transparent hover:bg-[hsl(var(--app-bg-muted)/0.46)]',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTabId(tab.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--app-focus))] active:scale-[0.96] transition-transform duration-150"
                    title={`${tab.label}\n${tab.commitSha}`}
                  >
                    {tab.status === 'starting' || tab.status === 'closing' ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          tab.status === 'running' && 'bg-[hsl(var(--app-success))]',
                          tab.status === 'failed' && 'bg-destructive',
                        )}
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 truncate text-xs font-medium">{tab.label}</span>
                    <code className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {tab.commitSha.slice(0, 7)}
                    </code>
                  </button>
                  <button
                    type="button"
                    onClick={() => requestClose(tab.id)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--app-focus))] active:scale-[0.96]"
                    aria-label={`Close terminal ${tab.label}`}
                    title="Close terminal and release its worktree attachment"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={duplicateActiveCommit}
          disabled={!activeTab}
          className="flex h-10 w-10 shrink-0 items-center justify-center border-l border-[hsl(var(--app-border)/0.52)] text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--app-focus))] active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
          aria-label="New terminal at active commit"
          title="Open another shell in this commit worktree"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn('absolute inset-0', tab.id === activeTab?.id ? 'block' : 'invisible')}
            aria-hidden={tab.id !== activeTab?.id}
          >
            <Suspense
              fallback={(
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting terminal renderer...
                </div>
              )}
            >
              <TerminalPane
                tabId={tab.id}
                repoPath={tab.repoPath}
                commitSha={tab.commitSha}
                active={tab.id === activeTab?.id}
                closeRequested={tab.status === 'closing'}
                onSessionReady={handleSessionReady}
                onExit={handleExit}
                onError={handleError}
                onCloseRequestFailed={handleCloseRequestFailed}
              />
            </Suspense>
          </div>
        ))}

        {activeTab?.status === 'failed' ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
            <div className="max-w-2xl rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-[0_0_0_1px_hsl(var(--destructive)/0.24)]">
              {activeTab.error || 'The terminal could not be started.'}
            </div>
          </div>
        ) : null}

      </div>
    </section>
  );
}
