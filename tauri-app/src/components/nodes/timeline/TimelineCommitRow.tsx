import { memo } from 'react';
import { GitCommitHorizontal, User, Files, GitBranch } from 'lucide-react';
import { TimelineRowWrapper } from './TimelineRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { Badge } from '../../../../@/components/ui/badge';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { CommitCheckoutButton } from '../../CommitCheckoutButton';
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { getRepoPathFromWorkspace } from '../../../lib/gitNodeUtils';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

export const TimelineCommitRow = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  scopeColor,
  showSelectionControl,
  disableHoverCard,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const { data: workspaces = [] } = useWorkspaces();
  const workspace = workspaces.find((item) => item.id === entity.message?.workspaceId) ?? null;
  const repoPath = getRepoPathFromWorkspace(workspace);
  const commitSha = getMessageOutputCommitSha(entity.message);
  const timestamp = entity.authoredAt
    ? new Date(entity.authoredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : entity.message?.createdAt
      ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '--:--';

  const branchPointers = entity.message?.branchPointers || [];
  const hasHead = branchPointers.some((p: BranchPointer) => p.name === 'HEAD');
  const otherBranches = branchPointers.filter((p: BranchPointer) => p.name !== 'HEAD');
  const isExternal = !!entity.importedFromRef;
  const filesChanged = ((entity.message?.execution_data as any)?.files_changed || []) as Array<{ additions?: number; deletions?: number; status?: string }>;
  const totalAdditions = filesChanged.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = filesChanged.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const fileCount = entity.commitCount || filesChanged.length;

  const statusSummary = (() => {
    let added = 0; let modified = 0; let deleted = 0;
    filesChanged.forEach((f) => {
      if (f.status === 'added' || f.status === 'A') added++;
      else if (f.status === 'deleted' || f.status === 'D') deleted++;
      else modified++;
    });
    const items: string[] = [];
    if (added > 0) items.push(`${added} added`);
    if (modified > 0) items.push(`${modified} modified`);
    if (deleted > 0) items.push(`${deleted} deleted`);
    return items;
  })();

  return (
    <TimelineRowWrapper
      rowId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      disableHoverCard={disableHoverCard}
      hoverCardContent={hoverCardContent}
      className={cn(
        ROLE_COLORS.commit_message.bg,
        ROLE_COLORS.commit_message.border,
        "border mx-2"
      )}
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 whitespace-normal break-words leading-snug flex-1 min-w-0 line-clamp-2">
          {entity.preview}
        </p>

        <div className="flex flex-wrap items-center gap-2 mt-1 gap-y-1 text-[10px] text-slate-500 w-full">
          <div className="flex min-w-0 items-center gap-1 p-0.5 px-1 bg-emerald-100 dark:bg-emerald-900/40 rounded text-emerald-700">
            <GitCommitHorizontal size={10} />
            <span className="font-mono text-[9px]">{entity.shortSha}</span>
            <CopyCommitShaButton commitSha={commitSha} className="h-3.5 w-3.5 text-emerald-700/70 dark:text-emerald-300/70" />
          </div>
          <CommitCheckoutButton
            repoPath={repoPath}
            commitSha={commitSha}
            className="h-5 px-1.5 py-0 text-[9px]"
            iconClassName="h-2.5 w-2.5"
          />

          {isExternal && (
            <Badge variant="outline" className="h-4 px-1 text-[8px] border-emerald-200 text-emerald-600">
              Import
            </Badge>
          )}
          {hasHead && (
            <Badge className="h-4 px-1 text-[8px] bg-emerald-500 hover:bg-emerald-600 text-white border-none">
              HEAD
            </Badge>
          )}

          {entity.authorName && (
            <div className="flex items-center gap-1">
              <User size={10} />
              {entity.authorName}
            </div>
          )}

          {fileCount > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              <div className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                <Files size={10} />
                <span>{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
              </div>

              {(totalAdditions > 0 || totalDeletions > 0) && (
                <div className="flex items-center gap-1.5 ml-0.5">
                  {totalAdditions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>}
                  {totalDeletions > 0 && <span className="text-red-500 dark:text-red-400">-{totalDeletions}</span>}
                </div>
              )}

              {statusSummary.length > 0 ? (
                <span className="text-[9px] text-slate-400 ml-0.5">({statusSummary.join(', ')})</span>
              ) : null}
            </div>
          ) : (
            entity.commitCount !== undefined && entity.commitCount > 0 && (
              <div className="flex items-center gap-1 cursor-pointer hover:text-emerald-600">
                <Files size={10} />
                {entity.commitCount} files
              </div>
            )
          )}

          {otherBranches.length > 0 && (
            <div className="flex items-center gap-1 text-blue-500">
              <GitBranch size={10} />
              {otherBranches[0].name}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-slate-400 tabular-nums">
            {timestamp}
          </div>
        </div>

      </div>
    </TimelineRowWrapper>
  );
});

TimelineCommitRow.displayName = 'TimelineCommitRow';
