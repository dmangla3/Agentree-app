import { forwardRef, memo, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import { GitCommitHorizontal, Layers, GitBranch, Files } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import type { ProjectedExternalCommitBatch, ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { Badge } from '../../../../@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';
import { useGraphHoverProjectionInput } from '../../graph/GraphHoverProjectionContext';
import { useWorkspaceProjection } from '../../../hooks/useWorkspaceProjection';
import type { BranchPointer, Message } from '../../../stores/workspaceStore';
import type { FocusTriggerMetrics } from '../../../types/nodes';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { getCommitBatchDisplayRows, getCommitBatchRowFocusMetadata, type CommitBatchDisplayRow } from '../commitBatchDisplay';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

interface GraphExternalCommitBatchNodeProps {
  nodeId?: string;
  batch: ProjectedExternalCommitBatch;
  projection?: WorkspaceProjection;
  focusedCommitId?: string | null;
  isFocused: boolean;
  isSelected: boolean;
  disableHoverCard?: boolean;
  scopeColor?: string | null;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  onFocusCommit: (commitId: string, metrics?: FocusTriggerMetrics) => void;
  onSelectCommit: (commitId: string, multi: boolean) => void;
  selectedCommitIds: Set<string>;
  onFocus: (metrics?: FocusTriggerMetrics) => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const GraphExternalCommitBatchNode = memo(({
  nodeId,
  batch,
  projection,
  focusedCommitId,
  isFocused,
  isSelected,
  disableHoverCard,
  scopeColor,
  heightKey,
  onMeasureHeight,
  onFocusCommit,
  onSelectCommit,
  selectedCommitIds,
  onFocus,
  onSelect,
  onContextMenu
}: GraphExternalCommitBatchNodeProps) => {
  const rows = useMemo(() => getCommitBatchDisplayRows(batch), [batch]);
  const [localFocusedRowId, setLocalFocusedRowId] = useState<string | null>(null);
  const [suppressedFocusedHoverRowId, setSuppressedFocusedHoverRowId] = useState<string | null>(null);
  const focusedRowId = batch.sourceKind === 'manual'
    ? localFocusedRowId ?? rows.find((row) => row.sha === getMessageOutputCommitSha(row.sourceMessage))?.id ?? rows[rows.length - 1]?.id ?? null
    : null;
  const commitCount = batch.commitCount;
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const highlightedCommitCount = rows.filter((row) => row.branchPointers.length > 0).length;
  const listViewportHeight = Math.min(168, Math.max(40, commitCount * 36 + 4));

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const selectorValue = focusedRowId ?? (focusedCommitId && batch.messageIds.includes(focusedCommitId) ? focusedCommitId : null);
    if (selectorValue) {
      const focusSelector = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? `[data-graph-batch-row-id="${CSS.escape(selectorValue)}"]`
        : `[data-graph-batch-row-id="${selectorValue.replace(/"/g, '\\"')}"]`;
      const target = container.querySelector<HTMLElement>(focusSelector);
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
    container.scrollTop = container.scrollHeight;
  }, [batch.batch.messages, batch.messageIds, focusedCommitId, focusedRowId]);

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      disableHoverCard={disableHoverCard}
      scopeColor={scopeColor}
      heightKey={heightKey}
      className={cn(
        ROLE_COLORS.commit_message.bg,
        ROLE_COLORS.commit_message.border,
        highlightedCommitCount > 0 && 'border-sky-300/70 dark:border-sky-700/70 bg-gradient-to-br from-sky-50/90 via-background to-emerald-50/70 dark:from-sky-950/30 dark:via-background dark:to-emerald-950/20'
      )}
      style={{
        width: 260,
        boxShadow: highlightedCommitCount > 0 ? '0 16px 40px rgba(59, 130, 246, 0.14), 0 6px 16px rgba(16, 185, 129, 0.10)' : undefined,
      }}
      onMeasureHeight={onMeasureHeight}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Compact Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className="p-1 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400"
            title="External commits"
          >
            <GitCommitHorizontal size={11} />
          </div>
          <span
            className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 truncate max-w-[140px]"
            title={batch.title}
          >
            {batch.title}
          </span>
        </div>
        <Badge variant="secondary" className="h-4 px-1 text-[9px] flex items-center gap-0.5">
          <Layers size={9} />
          {commitCount}
        </Badge>
      </div>

      {highlightedCommitCount > 0 && (
        <div className="mb-2 flex items-center gap-1.5 text-[9px] font-semibold text-sky-700 dark:text-sky-300">
          <div className="h-2 w-2 rounded-full bg-sky-500 shadow-[0_0_10px_rgba(59,130,246,0.65)]" />
          {highlightedCommitCount} pinned {highlightedCommitCount === 1 ? 'commit' : 'commits'}
        </div>
      )}

      {/* Commit List - Compact */}
      <div className="flex-1 rounded-md border border-emerald-200/50 dark:border-emerald-800/50 bg-white/30 dark:bg-slate-900/30 overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="nowheel nodrag p-1.5 space-y-0.5 overflow-y-auto"
          style={{ height: listViewportHeight, maxHeight: 168 }}
          onWheelCapture={(e) => e.stopPropagation()}
          onPointerDownCapture={(e) => e.stopPropagation()}
        >
          {rows.map((row) => {
            const rowIsFocused = batch.sourceKind === 'manual'
              ? focusedRowId === row.id
              : focusedCommitId === row.focusMessageId;
            const shouldDisableRowHoverCard = Boolean(disableHoverCard || (rowIsFocused && suppressedFocusedHoverRowId === row.id));
            return shouldDisableRowHoverCard ? (
              <CommitRow
                key={row.id}
                batch={batch}
                row={row}
                isFocused={rowIsFocused}
                isSelected={selectedCommitIds.has(row.focusMessageId)}
                onFocusCommit={onFocusCommit}
                onSelectCommit={onSelectCommit}
                onLocalFocus={() => {
                  setLocalFocusedRowId(row.id);
                  setSuppressedFocusedHoverRowId(row.id);
                }}
                onPointerLeave={() => setSuppressedFocusedHoverRowId(null)}
              />
            ) : (
              <HoverCard key={row.id} openDelay={500} closeDelay={120}>
                <HoverCardTrigger asChild>
                  <CommitRow
                    row={row}
                    batch={batch}
                    isFocused={rowIsFocused}
                    isSelected={selectedCommitIds.has(row.focusMessageId)}
                    onFocusCommit={onFocusCommit}
                    onSelectCommit={onSelectCommit}
                    onLocalFocus={() => {
                      setLocalFocusedRowId(row.id);
                      setSuppressedFocusedHoverRowId(row.id);
                    }}
                    onPointerLeave={() => setSuppressedFocusedHoverRowId(null)}
                  />
                </HoverCardTrigger>
                <HoverCardContent side="right" align="center" sideOffset={8} className="z-[1000] w-auto border-none bg-transparent p-0 shadow-none">
                  <GraphExternalCommitRowHoverCardContent
                    row={row}
                    batch={batch}
                    fallbackProjection={projection}
                  />
                </HoverCardContent>
              </HoverCard>
            );
          })}
        </div>
      </div>
    </GraphNodeWrapper>
  );
});

GraphExternalCommitBatchNode.displayName = 'GraphExternalCommitBatchNode';

function GraphExternalCommitRowHoverCardContent({
  row,
  batch,
  fallbackProjection,
}: {
  row: CommitBatchDisplayRow;
  batch: ProjectedExternalCommitBatch;
  fallbackProjection?: WorkspaceProjection;
}) {
  const hoverInput = useGraphHoverProjectionInput();
  const hoverProjection = useWorkspaceProjection(
    hoverInput.messages.length > 0 ? hoverInput.messages : fallbackProjection?.messages ?? [],
    hoverInput.scopes.length > 0 ? hoverInput.scopes : fallbackProjection?.scopes ?? [],
    hoverInput.summaries.length > 0 ? hoverInput.summaries : fallbackProjection?.summaries ?? [],
    null,
    hoverInput.disabledSummaryIds,
    'graph-hover',
  );
  const hoverContext = getRowHoverContext(row, batch, hoverProjection);

  return (
    <NodeHoverCardContent
      entity={hoverContext?.entity}
      projection={hoverContext?.projection ?? fallbackProjection}
    />
  );
}

function getRowHoverContext(
  row: CommitBatchDisplayRow,
  batch: ProjectedExternalCommitBatch,
  projection?: WorkspaceProjection
): { entity: ProjectedNodeEntity; projection: WorkspaceProjection } | null {
  if (!projection) return null;

  const existingEntity = projection.entitiesByMessageId.get(row.focusMessageId);
  if (batch.sourceKind !== 'manual' && existingEntity) {
    return { entity: existingEntity, projection };
  }

  if (batch.sourceKind !== 'manual') return null;
  if (!row.sha) return null;

  const sourceMessage = row.sourceMessage;
  const sourceExecutionData = (sourceMessage.execution_data ?? {}) as Record<string, any>;
  const sourceMeta = (sourceExecutionData.meta ?? {}) as Record<string, any>;
  const {
    commits: _commits,
    commit_count: _commitCount,
    range_base_commit: _rangeBaseCommit,
    node_kind: _nodeKind,
    ...remainingMeta
  } = sourceMeta;
  const syntheticMessageId = row.id;
  const syntheticMessage: Message = {
    ...sourceMessage,
    id: syntheticMessageId,
    content: row.subject,
    aiLabel: row.subject,
    output_commit_sha: row.sha,
    commit: row.sha ? {
      ...(sourceMessage.commit ?? {}),
      sha: row.sha,
      subject: row.subject,
      author_name: row.authorName,
      authored_at: row.authoredAt,
      parents: row.parentShas.map((parentSha, index) => ({
        child_sha: row.sha || undefined,
        parent_sha: parentSha,
        parent_index: index,
      })),
    } : sourceMessage.commit,
    branchPointers: row.branchPointers,
    execution_data: {
      ...sourceExecutionData,
      meta: {
        ...remainingMeta,
        node_kind: 'commit',
        sync_source: sourceMeta.sync_source ?? 'manual_add_commit',
        git_author_name: row.authorName,
        git_authored_at: row.authoredAt,

        files_changed_count: row.filesChangedCount ?? undefined,
        files_added: row.filesAdded ?? undefined,
        files_modified: row.filesModified ?? undefined,
        files_deleted: row.filesDeleted ?? undefined,
        total_additions: row.totalAdditions ?? undefined,
        total_deletions: row.totalDeletions ?? undefined,
      },
    },
  };
  const syntheticEntity: ProjectedNodeEntity = {
    entityId: `commit_message:${syntheticMessageId}`,
    kind: 'commit_message',
    messageId: syntheticMessageId,
    focusMessageId: batch.representativeMessageId,
    parentEntityId: existingEntity?.parentEntityId,
    turnGroupId: existingEntity?.turnGroupId,
    sortTs: row.authoredAt ? new Date(row.authoredAt).getTime() : new Date(sourceMessage.createdAt).getTime(),
    message: syntheticMessage,
    preview: row.subject,
    shortLabel: row.sha.slice(0, 8),
    shortSha: row.sha.slice(0, 8),
    status: null,
    toolCallCount: undefined,
    totalTokens: null,
    authorName: row.authorName,
    authoredAt: row.authoredAt,
    parentShas: row.parentShas,
    importedFromRef: null,
    scopeId: sourceMessage.scope_id ?? null,
  };
  const entitiesById = new Map(projection.entitiesById);
  const entitiesByMessageId = new Map(projection.entitiesByMessageId);
  const messageMap = new Map(projection.messageMap);
  entitiesById.set(syntheticEntity.entityId, syntheticEntity);
  entitiesByMessageId.set(syntheticMessageId, syntheticEntity);
  messageMap.set(syntheticMessageId, syntheticMessage);

  return {
    entity: syntheticEntity,
    projection: {
      ...projection,
      messages: [...projection.messages, syntheticMessage],
      messageMap,
      entities: [...projection.entities, syntheticEntity],
      entitiesById,
      entitiesByMessageId,
    },
  };
}

const CommitRow = forwardRef<HTMLDivElement, {
  row: CommitBatchDisplayRow;
  batch: ProjectedExternalCommitBatch;
  isFocused: boolean;
  isSelected: boolean;
  onFocusCommit: (commitId: string, metrics?: FocusTriggerMetrics) => void;
  onSelectCommit: (commitId: string, multi: boolean) => void;
  onLocalFocus: () => void;
} & HTMLAttributes<HTMLDivElement>>(function CommitRow({
  row,
  batch,
  isFocused,
  isSelected,
  onFocusCommit,
  onSelectCommit,
  onLocalFocus,
  className,
  ...triggerProps
}, ref) {
  const pointerDownAtRef = useRef<number | null>(null);
  const pointers = row.branchPointers || [];
  const hasHead = pointers.some((pointer: BranchPointer) => pointer.name === 'HEAD');
  const otherBranches = pointers.filter((pointer: BranchPointer) => pointer.name !== 'HEAD');
  const highlighted = hasHead || otherBranches.length > 0;
  const primaryBranch = otherBranches[0] ?? null;
  const extraBranchCount = Math.max(0, otherBranches.length - 1);

  return (
    <div
      ref={ref}
      {...triggerProps}
      data-graph-commit-id={row.focusMessageId}
      data-graph-batch-row-id={row.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        pointerDownAtRef.current = performance.now();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          pointerDownAtRef.current = null;
          onSelectCommit(row.focusMessageId, true);
          return;
        }
        onLocalFocus();
        onFocusCommit(row.focusMessageId, {
          pointerDownAt: pointerDownAtRef.current,
          clickAt: performance.now(),
          metadata: getCommitBatchRowFocusMetadata(batch, row),
        });
        pointerDownAtRef.current = null;
      }}
      className={cn(
        'nodrag flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors',
        highlighted
          ? 'border border-sky-200/80 bg-sky-50/90 shadow-sm hover:bg-sky-100/90 dark:border-sky-800/80 dark:bg-sky-950/35 dark:hover:bg-sky-950/50'
          : 'hover:bg-emerald-100/50 dark:hover:bg-emerald-900/30',
        isSelected && 'bg-blue-100/60 dark:bg-blue-900/40',
        isFocused && 'ring-2 ring-indigo-500 bg-indigo-50/90 dark:bg-indigo-950/40',
        className
      )}
    >
      <span className={cn(
        'inline-flex items-center gap-0.5 font-mono text-[9px] font-semibold shrink-0 rounded px-1 py-0.5 mt-0.5',
        highlighted
          ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300'
          : 'text-emerald-600'
      )}>
        {row.sha?.slice(0, 6)}
        <CopyCommitShaButton commitSha={row.sha} className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        {highlighted && (
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {hasHead && (
              <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[7px] font-bold text-white shadow-sm">HEAD</span>
            )}
            {primaryBranch && (
              <span
                className="inline-flex max-w-[110px] items-center gap-1 rounded-full border border-sky-200/80 bg-sky-100/90 px-1.5 py-0.5 text-[7px] font-semibold text-sky-700 dark:border-sky-800/80 dark:bg-sky-950/60 dark:text-sky-300"
                title={otherBranches.map((pointer: BranchPointer) => pointer.name).join(', ')}
              >
                <GitBranch size={7} />
                <span className="truncate">{primaryBranch.name}</span>
                {extraBranchCount > 0 ? <span>+{extraBranchCount}</span> : null}
              </span>
            )}
          </div>
        )}
        <span className="block text-[10px] text-slate-700 dark:text-slate-300 truncate">
          {row.subject}
        </span>
        <CommitRowFileStats row={row} />
      </div>
    </div>
  );
});

CommitRow.displayName = 'CommitRow';

function CommitRowFileStats({ row }: { row: CommitBatchDisplayRow }) {
  const fileCount = row.filesChangedCount ?? 0;

  if (fileCount <= 0) return null;

  return (
    <span
      className="mt-1 inline-flex items-center gap-1 text-[8px] font-medium text-emerald-600 dark:text-emerald-400"
      title={`${fileCount} ${fileCount === 1 ? 'file' : 'files'} changed`}
    >
      <Files size={8} />
      {fileCount}
    </span>
  );
}
