import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal, Loader2, Files, GitBranch } from 'lucide-react';
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
import { OpenCommitTerminalButton } from '../../OpenCommitTerminalButton';
import { CommitActionButton, commitActionIconClassName } from '../../CommitActionButton';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';
import { useAgentreeSurface } from '../../graph/surfaceCapabilities';

interface ChatCommitCardProps extends SharedNodeProps {
  compact?: boolean;
}

export const ChatCommitCard = memo(({
  entity,
  isFocused,
  isSelected,
  onFocus,
  onSelect,
  onContextMenu,
  compact = false,
}: ChatCommitCardProps) => {
  const { capabilities } = useAgentreeSurface();
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
    expanded && capabilities.canMutate ? repoPath : null,
    expanded && capabilities.canMutate ? parentCommit : null,
    expanded && capabilities.canMutate ? nodeCommit : null,
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
      accentColor={ROLE_COLORS.commit_message.accent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        ROLE_COLORS.commit_message.bg,
        ROLE_COLORS.commit_message.border,
        compact && isFocused && 'border-[hsl(var(--app-selection)/0.68)] bg-[hsl(var(--app-selection)/0.08)] shadow-[0_14px_34px_-28px_hsl(var(--foreground)/0.38)]',
        compact && isSelected && !isFocused && 'border-[hsl(var(--app-selection)/0.62)] bg-[hsl(var(--app-selection)/0.07)] shadow-[0_10px_28px_-24px_hsl(var(--foreground)/0.3)]'
      )}
    >
      <div className="flex min-w-0 max-w-full flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {/* Compact Icon */}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-graph-commit)/0.22)] bg-[hsl(var(--app-graph-commit)/0.09)] text-[hsl(var(--app-graph-commit))]">
            <GitCommitHorizontal size={14} strokeWidth={2} />
          </div>

          {/* Compact Content */}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <code
                data-design-typography="soft-label-bold"
                className="inline-flex items-center gap-0.5 rounded border border-[hsl(var(--app-graph-commit)/0.2)] bg-[hsl(var(--app-graph-commit)/0.08)] px-1 py-0.5 font-mono text-[10px] font-medium text-[hsl(var(--app-graph-commit))]"
                title={nodeCommit || undefined}
              >
                {entity.shortSha}
                <CopyCommitShaButton commitSha={nodeCommit} className="h-3.5 w-3.5 text-[hsl(var(--app-graph-commit)/0.72)]" />
              </code>
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
                  <span data-design-typography="soft-on-color" className="inline-flex items-center rounded-md bg-[hsl(var(--app-graph-commit))] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(40_24%_96%)]">
                    HEAD
                  </span>
                )}
                {primaryBranch && (
                  <span
                    data-design-typography="soft-label"
                    className="inline-flex max-w-[160px] items-center gap-1 rounded-md border border-[hsl(var(--app-graph-agent)/0.24)] bg-[hsl(var(--app-graph-agent)/0.08)] px-2 py-0.5 text-[9px] font-medium text-[hsl(var(--app-graph-agent))]"
                    title={otherBranches.map((pointer: BranchPointer) => pointer.name).join(', ')}
                  >
                    <GitBranch size={9} />
                    <span className="truncate">{primaryBranch.name}</span>
                    {extraBranchCount > 0 ? <span className="text-[hsl(var(--app-graph-agent)/0.72)]">+{extraBranchCount}</span> : null}
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
                  <div className="flex items-center gap-1 font-medium text-muted-foreground">
                    <Files size={10} />
                    <span>{fileCount} {fileCount === 1 ? 'file' : 'files'} changed</span>
                  </div>
                  {(totalAdditions > 0 || totalDeletions > 0) && (
                    <div className="flex items-center gap-1.5 font-medium">
                      {totalAdditions > 0 && <span className="text-[hsl(var(--app-success))]">+{totalAdditions}</span>}
                      {totalDeletions > 0 && <span className="text-[hsl(var(--app-danger))]">-{totalDeletions}</span>}
                    </div>
                  )}
                  {statusSummary && statusSummary.length > 0 && (
                    <span className="text-[9px] text-muted-foreground/70">({statusSummary.join(', ')})</span>
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
            {capabilities.canMutate ? (
              <>
                <OpenCommitTerminalButton
                  repoPath={repoPath}
                  commitSha={nodeCommit}
                  label={entity.preview}
                />
                <CommitCheckoutButton
                  repoPath={repoPath}
                  commitSha={nodeCommit}
                />
              </>
            ) : null}
            {capabilities.canMutate && parentCommit && nodeCommit ? (
              <CommitActionButton
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setExpanded((current) => !current);
                }}
              >
                {expanded
                  ? <ChevronDown className={commitActionIconClassName()} />
                  : <ChevronRight className={commitActionIconClassName()} />}
                <FileCode2 className={commitActionIconClassName()} />
                {expanded ? 'Hide diff' : 'Show diff'}
              </CommitActionButton>
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
