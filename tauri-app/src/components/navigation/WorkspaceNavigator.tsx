import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FolderGit,
  FolderOpen,
  Focus,
  GitBranch,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { Input } from '../../../@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '../../../@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../@/components/ui/dropdown-menu';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import {
  RepoPrepareActionRequiredError,
  useCreateWorkspace,
  useDeleteWorkspace,
  useRenameWorkspace,
  useWorkspaces,
  type RepoDirtyStrategy,
} from '../../hooks/useWorkspaces';
import { localNodeKeys, parseLocalNode } from '../../hooks/useLocalNodes';
import { applyLocalNodeMessages } from '../../hooks/useLiveMessages';
import { threadSessionKeys, useRenameThreadSession } from '../../hooks/useThreadSessions';
import { agentClient } from '../../lib/agentClient';
import { finalizeCreatedWorkspace } from '../../lib/finalizeCreatedWorkspace';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../../lib/perfRecorder';
import { normalizeThreadSession } from '../../lib/threadSessions';
import { resolveLocalWorkspaceRepoPath } from '../../lib/workspaceRepoPath';
import { copyAgentreeLink } from '../../lib/agentreeDeepLinks';
import { cn } from '../../lib/utils';
import { useToast } from '../Toast';
import { ChangedFilesSummary } from '../ChangedFilesSummary';
import { WorkspaceDeleteDialog } from '../WorkspaceDeleteDialog';
import { WorkspaceRenameDialog } from '../WorkspaceRenameDialog';
import {
  formatThreadMetadata,
  getThreadUnreadBadgeCount,
  ParallelThreadsIcon,
  ThreadNodeHoverCard,
  ThreadUnreadBadge,
  type ThreadHoverProjectionInput,
  type ThreadNavigationItem,
} from '../graph/GraphControls';
import { orderThreadFamiliesNewestFirst } from './threadNavigationHierarchy';

export interface WorkspaceThreadNavigationModel {
  workspaceId: string | null;
  messagesReady: boolean;
  messageIds: Set<string>;
  threadItems: ThreadNavigationItem[];
  threadHoverProjectionInput?: ThreadHoverProjectionInput;
  doneThreadsCollapsed: boolean;
  threadBarCollapsed: boolean;
  onThreadFocus: (threadRootId: string) => void;
  onThreadDoneChange: (threadRootId: string, done: boolean) => void;
  onThreadDelete?: (threadRootId: string) => void;
  onDoneThreadsCollapsedChange: (collapsed: boolean) => void;
  onThreadBarCollapsedChange: (collapsed: boolean) => void;
  onCreateThread: () => void;
  createThreadDisabled?: boolean;
  createThreadDisabledReason?: string;
}

interface WorkspaceNavigatorProps {
  selectedWorkspaceId: string | null;
  activeView: 'chat' | 'orchestration' | 'tracking' | 'knowledge' | 'logins';
  onSelectWorkspace: (workspaceId: string, options?: { replace?: boolean }) => void;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onRepositoryConnected?: (repoPath: string, workspaceId: string) => void;
  threadNavigation: WorkspaceThreadNavigationModel | null;
  threadsFocused?: boolean;
  onThreadsFocusedChange?: (focused: boolean) => void;
}

interface RepoGroup {
  id: string;
  path: string;
  name: string;
  workspaces: Workspace[];
  createdAt: number;
}

function normalizeRepoPathForComparison(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\/]+$/, '').toLowerCase();
}

function parseWorkspaceTimestamp(value: string | null | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return 0;

  const numericTimestamp = Number(normalized);
  if (Number.isFinite(numericTimestamp)) {
    return numericTimestamp < 1_000_000_000_000 ? numericTimestamp * 1000 : numericTimestamp;
  }

  const parsedTimestamp = Date.parse(normalized);
  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
}

function workspaceCreatedMs(workspace: Workspace): number {
  return parseWorkspaceTimestamp(workspace.createdAt) || parseWorkspaceTimestamp(workspace.updatedAt);
}

function compareWorkspaceCreation(left: Workspace, right: Workspace): number {
  const createdDelta = workspaceCreatedMs(left) - workspaceCreatedMs(right);
  if (createdDelta !== 0) return createdDelta;
  return getWorkspaceDisplayName(left).toLowerCase().localeCompare(getWorkspaceDisplayName(right).toLowerCase());
}

function groupWorkspacesByRepo(workspaces: Workspace[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const unassigned: Workspace[] = [];

  for (const workspace of workspaces) {
    const repoPath = resolveLocalWorkspaceRepoPath(workspace);
    if (!repoPath) {
      unassigned.push(workspace);
      continue;
    }

    const repoName = repoPath.split(/[/\\]/).pop() || 'Unknown Repo';
    if (!groups.has(repoPath)) {
      groups.set(repoPath, {
        id: `repo-${repoPath}`,
        path: repoPath,
        name: repoName,
        workspaces: [],
        createdAt: Number.POSITIVE_INFINITY,
      });
    }

    const group = groups.get(repoPath)!;
    group.workspaces.push(workspace);
    group.createdAt = Math.min(group.createdAt, workspaceCreatedMs(workspace));
  }

  for (const group of groups.values()) {
    group.workspaces.sort(compareWorkspaceCreation);
  }

  const sorted = Array.from(groups.values()).sort((a, b) => {
    const createdDelta = a.createdAt - b.createdAt;
    if (createdDelta !== 0) return createdDelta;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  if (unassigned.length > 0) {
    unassigned.sort(compareWorkspaceCreation);
    sorted.push({
      id: 'unassigned',
      path: '',
      name: 'Unassigned',
      workspaces: unassigned,
      createdAt: Math.min(...unassigned.map(workspaceCreatedMs)),
    });
  }

  return sorted;
}

function getWorkspaceDisplayName(workspace: Workspace): string {
  if (workspace.name && workspace.name !== 'New Workspace') return workspace.name;
  return `Workspace ${workspace.id.substring(0, 6)}`;
}

function formatWorkspaceTime(timestampMs: number): string | null {
  if (timestampMs <= 0) return null;

  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestampMs) / 60_000));
  if (elapsedMinutes < 1) return 'now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Date(timestampMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getWorkspacesForRepo(workspaces: Workspace[], repoPath: string): Workspace[] {
  const normalizedRepoPath = normalizeRepoPathForComparison(repoPath);
  if (!normalizedRepoPath) return [];
  return workspaces
    .filter((workspace) => normalizeRepoPathForComparison(resolveLocalWorkspaceRepoPath(workspace)) === normalizedRepoPath)
    .sort(compareWorkspaceCreation);
}

