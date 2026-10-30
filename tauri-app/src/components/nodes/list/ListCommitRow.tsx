import { memo } from 'react';
import { GitCommitHorizontal, User, Files, GitBranch } from 'lucide-react';
import { ListRowWrapper } from './ListRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { Badge } from '../../../../@/components/ui/badge';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { CommitCheckoutButton } from '../../CommitCheckoutButton';
import { OpenCommitTerminalButton } from '../../OpenCommitTerminalButton';
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { getRepoPathFromWorkspace } from '../../../lib/gitNodeUtils';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

export const ListCommitRow = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
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
    <ListRowWrapper
      rowId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      disableHoverCard={disableHoverCard}
      hoverCardContent={hoverCardContent}
      className={cn(
        "mx-1 bg-[hsl(var(--app-panel-strong)/0.7)] dark:bg-[hsl(var(--app-graph-commit)/0.045)]",
        "border-[hsl(var(--app-graph-commit)/0.24)]"
      )}
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="min-w-0 flex-1 whitespace-normal break-words text-sm font-medium leading-snug text-foreground line-clamp-2">
          {entity.preview}
        </p>

        <div className="mt-1 flex w-full flex-wrap items-center gap-2 gap-y-1 text-[10px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-1 rounded border border-[hsl(var(--app-graph-commit)/0.22)] bg-[hsl(var(--app-graph-commit)/0.1)] px-1 py-0.5 text-[hsl(var(--app-graph-commit))]">
            <GitCommitHorizontal size={10} />
            <span className="font-mono text-[9px]">{entity.shortSha}</span>
            <CopyCommitShaButton commitSha={commitSha} className="h-3.5 w-3.5 text-[hsl(var(--app-graph-commit)/0.78)]" />
          </div>
          <CommitCheckoutButton
            repoPath={repoPath}
            commitSha={commitSha}
            className="h-5 px-1.5 py-0 text-[9px]"
            iconClassName="h-2.5 w-2.5"
          />
          <OpenCommitTerminalButton
            repoPath={repoPath}
            commitSha={commitSha}
            label={entity.preview}
            compact
            className="h-5 px-1.5 py-0"
          />

          {isExternal && (
            <Badge variant="outline" className="h-4 border-[hsl(var(--app-graph-commit)/0.28)] px-1 text-[8px] text-[hsl(var(--app-graph-commit))]">
              Import
            </Badge>
          )}
          {hasHead && (
            <Badge data-design-typography="soft-on-color" className="h-4 border-none bg-[hsl(var(--app-graph-commit))] px-1 text-[8px] font-medium text-[hsl(40_24%_96%)] hover:bg-[hsl(var(--app-graph-commit))]">
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
              <div className="flex items-center gap-1 text-muted-foreground">
                <Files size={10} />
                <span>{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
              </div>

              {(totalAdditions > 0 || totalDeletions > 0) && (
                <div className="flex items-center gap-1.5 ml-0.5">
                  {totalAdditions > 0 && <span className="text-[hsl(var(--app-graph-commit))]">+{totalAdditions}</span>}
                  {totalDeletions > 0 && <span className="text-red-500 dark:text-red-400">-{totalDeletions}</span>}
                </div>
              )}

              {statusSummary.length > 0 ? (
                <span className="ml-0.5 text-[9px] text-muted-foreground/70">({statusSummary.join(', ')})</span>
              ) : null}
            </div>
          ) : (
            entity.commitCount !== undefined && entity.commitCount > 0 && (
              <div className="flex cursor-pointer items-center gap-1 hover:text-[hsl(var(--app-graph-commit))]">
                <Files size={10} />
                {entity.commitCount} files
              </div>
            )
          )}

          {otherBranches.length > 0 && (
            <div className="flex items-center gap-1 text-[hsl(var(--app-graph-agent))]">
              <GitBranch size={10} />
              {otherBranches[0].name}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-muted-foreground/70 tabular-nums">
            {timestamp}
          </div>
        </div>

      </div>
    </ListRowWrapper>
  );
});

ListCommitRow.displayName = 'ListCommitRow';
