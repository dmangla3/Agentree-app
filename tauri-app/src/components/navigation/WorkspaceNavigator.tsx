import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  FolderGit,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
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
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { orderActiveThreadFamiliesNewestFirst, orderThreadFamiliesNewestFirst } from './threadNavigationHierarchy';

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

export function formatWorkspaceLastActive(
  workspace: Pick<Workspace, 'createdAt' | 'updatedAt'>,
  lastUsedAt?: number,
  options: {
    now?: Date;
    locale?: string;
    timeZone?: string;
  } = {},
): string | null {
  const lastActiveMs = Number.isFinite(lastUsedAt) && Number(lastUsedAt) > 0
    ? Number(lastUsedAt)
    : parseWorkspaceTimestamp(workspace.updatedAt) || parseWorkspaceTimestamp(workspace.createdAt);
  if (!lastActiveMs) return null;

  const lastActive = new Date(lastActiveMs);
  const now = options.now ?? new Date();
  const yearFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    timeZone: options.timeZone,
  });
  const includeYear = yearFormatter.format(lastActive) !== yearFormatter.format(now);
  return new Intl.DateTimeFormat(options.locale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone,
  }).format(lastActive);
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
}: {
  model: WorkspaceThreadNavigationModel | null;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onThreadRename: (thread: ThreadNavigationItem) => void;
}) {
  const activeThreadItems = useMemo(
    () => orderActiveThreadFamiliesNewestFirst(model?.threadItems ?? []),
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
  onThreadsFocusedChange,
}: WorkspaceNavigatorProps) {
  const queryClient = useQueryClient();
  const { selectWorkspace, dispatchFocus, lastUsedWorkspaceAt } = useWorkspaceStore();
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

  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
  const repoGroups = useMemo(() => groupWorkspacesByRepo(workspaces), [workspaces]);
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedWorkspaceRepositoryId = useMemo(
    () => repoGroups.find((repo) => repo.workspaces.some((workspace) => workspace.id === selectedWorkspaceId))?.id ?? null,
    [repoGroups, selectedWorkspaceId],
  );
  const selectedRepository = useMemo(
    () => repoGroups.find((repo) => repo.id === selectedWorkspaceRepositoryId)
      ?? repoGroups[0]
      ?? null,
    [repoGroups, selectedWorkspaceRepositoryId],
  );
  const existingRepoPaths = useMemo(() => (
    new Set(
      repoGroups
        .map((repo) => normalizeRepoPathForComparison(repo.path))
        .filter((path): path is string => Boolean(path)),
    )
  ), [repoGroups]);
  const selectedThreadModel = threadNavigation?.workspaceId === selectedWorkspaceId ? threadNavigation : null;
  const showThreadSections = activeView === 'chat';
  const repoCount = repoGroups.filter((repo) => repo.id !== 'unassigned').length;
  const threadBarCollapsed = showThreadSections && Boolean(selectedThreadModel?.threadBarCollapsed);

  useEffect(() => {
    if (!selectedWorkspaceId) onThreadsFocusedChange?.(false);
  }, [onThreadsFocusedChange, selectedWorkspaceId]);

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

  const handleWorkspaceMenuSelect = useCallback((workspaceId: string) => {
    onThreadsFocusedChange?.(false);
    onSelectWorkspace(workspaceId);
  }, [onSelectWorkspace, onThreadsFocusedChange]);

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
    <aside className="flex h-full w-[19rem] shrink-0 flex-col border-r border-[hsl(var(--app-border)/0.46)] bg-[hsl(var(--app-bg-muted)/0.72)] shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.02)] dark:bg-[hsl(var(--app-panel-strong)/0.42)]">
      <div className="shrink-0 bg-[hsl(var(--app-panel-strong)/0.72)] px-2 py-2 shadow-[inset_0_-1px_0_hsl(var(--app-border-strong)/0.54),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={selectedWorkspace && selectedRepository
                  ? `Choose workspace, current ${getWorkspaceDisplayName(selectedWorkspace)} in ${selectedRepository.name}`
                  : 'Choose workspace'}
                disabled={!selectedRepository}
                className="h-11 min-w-0 flex-1 justify-start gap-2 rounded-xl bg-[hsl(var(--app-bg-muted)/0.72)] px-2 text-foreground shadow-[0_1px_2px_-1px_hsl(var(--foreground)/0.14),inset_0_0_0_1px_hsl(var(--app-border)/0.56),inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[background-color,box-shadow,transform] duration-150 hover:bg-[hsl(var(--app-panel)/0.82)] hover:shadow-[0_2px_5px_-3px_hsl(var(--foreground)/0.28),inset_0_0_0_1px_hsl(var(--app-border-strong)/0.58)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[0_2px_5px_-3px_hsl(var(--foreground)/0.28),inset_0_0_0_1px_hsl(var(--foreground)/0.18)] active:scale-[0.96] data-[state=open]:bg-[hsl(var(--app-panel)/0.88)] data-[state=open]:shadow-[0_2px_5px_-3px_hsl(var(--foreground)/0.28),inset_0_0_0_1px_hsl(var(--app-border-strong)/0.62)]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                  <FolderGit size={14} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-bold leading-5 tracking-[-0.01em]">
                    {selectedWorkspace ? getWorkspaceDisplayName(selectedWorkspace) : 'Choose workspace'}
                  </span>
                  <span className="block truncate text-[9px] font-medium leading-3 text-muted-foreground/72">
                    {selectedRepository?.name ?? 'No repository'}
                  </span>
                </span>
                {selectedRepository ? (
                  <span className="shrink-0 rounded-md bg-[hsl(var(--app-panel-strong)/0.56)] px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
                    {selectedRepository.workspaces.length}
                  </span>
                ) : null}
                <ChevronDown size={14} strokeWidth={2.2} className="shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[14rem] rounded-lg p-1"
            >
              {repoGroups.map((repository) => {
                return (
                  <DropdownMenuSub key={repository.id}>
                    <DropdownMenuSubTrigger
                      className={cn(
                        'h-10 gap-2 rounded-md pr-2 text-xs',
                        repository.id === selectedWorkspaceRepositoryId && 'bg-[hsl(var(--app-accent-soft)/0.54)] text-foreground',
                      )}
                    >
                      <FolderGit size={14} strokeWidth={2} />
                      <span className="min-w-0 flex-1 truncate font-semibold">{repository.name}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {repository.workspaces.length}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      sideOffset={6}
                      alignOffset={-5}
                      className="min-w-[20rem] rounded-lg p-1"
                    >
                      {repository.workspaces.map((workspace) => {
                        const lastActiveLabel = formatWorkspaceLastActive(
                          workspace,
                          lastUsedWorkspaceAt[workspace.id],
                        );
                        return (
                          <div
                            key={workspace.id}
                            data-workspace-menu-item={workspace.id}
                            onPointerEnter={() => handlePrefetchWorkspace(workspace.id)}
                            className={cn(
                              'group/workspace-menu flex h-10 items-center rounded-md transition-colors duration-150',
                              workspace.id === selectedWorkspaceId
                                ? 'bg-[hsl(var(--app-accent-soft)/0.62)] text-foreground'
                                : 'hover:bg-accent hover:text-accent-foreground',
                            )}
                          >
                            <DropdownMenuItem
                              asChild
                              onSelect={() => handleWorkspaceMenuSelect(workspace.id)}
                              className="h-10 min-w-0 flex-1 gap-2 rounded-md bg-transparent px-2 text-xs focus:bg-transparent"
                            >
                              <button
                                type="button"
                                aria-label={`Select workspace ${getWorkspaceDisplayName(workspace)}`}
                                onFocus={() => handlePrefetchWorkspace(workspace.id)}
                              >
                                <FolderOpen size={14} strokeWidth={2} />
                                <span className="min-w-0 flex-1 text-left">
                                  <span className={cn(
                                    'block truncate leading-4',
                                    workspace.id === selectedWorkspaceId && 'font-semibold',
                                  )}>
                                    {getWorkspaceDisplayName(workspace)}
                                  </span>
                                  {lastActiveLabel ? (
                                    <span className="block truncate text-[9px] leading-3 text-muted-foreground tabular-nums">
                                      Last active {lastActiveLabel}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                            </DropdownMenuItem>
                            <div className="pointer-events-none flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/workspace-menu:pointer-events-auto group-hover/workspace-menu:opacity-100 group-focus-within/workspace-menu:pointer-events-auto group-focus-within/workspace-menu:opacity-100">
                              <Tooltip>
                                <DropdownMenuItem
                                  asChild
                                  onSelect={() => void copyAgentreeLink({ workspaceId: workspace.id })}
                                  className="size-10 justify-center rounded-md p-0 text-muted-foreground focus:text-foreground"
                                >
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`Copy workspace link for ${getWorkspaceDisplayName(workspace)}`}
                                    >
                                      <Copy size={14} strokeWidth={2} />
                                    </button>
                                  </TooltipTrigger>
                                </DropdownMenuItem>
                                <TooltipContent side="top" sideOffset={6}>
                                  Copy workspace link
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <DropdownMenuItem
                                  asChild
                                  onSelect={() => setWorkspacePendingRename(workspace)}
                                  className="size-10 justify-center rounded-md p-0 text-muted-foreground focus:text-foreground"
                                >
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`Rename ${getWorkspaceDisplayName(workspace)}`}
                                    >
                                      <Pencil size={14} strokeWidth={2} />
                                    </button>
                                  </TooltipTrigger>
                                </DropdownMenuItem>
                                <TooltipContent side="top" sideOffset={6}>
                                  Rename workspace
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <DropdownMenuItem
                                  asChild
                                  variant="destructive"
                                  onSelect={() => setWorkspacePendingDelete(workspace)}
                                  className="size-10 justify-center rounded-md p-0"
                                >
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`Delete ${getWorkspaceDisplayName(workspace)}`}
                                    >
                                      <Trash2 size={14} strokeWidth={2} />
                                    </button>
                                  </TooltipTrigger>
                                </DropdownMenuItem>
                                <TooltipContent side="top" sideOffset={6}>
                                  Delete workspace
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        );
                      })}
                      <DropdownMenuSeparator />
                      {repository.path ? (
                        <DropdownMenuItem
                          disabled={createWorkspace.isPending}
                          onSelect={() => void handleAddWorkspaceToRepo(repository.path)}
                          className="h-9 rounded-md text-xs"
                        >
                          {createWorkspace.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={2.3} />}
                          Add workspace
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={createWorkspace.isPending}
                onSelect={handleCreateRepo}
                className="h-9 rounded-md text-xs"
              >
                {createWorkspace.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={2.3} />}
                Add repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {selectedThreadModel ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Collapse navigator"
                  onClick={() => handleThreadBarExpandedChange(true)}
                  className="size-10 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-[hsl(var(--app-panel)/0.82)] hover:text-foreground active:scale-[0.96]"
                >
                  <ChevronLeft size={16} strokeWidth={2.2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                Collapse navigator
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
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

      <ScrollArea className="min-h-0 flex-1">
        <div className="min-h-full px-2 pb-3 pt-1">
          {isLoading ? (
            <div className="space-y-3 p-2">
              <div className="app-skeleton h-10 w-full" />
              <div className="app-skeleton h-28 w-full" />
              <div className="app-skeleton h-16 w-4/5" />
            </div>
          ) : error ? (
            <div className="flex min-h-[18rem] flex-col items-center justify-center p-4 text-center">
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
            <div className="flex min-h-[18rem] flex-col items-center justify-center p-4 text-center">
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
            <div>
              {showThreadSections && selectedWorkspaceId && selectedRepository.id === selectedWorkspaceRepositoryId ? (
                <section aria-label="Threads in selected workspace">
                  <WorkspaceThreadSection
                    model={selectedThreadModel}
                    onOpenThread={onOpenThread}
                    onCreateThread={onCreateThread}
                    onThreadRename={setThreadPendingRename}
                  />
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      </ScrollArea>

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
