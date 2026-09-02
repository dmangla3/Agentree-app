import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderGit,
  FolderOpen,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../@/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../@/components/ui/collapsible';
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
import { threadSessionKeys } from '../../hooks/useThreadSessions';
import { agentClient } from '../../lib/agentClient';
import { finalizeCreatedWorkspace } from '../../lib/finalizeCreatedWorkspace';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../../lib/perfRecorder';
import { normalizeThreadSession } from '../../lib/threadSessions';
import { resolveLocalWorkspaceRepoPath } from '../../lib/workspaceRepoPath';
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

export interface WorkspaceThreadNavigationModel {
  workspaceId: string | null;
  threadItems: ThreadNavigationItem[];
  threadHoverProjectionInput?: ThreadHoverProjectionInput;
  doneThreadsCollapsed: boolean;
  onThreadFocus: (threadRootId: string) => void;
  onThreadDoneChange: (threadRootId: string, done: boolean) => void;
  onThreadDelete?: (threadRootId: string) => void;
  onDoneThreadsCollapsedChange: (collapsed: boolean) => void;
  onCreateThread: () => void;
  createThreadDisabled?: boolean;
  createThreadDisabledReason?: string;
}

interface WorkspaceNavigatorProps {
  selectedWorkspaceId: string | null;
  activeView: 'chat' | 'flows' | 'tracking' | 'knowledge' | 'skills' | 'logins';
  onSelectWorkspace: (workspaceId: string, options?: { replace?: boolean }) => void;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onRepositoryConnected?: (repoPath: string, workspaceId: string) => void;
  threadNavigation: WorkspaceThreadNavigationModel | null;
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

function workspaceCreatedMs(workspace: Workspace): number {
  const createdAt = Date.parse(workspace.createdAt || '');
  if (Number.isFinite(createdAt)) return createdAt;
  const updatedAt = Date.parse(workspace.updatedAt || '');
  return Number.isFinite(updatedAt) ? updatedAt : 0;
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

function ThreadRow({
  thread,
  threadHoverProjectionInput,
  onOpenThread,
  onThreadDoneChange,
  onThreadDelete,
}: {
  thread: ThreadNavigationItem;
  threadHoverProjectionInput?: ThreadHoverProjectionInput;
  onOpenThread: (threadRootId: string) => void;
  onThreadDoneChange: (threadRootId: string, done: boolean) => void;
  onThreadDelete?: (threadRootId: string) => void;
}) {
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
      className={cn(
        'group/thread relative flex min-w-0 items-stretch overflow-hidden rounded-md border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.022)] transition-[background-color,border-color,box-shadow,opacity] duration-150',
        thread.current
          ? 'border-[hsl(var(--app-accent)/0.32)] bg-[hsl(var(--app-accent-soft)/0.38)] text-[hsl(var(--app-accent))] shadow-[inset_2px_0_0_hsl(var(--app-accent)/0.48),inset_0_1px_0_hsl(var(--foreground)/0.028)]'
          : 'border-[hsl(var(--app-border)/0.34)] bg-[hsl(var(--app-panel)/0.3)] text-foreground hover:border-[hsl(var(--app-border-strong)/0.56)] hover:bg-[hsl(var(--app-panel)/0.5)]',
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
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              thread.current
                ? 'bg-[hsl(var(--app-accent))]'
                : thread.runningCount > 0
                  ? 'bg-[hsl(var(--app-warning))]'
                  : thread.done
                    ? 'bg-muted-foreground/30'
                    : 'bg-muted-foreground/45',
            )}
          />
          <span className="min-w-0 truncate text-[11px] font-semibold leading-none">
            {thread.label}
          </span>
          {thread.current ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-accent)/0.13)] px-1 py-0.5 text-[8px] font-bold leading-none">
              Current
            </span>
          ) : null}
          {thread.runningCount > 0 ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-warning)/0.12)] px-1 py-0.5 text-[8px] font-bold leading-none text-[hsl(var(--app-warning))]">
              {activityLabel}
            </span>
          ) : thread.done ? (
            <span className="shrink-0 rounded bg-[hsl(var(--app-bg-muted))] px-1 py-0.5 text-[8px] font-bold leading-none text-muted-foreground">
              Done
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-[9px] leading-none text-muted-foreground">
          <span className="font-mono text-foreground/70">{baseCommitLabel}</span>
          <span className="px-1 text-muted-foreground/45">·</span>
          {metadata}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}
        aria-label={thread.done ? `Reopen thread ${thread.label}` : `Mark done ${thread.label}`}
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
          <DropdownMenuItem onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}>
            {thread.done ? 'Reopen thread' : 'Mark as done'}
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
}: {
  model: WorkspaceThreadNavigationModel | null;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
}) {
  const activeThreadItems = useMemo(
    () => model?.threadItems.filter((thread) => !thread.done || thread.runningCount > 0) ?? [],
    [model?.threadItems],
  );
  const doneThreadItems = useMemo(
    () => model?.threadItems.filter((thread) => thread.done && thread.runningCount === 0) ?? [],
    [model?.threadItems],
  );
  const runningCount = useMemo(
    () => model?.threadItems.reduce((total, thread) => total + thread.runningCount, 0) ?? 0,
    [model?.threadItems],
  );

  if (!model) {
    return (
      <div className="ml-6 rounded-lg border border-dashed border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-bg)/0.34)] px-2.5 py-2 text-[11px] text-muted-foreground">
        Loading thread index...
      </div>
    );
  }

  return (
    <div className="ml-6 space-y-2 rounded-lg border border-[hsl(var(--app-border)/0.46)] bg-[hsl(var(--app-bg)/0.34)] p-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)]">
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.34)] pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          <ParallelThreadsIcon size={12} strokeWidth={2.1} />
          <span>Threads</span>
          <span className="rounded bg-[hsl(var(--app-bg-muted)/0.72)] px-1.5 py-0.5 font-mono text-[8px] tracking-normal text-foreground/70">
            {runningCount} running
          </span>
        </div>
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
      <div className="space-y-1">
        {[...activeThreadItems].reverse().map((thread) => (
          <MemoThreadRow
            key={thread.threadRootId}
            thread={thread}
            threadHoverProjectionInput={model.threadHoverProjectionInput}
            onOpenThread={onOpenThread}
            onThreadDoneChange={model.onThreadDoneChange}
            onThreadDelete={model.onThreadDelete}
          />
        ))}
      </div>
      {doneThreadItems.length > 0 ? (
        <div className="border-t border-[hsl(var(--app-border)/0.38)] pt-2">
          <button
            type="button"
            aria-expanded={!model.doneThreadsCollapsed}
            onClick={() => model.onDoneThreadsCollapsedChange(!model.doneThreadsCollapsed)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-[hsl(var(--app-panel)/0.56)] hover:text-foreground"
          >
            <span>Done threads</span>
            <span className="font-mono tracking-normal">{doneThreadItems.length}</span>
          </button>
          {!model.doneThreadsCollapsed ? (
            <div className="mt-1 space-y-1">
              {[...doneThreadItems].reverse().map((thread) => (
                <MemoThreadRow
                  key={thread.threadRootId}
                  thread={thread}
                  threadHoverProjectionInput={model.threadHoverProjectionInput}
                  onOpenThread={onOpenThread}
                  onThreadDoneChange={model.onThreadDoneChange}
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
  threadModel,
  onSelectWorkspace,
  onOpenThread,
  onCreateThread,
  onRequestRename,
  onRequestDelete,
  onPrefetchWorkspace,
  showThreadSection,
}: {
  workspace: Workspace;
  selected: boolean;
  threadModel: WorkspaceThreadNavigationModel | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onRequestRename: (workspace: Workspace) => void;
  onRequestDelete: (workspace: Workspace) => void;
  onPrefetchWorkspace: (workspaceId: string) => void;
  showThreadSection: boolean;
}) {
  const [isOpen, setIsOpen] = useState(selected);
  const selectedWorkspaceKey = selected ? workspace.id : null;

  useEffect(() => {
    if (selectedWorkspaceKey) setIsOpen(true);
  }, [selectedWorkspaceKey]);

  const hasThreadModel = selected && Boolean(threadModel);
  const activeCount = hasThreadModel ? threadModel!.threadItems.filter((thread) => !thread.done || thread.runningCount > 0).length : null;
  const doneCount = hasThreadModel ? threadModel!.threadItems.filter((thread) => thread.done && thread.runningCount === 0).length : null;
  const runningCount = hasThreadModel ? threadModel!.threadItems.reduce((total, thread) => total + thread.runningCount, 0) : null;
  const status = workspace.connection_status ?? workspace.connectionStatus ?? workspace.sync_status ?? workspace.syncStatus ?? null;
  const statusLabel = status && status !== 'connected' && status !== 'synced' ? String(status).replace(/_/g, ' ') : null;
  const createdAt = workspaceCreatedMs(workspace);
  const createdDate = createdAt > 0 ? new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;

  return (
    <div className="space-y-1">
      <div
        onMouseEnter={() => onPrefetchWorkspace(workspace.id)}
        className={cn(
          'group/workspace flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)] transition-[background-color,border-color,box-shadow,color] duration-150',
          selected
            ? 'border-[hsl(var(--app-accent)/0.3)] bg-[linear-gradient(180deg,hsl(var(--app-accent-soft)/0.42),hsl(var(--app-panel)/0.64))] text-[hsl(var(--app-accent))] shadow-[inset_2px_0_0_hsl(var(--app-accent)/0.52),inset_0_1px_0_hsl(var(--foreground)/0.035)]'
            : 'border-[hsl(var(--app-border)/0.4)] bg-[hsl(var(--app-panel)/0.34)] text-foreground hover:border-[hsl(var(--app-border-strong)/0.56)] hover:bg-[hsl(var(--app-panel)/0.62)]',
        )}
      >
        {selected ? (
          <button
            type="button"
            aria-label={isOpen ? `Collapse workspace ${getWorkspaceDisplayName(workspace)}` : `Expand workspace ${getWorkspaceDisplayName(workspace)}`}
            onClick={() => setIsOpen((current) => !current)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.45)] hover:text-foreground active:scale-[0.96]"
          >
            {isOpen ? <ChevronDown size={13} strokeWidth={2.2} /> : <ChevronRight size={13} strokeWidth={2.2} />}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-label={`Select workspace ${getWorkspaceDisplayName(workspace)}`}
          data-workspace-select-button={workspace.id}
          data-workspace-id={workspace.id}
          data-workspace-selected={selected ? 'true' : 'false'}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onFocus={() => onPrefetchWorkspace(workspace.id)}
          onClick={() => onSelectWorkspace(workspace.id)}
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', selected ? 'bg-[hsl(var(--app-accent))]' : 'bg-muted-foreground/45')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-semibold leading-none">{getWorkspaceDisplayName(workspace)}</span>
            <span className="mt-0.5 block truncate text-[9px] leading-none text-muted-foreground">
              {hasThreadModel
                ? `${activeCount} active · ${doneCount} done · ${runningCount} running`
                : selected && showThreadSection
                  ? 'Loading thread index'
                  : createdDate
                    ? `Created ${createdDate}`
                    : 'Thread index loads when selected'}
              {statusLabel ? ` · ${statusLabel}` : ''}
            </span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Workspace actions for ${getWorkspaceDisplayName(workspace)}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.45)] hover:text-foreground active:scale-[0.96] group-hover/workspace:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal size={12} strokeWidth={2.2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
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
      {selected && isOpen && showThreadSection ? (
        <WorkspaceThreadSection
          model={threadModel}
          onOpenThread={onOpenThread}
          onCreateThread={onCreateThread}
        />
      ) : null}
    </div>
  );
}

function RepoItem({
  repo,
  selectedWorkspaceId,
  threadModel,
  onSelectWorkspace,
  onOpenThread,
  onCreateThread,
  onAddWorkspaceToRepo,
  onRequestRenameWorkspace,
  onRequestDeleteWorkspace,
  onPrefetchWorkspace,
  showThreadSections,
}: {
  repo: RepoGroup;
  selectedWorkspaceId: string | null;
  threadModel: WorkspaceThreadNavigationModel | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenThread: (threadRootId: string) => void;
  onCreateThread: () => void;
  onAddWorkspaceToRepo: (folderPath: string) => void;
  onRequestRenameWorkspace: (workspace: Workspace) => void;
  onRequestDeleteWorkspace: (workspace: Workspace) => void;
  onPrefetchWorkspace: (workspaceId: string) => void;
  showThreadSections: boolean;
}) {
  const hasSelectedWorkspace = repo.workspaces.some((workspace) => workspace.id === selectedWorkspaceId);
  const [isOpen, setIsOpen] = useState(hasSelectedWorkspace);
  const selectedWorkspaceKey = hasSelectedWorkspace ? selectedWorkspaceId : null;
  const isUnassigned = repo.id === 'unassigned';

  useEffect(() => {
    if (selectedWorkspaceKey) setIsOpen(true);
  }, [selectedWorkspaceKey]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          'rounded-xl border p-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.026)] transition-[background-color,border-color,box-shadow] duration-150',
          hasSelectedWorkspace
            ? 'border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.62),hsl(var(--app-panel)/0.42))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]'
            : 'border-[hsl(var(--app-border)/0.36)] bg-[hsl(var(--app-panel)/0.24)] hover:border-[hsl(var(--app-border)/0.54)] hover:bg-[hsl(var(--app-panel)/0.38)]',
        )}
      >
        <div className="flex items-center gap-1 rounded-lg px-1.5 py-1.5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-repo-trigger={repo.id}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} repository ${repo.name}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-[background-color,transform] duration-150 active:scale-[0.99]"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--app-bg-muted)/0.42)] text-muted-foreground">
                {isOpen ? <ChevronDown size={14} strokeWidth={2.2} /> : <ChevronRight size={14} strokeWidth={2.2} />}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.38)] bg-[hsl(var(--app-panel-strong)/0.56)] text-[hsl(var(--app-accent))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
                <FolderGit className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold leading-none text-foreground">{repo.name}</span>
                {repo.path ? (
                  <span className="mt-1 block truncate text-[10px] leading-none text-muted-foreground">{repo.path}</span>
                ) : null}
              </span>
              <span className="rounded bg-[hsl(var(--app-bg-muted)/0.72)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-muted-foreground">
                {repo.workspaces.length}
              </span>
            </button>
          </CollapsibleTrigger>
          {!isUnassigned ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Add workspace to ${repo.name}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.45)] hover:text-foreground active:scale-[0.96]"
                  onClick={() => onAddWorkspaceToRepo(repo.path)}
                >
                  <Plus size={13} strokeWidth={2.3} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                Add workspace to {repo.name}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <CollapsibleContent>
          <div className="ml-4 space-y-1.5 border-l border-[hsl(var(--app-border)/0.42)] pb-1.5 pl-2 pr-1">
            {repo.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                selected={selectedWorkspaceId === workspace.id}
                threadModel={selectedWorkspaceId === workspace.id ? threadModel : null}
                onSelectWorkspace={onSelectWorkspace}
                onOpenThread={onOpenThread}
                onCreateThread={onCreateThread}
                onRequestRename={onRequestRenameWorkspace}
                onRequestDelete={onRequestDeleteWorkspace}
                onPrefetchWorkspace={onPrefetchWorkspace}
                showThreadSection={showThreadSections}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
}: WorkspaceNavigatorProps) {
  const queryClient = useQueryClient();
  const { selectWorkspace, dispatchFocus } = useWorkspaceStore();
  const { data: workspacesData, isLoading, error, refetch } = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const renameWorkspace = useRenameWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const { addToast } = useToast();
  const [workspacePendingDelete, setWorkspacePendingDelete] = useState<Workspace | null>(null);
  const [workspacePendingRename, setWorkspacePendingRename] = useState<Workspace | null>(null);
  const [setupRequirement, setSetupRequirement] = useState<RepoPrepareActionRequiredError['requirement'] | null>(null);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [pendingPolicyPromptAfterSetup, setPendingPolicyPromptAfterSetup] = useState(false);
  const [checkpointMessage, setCheckpointMessage] = useState('WIP: pre-agentree checkpoint');

  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
  const repoGroups = useMemo(() => groupWorkspacesByRepo(workspaces), [workspaces]);
  const existingRepoPaths = useMemo(() => (
    new Set(
      repoGroups
        .map((repo) => normalizeRepoPathForComparison(repo.path))
        .filter((path): path is string => Boolean(path)),
    )
  ), [repoGroups]);
  const selectedThreadModel = threadNavigation?.workspaceId === selectedWorkspaceId ? threadNavigation : null;
  const showThreadSections = activeView === 'chat';

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

  const handleConfirmDeleteWorkspace = useCallback(async () => {
    if (!workspacePendingDelete) return;
    await deleteWorkspace.mutateAsync(workspacePendingDelete.id);
    setWorkspacePendingDelete(null);
  }, [deleteWorkspace, workspacePendingDelete]);

  const handleConfirmRenameWorkspace = useCallback(async (workspace: Workspace, name: string) => {
    await renameWorkspace.mutateAsync({ id: workspace.id, name });
    setWorkspacePendingRename(null);
  }, [renameWorkspace]);

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

  const viewLabel = activeView === 'chat' ? 'Graph' : activeView[0].toUpperCase() + activeView.slice(1);

  return (
    <aside className="flex h-full w-[19rem] shrink-0 flex-col border-r border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.46)] shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.025)]">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.56)] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--app-accent))]">
            {viewLabel}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-foreground">Workspaces</div>
        </div>
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

      {setupRequirement ? (
        <div className="border-b border-[hsl(var(--app-border)/0.56)] p-3">
          {setupRequirement.type === 'git_init' ? (
            <Alert className="border-amber-300/70 bg-amber-50/80 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-100">
              <GitBranch className="h-4 w-4" />
              <AlertTitle>This folder is not a Git repository yet</AlertTitle>
              <AlertDescription>
                <p>Agentree needs a Git base commit before it can add a workspace here.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void continueAfterSetupRequirement({ allowGitInit: true })}>
                    Initialize Git
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setSetupRequirement(null)}>
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-amber-300/70 bg-amber-50/80 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-100">
              <GitBranch className="h-4 w-4" />
              <AlertTitle>This repository has local changes</AlertTitle>
              <AlertDescription>
                <p>Choose a base for the new workspace.</p>
                <ChangedFilesSummary files={setupRequirement.workspace.changed_files} />
                <Input
                  value={checkpointMessage}
                  onChange={(event) => setCheckpointMessage(event.target.value)}
                  placeholder="Checkpoint commit message"
                  className="mt-2 border-amber-200 bg-white dark:bg-background"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void continueAfterSetupRequirement({
                      dirtyStrategy: 'checkpoint',
                      commitMessage: checkpointMessage,
                    })}
                  >
                    Checkpoint
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void continueAfterSetupRequirement({ dirtyStrategy: 'last-commit' })}>
                    Use last commit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSetupRequirement(null)}>
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      ) : null}

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
        ) : (
          <div className="space-y-1.5">
            {repoGroups.map((repo) => (
              <RepoItem
                key={repo.id}
                repo={repo}
                selectedWorkspaceId={selectedWorkspaceId}
                threadModel={selectedThreadModel}
                onSelectWorkspace={onSelectWorkspace}
                onOpenThread={onOpenThread}
                onCreateThread={onCreateThread}
                onAddWorkspaceToRepo={handleAddWorkspaceToRepo}
                onRequestRenameWorkspace={setWorkspacePendingRename}
                onRequestDeleteWorkspace={setWorkspacePendingDelete}
                onPrefetchWorkspace={handlePrefetchWorkspace}
                showThreadSections={showThreadSections}
              />
            ))}
          </div>
        )}
      </div>

      {workspaces.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-[hsl(var(--app-border)/0.56)] px-3 py-2 text-[11px] text-muted-foreground">
          <span>{repoGroups.filter((repo) => repo.id !== 'unassigned').length} repos</span>
          <span>{workspaces.length} workspaces</span>
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
    </aside>
  );
}
