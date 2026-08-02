import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal, Loader2, Files, GitBranch, Layers3 } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { useDiffNodes } from '../../../hooks/useDiff';
import { useMessages } from '../../../hooks/useMessages';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { buildMessageMap, getRepoPathFromWorkspace, resolveParentCommit } from '../../../lib/gitNodeUtils';
import { FileDiffPanel } from '../../diff/FileDiffPanel';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { CommitCheckoutButton } from '../../CommitCheckoutButton';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

interface ChatCommitCardProps extends SharedNodeProps {
  compact?: boolean;
}

export const ChatCommitCard = memo(({
  entity,
  isFocused,
  isSelected,
  scopeColor,
  scopeName,
  onFocus,
  onSelect,
  onContextMenu,
  compact = false,
}: ChatCommitCardProps) => {
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: messages = [] } = useMessages(selectedWorkspaceId);
  const [expanded, setExpanded] = useState(false);

  const workspace = useMemo(
    () => workspaces.find((item) => item.id === entity.message?.workspaceId) ?? null,
    [workspaces, entity.message?.workspaceId]
  );
  const repoPath = useMemo(() => getRepoPathFromWorkspace(workspace), [workspace]);
  const messageMap = useMemo(() => buildMessageMap(messages), [messages]);

  const branchPointers = entity.message?.branchPointers || [];
  const executionData = ((entity.message?.execution_data as any) || {}) as Record<string, any>;
  const meta = (executionData.meta || {}) as Record<string, any>;
  const hasHead = branchPointers.some((p: BranchPointer) => p.name === 'HEAD');
  const otherBranches = branchPointers.filter((p: BranchPointer) => p.name !== 'HEAD');
  const primaryBranch = otherBranches[0] ?? null;
  const extraBranchCount = Math.max(0, otherBranches.length - 1);
  const nodeCommit = getMessageOutputCommitSha(entity.message);
  const parentCommit = resolveParentCommit(entity.message, messageMap, workspace?.base_commit_sha ?? null);
  const precomputedFileCount = typeof meta.files_changed_count === 'number'
    ? meta.files_changed_count
    : typeof executionData.files_changed_count === 'number'
      ? executionData.files_changed_count
      : Array.isArray(executionData.files_changed)
        ? executionData.files_changed.length
        : null;
  const precomputedAdditions = typeof meta.total_additions === 'number'
    ? meta.total_additions
    : Array.isArray(executionData.files_changed)
      ? executionData.files_changed.reduce((sum: number, file: any) => sum + (typeof file?.additions === 'number' ? file.additions : 0), 0)
      : null;
  const precomputedDeletions = typeof meta.total_deletions === 'number'
    ? meta.total_deletions
    : Array.isArray(executionData.files_changed)
      ? executionData.files_changed.reduce((sum: number, file: any) => sum + (typeof file?.deletions === 'number' ? file.deletions : 0), 0)
      : null;
  const precomputedFilesAdded = typeof meta.files_added === 'number' ? meta.files_added : null;
  const precomputedFilesModified = typeof meta.files_modified === 'number' ? meta.files_modified : null;
  const precomputedFilesDeleted = typeof meta.files_deleted === 'number' ? meta.files_deleted : null;
  const shouldFetchDiffStats = precomputedFileCount === null;

  const { data: diffStatsResult, isLoading: isLoadingStats } = useDiffNodes(
    shouldFetchDiffStats ? repoPath : null,
    shouldFetchDiffStats ? parentCommit : null,
    shouldFetchDiffStats ? nodeCommit : null,
    false
  );

  const { data: diffResult, isLoading: isLoadingDiff } = useDiffNodes(
    expanded ? repoPath : null,
    expanded ? parentCommit : null,
    expanded ? nodeCommit : null,
    true
  );

  const fileCount = precomputedFileCount ?? diffStatsResult?.files.length ?? 0;
  const totalAdditions = precomputedAdditions ?? diffStatsResult?.stats?.total_additions ?? 0;
  const totalDeletions = precomputedDeletions ?? diffStatsResult?.stats?.total_deletions ?? 0;
  const statusSummary = (() => {
    if (
      precomputedFilesAdded !== null ||
      precomputedFilesModified !== null ||
      precomputedFilesDeleted !== null
    ) {
      const items: string[] = [];
      if ((precomputedFilesAdded ?? 0) > 0) items.push(`${precomputedFilesAdded} added`);
      if ((precomputedFilesModified ?? 0) > 0) items.push(`${precomputedFilesModified} modified`);
      if ((precomputedFilesDeleted ?? 0) > 0) items.push(`${precomputedFilesDeleted} deleted`);
      return items;
    }
    if (!diffStatsResult?.stats) return null;
    const { files_added, files_modified, files_deleted } = diffStatsResult.stats;
    const items: string[] = [];
    if (files_added > 0) items.push(`${files_added} added`);
    if (files_modified > 0) items.push(`${files_modified} modified`);
    if (files_deleted > 0) items.push(`${files_deleted} deleted`);
    return items;
  })();

  return (
    <ChatCardWrapper
      focusTargetId={entity.focusMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      accentColor={ROLE_COLORS.commit_message.accent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        ROLE_COLORS.commit_message.bg,
        ROLE_COLORS.commit_message.border,
        compact && isFocused && 'border-indigo-500/60 bg-indigo-50/80 dark:border-indigo-400/60 dark:bg-indigo-950/30 shadow-lg',
        compact && isSelected && !isFocused && 'border-blue-500/70 bg-blue-50/80 dark:border-blue-400/70 dark:bg-blue-950/30 shadow-md'
      )}
    >
      <div className="flex min-w-0 max-w-full flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {/* Compact Icon */}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-200/60 bg-gradient-to-br from-emerald-100 to-teal-50 text-emerald-600 shadow-sm dark:border-emerald-800 dark:from-emerald-950/50 dark:to-teal-950/40 dark:text-emerald-400">
            <GitCommitHorizontal size={14} strokeWidth={2} />
          </div>

          {/* Compact Content */}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <code
                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400 text-[10px] font-bold font-mono"
                title={nodeCommit || undefined}
              >
                {entity.shortSha}
                <CopyCommitShaButton commitSha={nodeCommit} className="h-3.5 w-3.5 text-emerald-700/70 dark:text-emerald-300/70" />
              </code>
              {scopeName && (
                <span
                  className="inline-flex min-w-0 max-w-[180px] items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title={scopeName}
                >
                  <Layers3 size={9} strokeWidth={2.5} className="shrink-0" style={scopeColor ? { color: scopeColor } : undefined} />
                  <span className="truncate">{scopeName}</span>
                </span>
              )}
              <span className="min-w-0 break-words text-[11px] text-muted-foreground">
                {entity.authorName}
              </span>
              <span className="text-[10px] text-muted-foreground/60">
                {entity.authoredAt
                  ? new Date(entity.authoredAt).toLocaleDateString([], { month: 'short', day: 'numeric' })
                  : null
                }
              </span>
            </div>
            <div className="break-words text-[12px] font-medium text-foreground leading-tight">
              {entity.preview}
            </div>
            {(hasHead || primaryBranch) && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {hasHead && (
                  <span className="inline-flex items-center rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow-sm">
                    HEAD
                  </span>
                )}
                {primaryBranch && (
                  <span
                    className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-sky-200/80 bg-sky-100/90 px-2 py-0.5 text-[9px] font-semibold text-sky-700 shadow-sm dark:border-sky-800/80 dark:bg-sky-950/60 dark:text-sky-300"
                    title={otherBranches.map((pointer: BranchPointer) => pointer.name).join(', ')}
                  >
                    <GitBranch size={9} />
                    <span className="truncate">{primaryBranch.name}</span>
                    {extraBranchCount > 0 ? <span className="text-sky-500/80 dark:text-sky-300/80">+{extraBranchCount}</span> : null}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              {isLoadingStats ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" />
                  Loading diff stats...
                </span>
              ) : fileCount > 0 ? (
                <>
                  <div className="flex items-center gap-1 font-medium text-slate-600 dark:text-slate-300">
                    <Files size={10} />
                    <span>{fileCount} {fileCount === 1 ? 'file' : 'files'} changed</span>
                  </div>
                  {(totalAdditions > 0 || totalDeletions > 0) && (
                    <div className="flex items-center gap-1.5 font-medium">
                      {totalAdditions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>}
                      {totalDeletions > 0 && <span className="text-red-500 dark:text-red-400">-{totalDeletions}</span>}
                    </div>
                  )}
                  {statusSummary && statusSummary.length > 0 && (
                    <span className="text-[9px] text-slate-400">({statusSummary.join(', ')})</span>
                  )}
                </>
              ) : parentCommit && nodeCommit ? (
                <span>No file changes</span>
              ) : (
                <span>Diff unavailable</span>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CommitCheckoutButton
              repoPath={repoPath}
              commitSha={nodeCommit}
            />
            {parentCommit && nodeCommit ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setExpanded((current) => !current);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-200/70 bg-white/70 px-2 py-1 text-[10px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 dark:border-emerald-800/70 dark:bg-slate-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <FileCode2 size={12} />
                {expanded ? 'Hide diff' : 'Show diff'}
              </button>
            ) : null}
          </div>
        </div>

        {expanded ? (
          <div
            className="min-w-0 max-w-full space-y-2 border-t border-border/50 pt-3"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            {isLoadingDiff ? (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                Loading commit diff...
              </div>
            ) : diffResult?.files && diffResult.files.length > 0 ? (
              diffResult.files.map((file) => (
                <FileDiffPanel
                  key={file.path}
                  fileDiff={file}
                  fromLabel={parentCommit?.slice(0, 8) || 'Before'}
                  toLabel={nodeCommit?.slice(0, 8) || 'After'}
                  defaultExpanded={false}
                  className="bg-background/60"
                />
              ))
            ) : (
              <div className="rounded-md border border-border/60 bg-background/40 px-3 py-3 text-sm text-muted-foreground">
                No diff details available for this commit.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </ChatCardWrapper>
  );
});

ChatCommitCard.displayName = 'ChatCommitCard';
