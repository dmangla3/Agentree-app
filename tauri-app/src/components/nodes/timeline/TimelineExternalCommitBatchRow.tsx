import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GitCommitHorizontal, Layers, GitBranch } from 'lucide-react';
import { TimelineRowWrapper } from './TimelineRowWrapper';
import type { ProjectedExternalCommitBatch } from '../../../domain/workspaceProjection';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { Badge } from '../../../../@/components/ui/badge';
import { Checkbox } from '../../../../@/components/ui/checkbox';
import { ScrollArea, ScrollBar } from '../../../../@/components/ui/scroll-area';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { CommitCheckoutButton } from '../../CommitCheckoutButton';
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { getRepoPathFromWorkspace } from '../../../lib/gitNodeUtils';
import { getCommitBatchDisplayRows, getCommitBatchRowFocusMetadata } from '../commitBatchDisplay';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

interface TimelineExternalCommitBatchRowProps {
  batch: ProjectedExternalCommitBatch;
  rowId?: string;
  isFocused: boolean;
  isSelected: boolean;
  focusedCommitId?: string | null;
  scopeColor?: string | null;
  onFocusCommit: (commitId: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  showSelectionControl?: boolean;
  selectedCommitIds: Set<string>;
  hoverCardContent?: ReactNode;
}

export const TimelineExternalCommitBatchRow = memo(({
  batch,
  rowId,
  isFocused,
  isSelected,
  focusedCommitId,
  scopeColor,
  onFocusCommit,
  onSelect,
  onContextMenu,
  showSelectionControl = false,
  selectedCommitIds,
  hoverCardContent
}: TimelineExternalCommitBatchRowProps) => {
  const { data: workspaces = [] } = useWorkspaces();
  const workspaceId = batch.batch.messages[0]?.workspaceId ?? null;
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  const repoPath = getRepoPathFromWorkspace(workspace);
  const rows = useMemo(() => getCommitBatchDisplayRows(batch), [batch]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [localFocusedRowId, setLocalFocusedRowId] = useState<string | null>(null);
  const focusedRowId = batch.sourceKind === 'manual'
    ? localFocusedRowId ?? rows.find((row) => row.sha === getMessageOutputCommitSha(row.sourceMessage))?.id ?? rows[rows.length - 1]?.id ?? null
    : focusedCommitId && batch.messageIds.includes(focusedCommitId)
      ? focusedCommitId
      : null;
  const timestamp = batch.sortTs
    ? new Date(batch.sortTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !focusedRowId) return;
    const selector = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? `[data-timeline-batch-row-id="${CSS.escape(focusedRowId)}"]`
      : `[data-timeline-batch-row-id="${focusedRowId.replace(/"/g, '\\"')}"]`;
    container.querySelector<HTMLElement>(selector)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [focusedRowId]);

  return (
    <TimelineRowWrapper
      rowId={rowId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      onFocus={() => onFocusCommit(batch.representativeMessageId)}
      onSelect={() => { }}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      hoverCardContent={hoverCardContent}
      className={cn(ROLE_COLORS.commit_message.bg, "mx-2")}
    >
      <div className="flex-1 flex flex-col gap-1.5 min-w-0">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className="p-1 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400"
              title="External commits"
            >
              <GitCommitHorizontal size={11} />
            </div>
            <span
              className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 truncate max-w-[150px]"
              title={batch.title}
            >
              {batch.title}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex shrink-0 items-center text-[10px] font-medium text-slate-400 tabular-nums whitespace-nowrap">
              {timestamp}
            </div>
            <Badge variant="secondary" className="h-4 px-1 text-[9px] flex items-center gap-0.5">
              <Layers size={9} />
              {batch.commitCount}
            </Badge>
          </div>
        </div>

        {/* Horizontal scrollable commits */}
        <ScrollArea className="w-full whitespace-nowrap">
          <div ref={scrollContainerRef} className="flex gap-1.5 pb-1">
            {rows.map((row) => (
              <div
                key={row.id}
                data-timeline-batch-row-id={row.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setLocalFocusedRowId(row.id);
                  onFocusCommit(row.focusMessageId, getCommitBatchRowFocusMetadata(batch, row));
                }}
                className={cn(
                  'flex flex-col gap-0.5 p-1.5 rounded border border-emerald-200/50 dark:border-emerald-800/50 bg-background/50 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/30 cursor-pointer min-w-[150px] max-w-[150px]',
                  focusedRowId === row.id && 'border-indigo-400 bg-indigo-50/90 dark:border-indigo-700 dark:bg-indigo-950/35'
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="inline-flex items-center gap-0.5 font-mono text-[9px] text-emerald-600">
                    {row.sha?.slice(0, 6)}
                    <CopyCommitShaButton commitSha={row.sha} className="h-3 w-3 text-emerald-600/70" />
                  </span>
                  <CommitCheckoutButton
                    repoPath={repoPath}
                    commitSha={row.sha}
                    className="h-4 px-1 py-0 text-[8px]"
                    iconClassName="h-2 w-2"
                  />
                  {showSelectionControl ? (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(row.focusMessageId, e.metaKey || e.ctrlKey || e.shiftKey);
                      }}
                    >
                      <Checkbox checked={selectedCommitIds.has(row.focusMessageId)} className="h-3 w-3" />
                    </div>
                  ) : null}
                </div>
                {(() => {
                  const pointers = row.branchPointers || [];
                  const hasHead = pointers.some((p: BranchPointer) => p.name === 'HEAD');
                  const otherBranches = pointers.filter((p: BranchPointer) => p.name !== 'HEAD');
                  return (hasHead || otherBranches.length > 0) ? (
                    <div className="flex items-center gap-0.5 flex-wrap">
                      {hasHead && (
                        <span className="bg-emerald-500 text-white text-[7px] font-bold px-1 py-0 rounded-sm leading-tight">HEAD</span>
                      )}
                      {otherBranches.slice(0, 1).map((b: BranchPointer) => (
                        <span key={b.id} className="inline-flex items-center gap-0.5 text-[7px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-800/60 px-1 py-0 rounded-sm leading-tight truncate max-w-[80px]" title={b.name}>
                          <GitBranch size={7} />
                          {b.name}
                        </span>
                      ))}
                    </div>
                  ) : null;
                })()}
                <span className="text-[9px] text-slate-700 dark:text-slate-300 truncate">
                  {row.subject}
                </span>
              </div>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </TimelineRowWrapper>
  );
});

TimelineExternalCommitBatchRow.displayName = 'TimelineExternalCommitBatchRow';