function ThreadRenameDialog({
  thread,
  isRenaming = false,
  onOpenChange,
  onRename,
}: {
  thread: ThreadNavigationItem | null;
  isRenaming?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (thread: ThreadNavigationItem, title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(thread?.fullLabel ?? thread?.label ?? '');
  }, [thread]);

  useEffect(() => {
    if (!thread) return;
    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [thread]);

  const currentTitle = (thread?.fullLabel ?? thread?.label ?? '').trim();
  const trimmedTitle = title.trim();
  const canSubmit = Boolean(thread && trimmedTitle && trimmedTitle !== currentTitle && !isRenaming);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!thread || !canSubmit) return;
    await onRename(thread, trimmedTitle);
  };

  return (
    <Dialog open={thread !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Thread</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={isRenaming}
            aria-label="Thread name"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ThreadRow({
  thread,
  threadHoverProjectionInput,
  onOpenThread,
  onThreadDoneChange,
  onThreadRename,
  onThreadDelete,
}: {
  thread: ThreadNavigationItem;
  threadHoverProjectionInput?: ThreadHoverProjectionInput;
  onOpenThread: (threadRootId: string) => void;
  onThreadDoneChange: (threadRootId: string, done: boolean) => void;
  onThreadRename: (thread: ThreadNavigationItem) => void;
  onThreadDelete?: (threadRootId: string) => void;
}) {
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const unreadCompletedLeafCount = getThreadUnreadBadgeCount(thread);
  const metadata = formatThreadMetadata(thread);
  const activityLabel = thread.runningCount > 1 ? `${thread.runningCount} running` : 'Running';
  const baseCommitLabel = thread.baseCommitSha ? thread.baseCommitSha.slice(0, 8) : 'unknown base';
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  const handleContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
    setContextMenuOpen(true);
  }, []);

  const row = (
    <div
      onContextMenu={handleContextMenu}
      style={thread.depth ? { marginLeft: `${Math.min(thread.depth, 4) * 12}px` } : undefined}
      className={cn(
        'group/thread relative flex min-w-0 items-stretch overflow-hidden rounded-lg border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.022)] transition-[background-color,border-color,box-shadow,opacity,transform] duration-200 ease-out',
        thread.current
          ? 'border-transparent bg-[hsl(var(--app-bg-muted))] text-foreground shadow-[0_10px_24px_-22px_rgb(24_24_27/0.58)] dark:bg-zinc-700 dark:text-zinc-50'
          : 'border-transparent bg-[hsl(var(--app-panel)/0.08)] text-muted-foreground hover:-translate-y-px hover:border-[hsl(var(--app-border)/0.34)] hover:bg-[hsl(var(--app-panel-strong)/0.46)] hover:text-foreground hover:shadow-[0_8px_22px_-20px_hsl(var(--foreground)/0.32)]',
        thread.done && thread.runningCount === 0 && 'opacity-70',
      )}
    >
      <button
        type="button"
        className={cn(
          'min-w-0 flex-1 px-2 py-1.5 text-left outline-none transition-[opacity,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          unreadCompletedLeafCount > 0 && 'pr-8',
        )}
        aria-label={`Open thread ${thread.label}`}
        onClick={() => onOpenThread(thread.threadRootId)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {(thread.depth ?? 0) > 0 ? (
            <span
              aria-hidden="true"
              className="-ml-0.5 shrink-0 font-mono text-[10px] leading-none text-muted-foreground/45"
            >
              └
            </span>
          ) : null}
          <span
            className={cn(
              'shrink-0 rounded-full',
              thread.current
                ? 'h-2 w-2 bg-zinc-950 dark:bg-zinc-100'
                : thread.runningCount > 0
                  ? 'h-1.5 w-1.5 bg-[hsl(var(--app-warning))]'
                  : thread.done
                    ? 'h-1.5 w-1.5 bg-muted-foreground/30'
                    : 'h-1.5 w-1.5 bg-muted-foreground/45',
            )}
          />
          <span
            className={cn(
              'min-w-0 truncate text-[10.5px] leading-none',
              thread.current
                ? 'font-semibold text-zinc-950 dark:text-zinc-50'
                : thread.runningCount > 0
                  ? 'font-medium text-foreground/82 dark:text-foreground/88'
                  : thread.done
                    ? 'font-normal text-foreground/52 dark:text-foreground/60'
                    : 'font-normal text-foreground/70 dark:text-foreground/78',
            )}
          >
            {thread.label}
          </span>
          {thread.current ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-panel-strong))] px-1 py-0.5 text-[8px] font-bold leading-none text-foreground dark:bg-zinc-600 dark:text-zinc-50">
              Current
            </span>
          ) : null}
          {thread.runningCount > 0 ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-warning)/0.12)] px-1 py-0.5 text-[8px] font-bold leading-none text-[hsl(var(--app-warning))]">
              {activityLabel}
            </span>
          ) : thread.done ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-bg-muted))] px-1 py-0.5 text-[8px] font-bold leading-none text-muted-foreground">
              Closed
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-[9px] leading-none text-muted-foreground/70">
          <span className="font-mono text-muted-foreground/90">{baseCommitLabel}</span>
          <span className="px-1 text-muted-foreground/45">·</span>
          {metadata}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}
        aria-label={thread.done ? `Reopen thread ${thread.label}` : `Close thread ${thread.label}`}
        className={cn(
          'flex w-7 shrink-0 items-center justify-center border-l border-[hsl(var(--app-border)/0.32)] text-muted-foreground opacity-60 transition-[background-color,color,opacity] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.32)] hover:text-foreground group-hover/thread:opacity-100',
          thread.done && 'text-[hsl(var(--app-accent))] opacity-100',
        )}
      >
        {thread.done ? <Eye size={11} strokeWidth={2} /> : <Check size={11} strokeWidth={2} />}
      </button>
      <DropdownMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed h-0 w-0 opacity-0"
            style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="w-40">
          {selectedWorkspaceId ? (
            <DropdownMenuItem onClick={() => void copyAgentreeLink({ workspaceId: selectedWorkspaceId, threadId: thread.threadRootId })}>
              <Copy className="mr-2 h-4 w-4" />
              Copy link
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => onThreadRename(thread)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename thread
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}>
            {thread.done ? 'Reopen thread' : 'Close thread'}
          </DropdownMenuItem>
          {onThreadDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onThreadDelete(thread.threadRootId)}
              >
                Delete thread
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ThreadUnreadBadge
        count={unreadCompletedLeafCount}
        className="pointer-events-none absolute right-8 top-1.5"
      />
    </div>
  );

  if (thread.current) return row;

  return (
    <ThreadNodeHoverCard thread={thread} projectionInput={threadHoverProjectionInput} side="right">
      {row}
    </ThreadNodeHoverCard>
  );
}

const MemoThreadRow = memo(ThreadRow);

function WorkspaceThreadSection({
  model,
  onOpenThread,
  onCreateThread,
  onThreadRename,
  threadsFocused = false,
  onThreadsFocusedChange,
}: {
  model: WorkspaceThreadNavigationModel | null;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onThreadRename: (thread: ThreadNavigationItem) => void;
  threadsFocused?: boolean;
  onThreadsFocusedChange?: (focused: boolean) => void;
}) {
  const activeThreadItems = useMemo(
    () => orderThreadFamiliesNewestFirst(
      model?.threadItems.filter((thread) => !thread.done || thread.runningCount > 0) ?? [],
    ),
    [model?.threadItems],
  );
  const closedThreadItems = useMemo(
    () => orderThreadFamiliesNewestFirst(
      model?.threadItems.filter((thread) => thread.done && thread.runningCount === 0) ?? [],
    ),
    [model?.threadItems],
  );
  const runningCount = useMemo(
    () => model?.threadItems.reduce((total, thread) => total + thread.runningCount, 0) ?? 0,
    [model?.threadItems],
  );

  if (!model) {
    return (
      <div className="rounded-xl border border-dashed border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-panel-strong)/0.38)] px-2.5 py-2 text-[11px] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
        Loading thread index...
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-[hsl(var(--app-border)/0.24)] bg-[hsl(var(--app-panel-strong))] p-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.5)] dark:bg-zinc-800 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]">
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.34)] pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground/66">
          <ParallelThreadsIcon size={12} strokeWidth={2.1} />
          <span>Threads</span>
          <span className="rounded bg-[hsl(var(--app-bg-muted)/0.72)] px-1.5 py-0.5 font-mono text-[8px] tracking-normal text-foreground/70">
            {runningCount} running
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onThreadsFocusedChange ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={threadsFocused ? 'Show workspaces' : 'Focus threads'}
                  aria-pressed={threadsFocused}
                  onClick={() => onThreadsFocusedChange(!threadsFocused)}
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.5)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    threadsFocused
                      ? 'border-[hsl(var(--app-accent)/0.46)] bg-[hsl(var(--app-accent-soft)/0.58)] text-[hsl(var(--app-accent))]'
                      : 'border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel)/0.5)] text-muted-foreground',
                  )}
                >
                  <Focus size={13} strokeWidth={2.25} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                {threadsFocused ? 'Show workspaces' : 'Focus threads'}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Start new thread"
                disabled={model.createThreadDisabled}
                onClick={onCreateThread}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel)/0.5)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.5)] hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
              >
                <Plus size={13} strokeWidth={2.3} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {model.createThreadDisabled ? model.createThreadDisabledReason : 'Start new thread'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="space-y-1">
        {activeThreadItems.map((thread) => (
          <MemoThreadRow
            key={thread.threadRootId}
            thread={thread}
            threadHoverProjectionInput={model.threadHoverProjectionInput}
            onOpenThread={onOpenThread}
            onThreadDoneChange={model.onThreadDoneChange}
            onThreadRename={onThreadRename}
            onThreadDelete={model.onThreadDelete}
          />
        ))}
      </div>
      {closedThreadItems.length > 0 ? (
        <div className="border-t border-[hsl(var(--app-border)/0.38)] pt-2">
          <button
            type="button"
            aria-expanded={!model.doneThreadsCollapsed}
            onClick={() => model.onDoneThreadsCollapsedChange(!model.doneThreadsCollapsed)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-[hsl(var(--app-panel)/0.56)] hover:text-foreground"
          >
            <span>Closed threads</span>
            <span className="font-mono tracking-normal">{closedThreadItems.length}</span>
          </button>
          {!model.doneThreadsCollapsed ? (
            <div className="mt-1 space-y-1">
              {closedThreadItems.map((thread) => (
                <MemoThreadRow
                  key={thread.threadRootId}
                  thread={thread}
                  threadHoverProjectionInput={model.threadHoverProjectionInput}
                  onOpenThread={onOpenThread}
                  onThreadDoneChange={model.onThreadDoneChange}
                  onThreadRename={onThreadRename}
                  onThreadDelete={model.onThreadDelete}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceRow({
  workspace,
  selected,
  threadCount,
  lastActiveAt,
  onSelectWorkspace,
  onRequestRename,
  onRequestDelete,
  onPrefetchWorkspace,
}: {
  workspace: Workspace;
  selected: boolean;
  threadCount?: number;
  lastActiveAt?: number;
  onSelectWorkspace: (workspaceId: string) => void;
  onRequestRename: (workspace: Workspace) => void;
  onRequestDelete: (workspace: Workspace) => void;
  onPrefetchWorkspace: (workspaceId: string) => void;
}) {
  const status = workspace.connection_status ?? workspace.connectionStatus ?? workspace.sync_status ?? workspace.syncStatus ?? null;
  const statusLabel = status && status !== 'connected' && status !== 'synced' ? String(status).replace(/_/g, ' ') : null;
  const workspaceUpdatedAt = parseWorkspaceTimestamp(workspace.updatedAt);
  const activityTimestamp = lastActiveAt || workspaceUpdatedAt;
  const activityLabel = formatWorkspaceTime(activityTimestamp);
  const metadata = [
    statusLabel,
    threadCount !== undefined ? `${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}` : null,
    activityLabel,
  ].filter((value): value is string => Boolean(value)).join(' · ');
  const activityTitle = activityLabel && activityTimestamp > 0
    ? `${lastActiveAt ? 'Last active' : 'Workspace updated'} ${new Date(activityTimestamp).toLocaleString()}`
    : undefined;

  return (
    <div
      className={cn(
        'group/workspace flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)] transition-[background-color,border-color,box-shadow,color,transform] duration-150 ease-out',
        selected
          ? 'border-[hsl(var(--app-border-strong)/0.42)] bg-[hsl(var(--app-panel-strong))] text-foreground shadow-[0_16px_34px_-22px_rgb(24_24_27/0.6),inset_0_1px_0_rgb(255_255_255/0.7)] dark:bg-zinc-800 dark:text-zinc-50 dark:shadow-[0_14px_30px_-22px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.08)]'
          : 'border-[hsl(var(--app-border)/0.22)] bg-[hsl(var(--app-panel)/0.16)] text-foreground/78 hover:-translate-y-px hover:border-[hsl(var(--app-border-strong)/0.42)] hover:bg-[hsl(var(--app-panel-strong)/0.5)] hover:text-foreground hover:shadow-[0_8px_22px_-20px_hsl(var(--foreground)/0.3)]',
      )}
      onMouseEnter={() => onPrefetchWorkspace(workspace.id)}
    >
      <button
        type="button"
        aria-label={`Select workspace ${getWorkspaceDisplayName(workspace)}`}
        data-workspace-select-button={workspace.id}
        data-workspace-id={workspace.id}
        data-workspace-selected={selected ? 'true' : 'false'}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        onFocus={() => onPrefetchWorkspace(workspace.id)}
        onClick={() => onSelectWorkspace(workspace.id)}
      >
        <span className={cn('shrink-0 rounded-full', selected ? 'h-2 w-2 bg-[hsl(var(--app-accent))]' : 'h-1.5 w-1.5 bg-muted-foreground/38')} />
        <span className={cn('min-w-0 flex-1 truncate text-[11.5px] leading-5', selected ? 'font-semibold text-foreground dark:text-zinc-50' : 'font-medium text-foreground/78')}>
          {getWorkspaceDisplayName(workspace)}
        </span>
        {metadata ? (
          <span
            className={cn('max-w-[48%] shrink-0 truncate font-mono text-[9px] leading-5 tabular-nums', selected ? 'font-medium text-[hsl(var(--app-text-soft))] dark:text-zinc-300' : 'text-muted-foreground/80')}
            title={activityTitle}
          >
            {metadata}
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Workspace actions for ${getWorkspaceDisplayName(workspace)}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.45)] hover:text-foreground active:scale-[0.96] group-hover/workspace:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal size={12} strokeWidth={2.2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => void copyAgentreeLink({ workspaceId: workspace.id })}>
            <Copy className="mr-2 h-4 w-4" />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onRequestRename(workspace)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onRequestDelete(workspace)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RepositorySelector({
  repositories,
  selectedRepository,
  onSelectRepository,
}: {
  repositories: RepoGroup[];
  selectedRepository: RepoGroup | null;
  onSelectRepository: (repositoryId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Select repository"
          data-repository-selector
          className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.62)] px-2 py-2 text-left shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel-strong)/0.7)] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.56)] text-[hsl(var(--app-accent))]">
            <FolderGit className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-foreground">
              {selectedRepository?.name ?? 'Choose repository'}
            </span>
            <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">
              {selectedRepository?.path || 'No repository selected'}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[17.5rem]">
        {repositories.map((repository) => {
          const selected = repository.id === selectedRepository?.id;
          return (
            <DropdownMenuItem
              key={repository.id}
              className="flex items-center gap-2 py-2"
              onSelect={() => onSelectRepository(repository.id)}
            >
              <FolderGit className="h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{repository.name}</span>
                {repository.path ? (
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{repository.path}</span>
                ) : null}
              </span>
              <span className="font-mono text-[9px] tabular-nums text-muted-foreground">{repository.workspaces.length}</span>
              <Check className={cn('h-4 w-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedWorkspaceNavigator({
  repoCount,
  workspaceCount,
  threadModel,
  onExpand,
}: {
  repoCount: number;
  workspaceCount: number;
  threadModel: WorkspaceThreadNavigationModel | null;
  onExpand: () => void;
}) {
  const activeThreadCount = threadModel?.threadItems.filter((thread) => !thread.done || thread.runningCount > 0).length ?? 0;
  const closedThreadCount = threadModel?.threadItems.filter((thread) => thread.done && thread.runningCount === 0).length ?? 0;
  const runningCount = threadModel?.threadItems.reduce((total, thread) => total + thread.runningCount, 0) ?? 0;

  return (
    <aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.46)] py-2 shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.025)]">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Expand threads bar"
            onClick={onExpand}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.56)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.58)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <ChevronRight size={16} strokeWidth={2.2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand threads bar</TooltipContent>
      </Tooltip>

      <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-2 overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-10 w-10 flex-col items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-panel)/0.38)] text-muted-foreground">
              <FolderGit size={14} strokeWidth={2.1} />
              <span className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums leading-none">{repoCount}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{repoCount} repositories</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-10 w-10 flex-col items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-panel)/0.38)] text-muted-foreground">
              <FolderOpen size={14} strokeWidth={2.1} />
              <span className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums leading-none">{workspaceCount}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">{workspaceCount} workspaces</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-10 w-10 flex-col items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-panel)/0.38)] text-muted-foreground">
              <ParallelThreadsIcon size={14} strokeWidth={2.1} />
              <span className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums leading-none">{activeThreadCount}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {activeThreadCount} active threads, {closedThreadCount} closed, {runningCount} running
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}

export function WorkspaceNavigator({
  selectedWorkspaceId,
  activeView,
  onSelectWorkspace,
  onOpenThread,
  onCreateThread,
  onRepositoryConnected,
  threadNavigation,
  threadsFocused: controlledThreadsFocused,
  onThreadsFocusedChange,
}: WorkspaceNavigatorProps) {
  const queryClient = useQueryClient();
  const { selectWorkspace, dispatchFocus } = useWorkspaceStore();
  const { data: workspacesData, isLoading, error, refetch } = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const renameWorkspace = useRenameWorkspace();
  const renameThreadSession = useRenameThreadSession();
  const deleteWorkspace = useDeleteWorkspace();
  const { addToast } = useToast();
  const [workspacePendingDelete, setWorkspacePendingDelete] = useState<Workspace | null>(null);
  const [workspacePendingRename, setWorkspacePendingRename] = useState<Workspace | null>(null);
  const [threadPendingRename, setThreadPendingRename] = useState<ThreadNavigationItem | null>(null);
  const [setupRequirement, setSetupRequirement] = useState<RepoPrepareActionRequiredError['requirement'] | null>(null);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [pendingPolicyPromptAfterSetup, setPendingPolicyPromptAfterSetup] = useState(false);
  const [checkpointMessage, setCheckpointMessage] = useState('WIP: pre-agentree checkpoint');
  const [localThreadsFocused, setLocalThreadsFocused] = useState(false);
  const lastWorkspaceByRepositoryRef = useRef(new Map<string, string>());
  const threadsFocused = controlledThreadsFocused ?? localThreadsFocused;
  const setThreadsFocused = onThreadsFocusedChange ?? setLocalThreadsFocused;

  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
  const repoGroups = useMemo(() => groupWorkspacesByRepo(workspaces), [workspaces]);
  const selectedRepository = useMemo(
    () => repoGroups.find((repo) => repo.workspaces.some((workspace) => workspace.id === selectedWorkspaceId))
      ?? repoGroups[0]
      ?? null,
    [repoGroups, selectedWorkspaceId],
  );
  const existingRepoPaths = useMemo(() => (
    new Set(
      repoGroups
        .map((repo) => normalizeRepoPathForComparison(repo.path))
        .filter((path): path is string => Boolean(path)),
    )
  ), [repoGroups]);
  const selectedThreadModel = threadNavigation?.workspaceId === selectedWorkspaceId ? threadNavigation : null;
  const selectedWorkspaceLastActiveAt = useMemo(
    () => selectedThreadModel?.threadItems.reduce(
      (latest, thread) => Math.max(latest, thread.lastUpdatedAt ?? 0),
      0,
    ) ?? 0,
    [selectedThreadModel?.threadItems],
  );
  const showThreadSections = activeView === 'chat';
  const showFocusedThreads = threadsFocused && showThreadSections && Boolean(selectedWorkspaceId);
  const repoCount = repoGroups.filter((repo) => repo.id !== 'unassigned').length;
  const threadBarCollapsed = showThreadSections && Boolean(selectedThreadModel?.threadBarCollapsed);

  useEffect(() => {
    if (!selectedWorkspaceId) setThreadsFocused(false);
  }, [selectedWorkspaceId, setThreadsFocused]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const repository = repoGroups.find((repo) => repo.workspaces.some((workspace) => workspace.id === selectedWorkspaceId));
    if (repository) lastWorkspaceByRepositoryRef.current.set(repository.id, selectedWorkspaceId);
  }, [repoGroups, selectedWorkspaceId]);

  useEffect(() => {
    recordPerfEvent('query.workspace-switch.navigator-model-state', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      selectedWorkspaceId,
      modelWorkspaceId: threadNavigation?.workspaceId ?? null,
      accepted: Boolean(selectedThreadModel),
      threadCount: selectedThreadModel?.threadItems.length ?? null,
      activeView,
    }, { source: 'WorkspaceNavigator' });
  }, [activeView, selectedThreadModel, selectedWorkspaceId, threadNavigation?.workspaceId]);

  const createWorkspaceForFolder = useCallback(async (
    folderPath: string,
    options?: {
      allowGitInit?: boolean;
      dirtyStrategy?: RepoDirtyStrategy;
      commitMessage?: string | null;
      promptWorktreePolicy?: boolean;
    },
  ) => {
    if (createWorkspace.isPending) return;

    try {
      const created = await createWorkspace.mutateAsync({
        folderPath,
        allowGitInit: options?.allowGitInit ?? false,
        dirtyStrategy: options?.dirtyStrategy,
        commitMessage: options?.commitMessage ?? null,
      });
      setSetupRequirement(null);
      setPendingFolderPath(null);
      setPendingPolicyPromptAfterSetup(false);
      if (!created?.id) return;

      const createdRepoPath = created.git_repo_path || created.repo_path || created.folderPath || folderPath;
      if (options?.promptWorktreePolicy && createdRepoPath) {
        onRepositoryConnected?.(createdRepoPath, created.id);
      }
      onSelectWorkspace(created.id);
      void finalizeCreatedWorkspace({
        created,
        fallbackFolderPath: folderPath,
        queryClient,
        selectWorkspace,
        dispatchFocus,
        onImportFailed: (importError) => {
          console.error('[WorkspaceNavigator] Initial commit import failed:', importError);
          addToast({
            title: 'Workspace created',
            description: 'Initial commit import failed. You can refresh or track branches from the graph.',
            variant: 'warning',
          });
        },
      });
    } catch (caught) {
      if (caught instanceof RepoPrepareActionRequiredError) {
        setPendingFolderPath(folderPath);
        setPendingPolicyPromptAfterSetup(options?.promptWorktreePolicy ?? false);
        setSetupRequirement(caught.requirement);
        setCheckpointMessage(caught.requirement.defaultCommitMessage);
        return;
      }

      addToast({
        title: 'Unable to add workspace',
        description: caught instanceof Error ? caught.message : 'Failed to create the workspace.',
        variant: 'error',
      });
    }
  }, [addToast, createWorkspace, dispatchFocus, onRepositoryConnected, onSelectWorkspace, queryClient, selectWorkspace]);

  const handleCreateRepo = useCallback(async () => {
    if (createWorkspace.isPending) return;
    const selected = await openFolderDialog({
      directory: true,
      title: 'Select Repository Folder',
    });
    const folderPath = Array.isArray(selected) ? selected[0] : selected;
    if (!folderPath || typeof folderPath !== 'string') return;

    if (existingRepoPaths.has(normalizeRepoPathForComparison(folderPath) ?? '')) {
      addToast({
        title: 'Repository already exists',
        description: 'This repo already exists. Create another workspace under the existing repo.',
        variant: 'warning',
      });
      return;
    }

    try {
      const repo = await agentClient.attachWorkspace(folderPath);
      const existingRepoWorkspaces = getWorkspacesForRepo(workspaces, repo.repo_path || folderPath);
      if (existingRepoWorkspaces.length > 0) {
        addToast({
          title: 'Repository already exists',
          description: `${existingRepoWorkspaces.length} ${existingRepoWorkspaces.length === 1 ? 'workspace is' : 'workspaces are'} already attached for this repository.`,
          variant: 'warning',
        });
        return;
      }
      await createWorkspaceForFolder(folderPath, { promptWorktreePolicy: true });
    } catch (caught) {
      addToast({
        title: 'Unable to open repository',
        description: caught instanceof Error ? caught.message : 'Failed to inspect the selected folder.',
        variant: 'error',
      });
    }
  }, [addToast, createWorkspace.isPending, createWorkspaceForFolder, existingRepoPaths, workspaces]);

  const handleAddWorkspaceToRepo = useCallback(async (folderPath: string) => {
    if (!folderPath) {
      addToast({
        title: 'Unable to add workspace',
        description: 'This repository does not have a valid path.',
        variant: 'error',
      });
      return;
    }
    await createWorkspaceForFolder(folderPath);
  }, [addToast, createWorkspaceForFolder]);

  const handleSelectRepository = useCallback((repositoryId: string) => {
    const repository = repoGroups.find((candidate) => candidate.id === repositoryId);
    if (!repository) return;

    const rememberedWorkspaceId = lastWorkspaceByRepositoryRef.current.get(repository.id);
    const targetWorkspace = repository.workspaces.find((workspace) => workspace.id === rememberedWorkspaceId)
      ?? repository.workspaces[0];
    if (targetWorkspace && targetWorkspace.id !== selectedWorkspaceId) {
      onSelectWorkspace(targetWorkspace.id);
    }
  }, [onSelectWorkspace, repoGroups, selectedWorkspaceId]);

  const continueAfterSetupRequirement = useCallback(async (options: {
    allowGitInit?: boolean;
    dirtyStrategy?: RepoDirtyStrategy;
    commitMessage?: string | null;
  }) => {
    if (!pendingFolderPath) return;
    await createWorkspaceForFolder(pendingFolderPath, {
      ...options,
      promptWorktreePolicy: pendingPolicyPromptAfterSetup,
    });
  }, [createWorkspaceForFolder, pendingFolderPath, pendingPolicyPromptAfterSetup]);

  const clearSetupRequirement = useCallback(() => {
    setSetupRequirement(null);
    setPendingFolderPath(null);
    setPendingPolicyPromptAfterSetup(false);
  }, []);

  const handleConfirmDeleteWorkspace = useCallback(async () => {
    if (!workspacePendingDelete) return;
    await deleteWorkspace.mutateAsync(workspacePendingDelete.id);
    setWorkspacePendingDelete(null);
  }, [deleteWorkspace, workspacePendingDelete]);

  const handleConfirmRenameWorkspace = useCallback(async (workspace: Workspace, name: string) => {
    await renameWorkspace.mutateAsync({ id: workspace.id, name });
    setWorkspacePendingRename(null);
  }, [renameWorkspace]);

  const handleConfirmRenameThread = useCallback(async (thread: ThreadNavigationItem, title: string) => {
    if (!selectedWorkspaceId) return;
    try {
      await renameThreadSession.mutateAsync({
        workspaceId: selectedWorkspaceId,
        threadId: thread.threadRootId,
        title,
      });
      setThreadPendingRename(null);
    } catch (caught) {
      addToast({
        title: 'Rename failed',
        description: caught instanceof Error ? caught.message : 'Failed to rename the thread.',
        variant: 'error',
      });
    }
  }, [addToast, renameThreadSession, selectedWorkspaceId]);

  const handlePrefetchWorkspace = useCallback((workspaceId: string) => {
    if (!workspaceId || !agentClient.hasRuntime()) return;

    void (async () => {
      const localNodesKey = localNodeKeys.workspace(workspaceId);
      const messagesKey = ['messages', workspaceId] as const;
      const cachedLocalNodes = queryClient.getQueryData<NonNullable<ReturnType<typeof parseLocalNode>>[]>(localNodesKey);
      const localMessages = cachedLocalNodes ?? await (async () => {
          const rows = await agentClient.listLocalNodes(workspaceId);
          const parsedRows = rows
            .map(parseLocalNode)
            .filter((row): row is NonNullable<ReturnType<typeof parseLocalNode>> => Boolean(row));
          queryClient.setQueryData(localNodesKey, parsedRows);
          return parsedRows;
        })();

      if (!queryClient.getQueryData(messagesKey)) {
        queryClient.setQueryData(messagesKey, applyLocalNodeMessages([], localMessages, workspaceId));
      }

      await queryClient.prefetchQuery({
        queryKey: threadSessionKeys.workspace(workspaceId),
        queryFn: async () => {
          const rawSessions = await agentClient.listThreadSessions(workspaceId);
          return (Array.isArray(rawSessions) ? rawSessions : [])
            .map((item) => normalizeThreadSession(item as unknown as Record<string, unknown>))
            .filter((item): item is NonNullable<ReturnType<typeof normalizeThreadSession>> => Boolean(item));
        },
        staleTime: Infinity,
      });
    })();
  }, [queryClient]);

  const viewLabel = activeView === 'chat'
    ? 'Graph'
    : activeView[0].toUpperCase() + activeView.slice(1);

  const handleThreadBarExpandedChange = useCallback((collapsed: boolean) => {
    selectedThreadModel?.onThreadBarCollapsedChange(collapsed);
  }, [selectedThreadModel]);

  if (threadBarCollapsed) {
    return (
      <CollapsedWorkspaceNavigator
        repoCount={repoCount}
        workspaceCount={workspaces.length}
        threadModel={selectedThreadModel}
        onExpand={() => handleThreadBarExpandedChange(false)}
      />
    );
  }

  return (
    <aside className="flex h-full w-[19rem] shrink-0 flex-col border-r border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-bg-muted)/0.82)] shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.025)] dark:bg-[hsl(var(--app-panel-strong)/0.46)]">
      <div className="shrink-0 border-b border-[hsl(var(--app-border)/0.56)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--app-accent))]">
              {viewLabel}
            </div>
            <div className="mt-0.5 truncate text-sm font-semibold text-foreground">Repository</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selectedThreadModel ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Collapse navigator"
                    onClick={() => handleThreadBarExpandedChange(true)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.64)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-accent-soft)/0.56)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    <ChevronLeft size={14} strokeWidth={2.2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">
                  Collapse navigator
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Add repository"
                  disabled={createWorkspace.isPending}
                  onClick={handleCreateRepo}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.64)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-accent-soft)/0.56)] hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {createWorkspace.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={2.3} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                Add repository
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <RepositorySelector
          repositories={repoGroups}
          selectedRepository={selectedRepository}
          onSelectRepository={handleSelectRepository}
        />
      </div>

      {setupRequirement?.type === 'git_init' ? (
        <div className="border-b border-[hsl(var(--app-border)/0.56)] p-3">
          <Alert className="border-amber-300/70 bg-amber-50/80 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-100">
            <GitBranch className="h-4 w-4" />
            <AlertTitle>This folder is not a Git repository yet</AlertTitle>
            <AlertDescription>
              <p>Agentree needs a Git base commit before it can add a workspace here.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void continueAfterSetupRequirement({ allowGitInit: true })}>
                  Initialize Git
                </Button>
                <Button size="sm" variant="outline" onClick={clearSetupRequirement}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <Dialog
        open={setupRequirement?.type === 'commit_checkpoint'}
        onOpenChange={(open) => {
          if (!open) clearSetupRequirement();
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[34rem]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-700 dark:text-amber-300">
                <GitBranch className="h-5 w-5" />
              </div>
              <div className="min-w-0 text-left">
                <DialogTitle>This repository has local changes</DialogTitle>
                <DialogDescription>
                  Choose a base for the new workspace.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {setupRequirement?.type === 'commit_checkpoint' ? (
            <>
              <div className="min-h-0 overflow-y-auto px-5 py-4">
                <ChangedFilesSummary files={setupRequirement.workspace.changed_files} />
                <Input
                  value={checkpointMessage}
                  onChange={(event) => setCheckpointMessage(event.target.value)}
                  placeholder="Checkpoint commit message"
                  className="mt-3"
                />
              </div>
              <DialogFooter className="border-t border-border/70 px-5 py-4">
                <Button variant="outline" onClick={clearSetupRequirement}>
                  Cancel
                </Button>
                <Button variant="outline" onClick={() => void continueAfterSetupRequirement({ dirtyStrategy: 'last-commit' })}>
                  Use last commit
                </Button>
                <Button
                  onClick={() => void continueAfterSetupRequirement({
                    dirtyStrategy: 'checkpoint',
                    commitMessage: checkpointMessage,
                  })}
                >
                  Checkpoint
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {isLoading ? (
          <div className="space-y-3 p-2">
            <div className="app-skeleton h-8 w-full" />
            <div className="app-skeleton h-24 w-full" />
            <div className="app-skeleton h-16 w-4/5" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <HardDrive className="h-5 w-5" />
            </div>
            <div className="text-sm font-semibold text-destructive">Error loading workspaces</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {error instanceof Error ? error.message : 'Failed to load workspaces'}
            </p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-[hsl(var(--app-bg-muted))] text-muted-foreground">
              <FolderGit className="h-5 w-5" />
            </div>
            <div className="text-sm font-semibold text-foreground">No repositories yet</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Add a repository to start using Agentree.
            </p>
            <Button className="mt-4 gap-2" size="sm" variant="outline" onClick={handleCreateRepo} disabled={createWorkspace.isPending}>
              {createWorkspace.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
              Add repository
            </Button>
          </div>
        ) : selectedRepository ? (
          <div className={cn(showFocusedThreads ? 'space-y-0' : 'space-y-3')}>
            {!showFocusedThreads ? (
              <section aria-labelledby="workspace-navigation-heading">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 id="workspace-navigation-heading" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/66">
                    Workspaces
                  </h2>
                  <span className="rounded bg-[hsl(var(--app-bg-muted)/0.72)] px-1.5 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-muted-foreground">
                    {selectedRepository.workspaces.length}
                  </span>
                </div>
                {selectedRepository.path ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Add workspace to ${selectedRepository.name}`}
                        disabled={createWorkspace.isPending}
                        onClick={() => void handleAddWorkspaceToRepo(selectedRepository.path)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel)/0.5)] text-muted-foreground transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.5)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {createWorkspace.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={2.3} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      Add workspace to {selectedRepository.name}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <div className="space-y-1">
                {selectedRepository.workspaces.map((workspace) => (
                  <WorkspaceRow
                    key={workspace.id}
                    workspace={workspace}
                    selected={selectedWorkspaceId === workspace.id}
                    threadCount={selectedWorkspaceId === workspace.id ? selectedThreadModel?.threadItems.length : undefined}
                    lastActiveAt={selectedWorkspaceId === workspace.id ? selectedWorkspaceLastActiveAt : undefined}
                    onSelectWorkspace={onSelectWorkspace}
                    onRequestRename={setWorkspacePendingRename}
                    onRequestDelete={setWorkspacePendingDelete}
                    onPrefetchWorkspace={handlePrefetchWorkspace}
                  />
                ))}
              </div>
              </section>
            ) : null}

            {showThreadSections && selectedWorkspaceId ? (
              <section aria-label="Threads in selected workspace">
                <WorkspaceThreadSection
                  model={selectedThreadModel}
                  onOpenThread={onOpenThread}
                  onCreateThread={onCreateThread}
                  onThreadRename={setThreadPendingRename}
                  threadsFocused={threadsFocused}
                  onThreadsFocusedChange={setThreadsFocused}
                />
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      {workspaces.length > 0 && !showFocusedThreads ? (
        <div className="flex shrink-0 items-center justify-between border-t border-[hsl(var(--app-border)/0.56)] px-3 py-2 text-[11px] text-muted-foreground">
          <span>{repoCount} repos</span>
          <span>{selectedRepository?.workspaces.length ?? 0} workspaces here</span>
        </div>
      ) : null}

      <WorkspaceDeleteDialog
        workspace={workspacePendingDelete}
        isDeleting={deleteWorkspace.isPending}
        onOpenChange={(open) => {
          if (!open && !deleteWorkspace.isPending) setWorkspacePendingDelete(null);
        }}
        onConfirm={handleConfirmDeleteWorkspace}
      />
      <WorkspaceRenameDialog
        workspace={workspacePendingRename}
        isRenaming={renameWorkspace.isPending}
        onOpenChange={(open) => {
          if (!open && !renameWorkspace.isPending) setWorkspacePendingRename(null);
        }}
        onRename={handleConfirmRenameWorkspace}
      />
      <ThreadRenameDialog
        thread={threadPendingRename}
        isRenaming={renameThreadSession.isPending}
        onOpenChange={(open) => {
          if (!open && !renameThreadSession.isPending) setThreadPendingRename(null);
        }}
        onRename={handleConfirmRenameThread}
      />
    </aside>
  );
}
