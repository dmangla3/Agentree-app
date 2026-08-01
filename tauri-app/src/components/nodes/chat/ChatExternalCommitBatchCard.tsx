import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Layers, Archive } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import type { ProjectedExternalCommitBatch, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { cn } from '../../../lib/utils';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { getCommitBatchDisplayRows, getCommitBatchRowFocusMetadata } from '../commitBatchDisplay';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

interface ChatExternalCommitBatchCardProps {
  batch: ProjectedExternalCommitBatch;
  projection: WorkspaceProjection;
  isFocused: boolean;
  isSelected: boolean;
  scopeColor?: string | null;
  onFocusCommit: (commitId: string, metadata?: Record<string, unknown>) => void;
  onSelectCommit: (commitId: string, multi: boolean) => void;
  onContextMenuCommit: (commitId: string, e: React.MouseEvent) => void;
  selectedCommitIds: Set<string>;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const ChatExternalCommitBatchCard = memo(({
  batch,
  isFocused,
  isSelected,
  scopeColor,
  onFocusCommit,
  onContextMenuCommit,
  selectedCommitIds,
  onContextMenu
}: ChatExternalCommitBatchCardProps) => {
  const focusedMessageId = useWorkspaceStore((state) => state.focusedMessageId);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [localFocusedRowId, setLocalFocusedRowId] = useState<string | null>(null);
  const baseMessageId = focusedMessageId && batch.messageIds.includes(focusedMessageId)
    ? focusedMessageId
    : batch.representativeMessageId;
  const rows = useMemo(() => getCommitBatchDisplayRows(batch), [batch]);
  const focusedRowId = batch.sourceKind === 'manual'
    ? localFocusedRowId ?? rows.find((row) => row.sha === getMessageOutputCommitSha(row.sourceMessage))?.id ?? rows[rows.length - 1]?.id ?? null
    : null;

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !baseMessageId) return;
    const selectorValue = focusedRowId ?? baseMessageId;
    const selector = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? `[data-chat-batch-row-id="${CSS.escape(selectorValue)}"]`
      : `[data-chat-batch-row-id="${selectorValue.replace(/"/g, '\\"')}"]`;
    const target = container.querySelector<HTMLElement>(selector);
    target?.scrollIntoView({ block: 'nearest' });
  }, [baseMessageId, batch.messageIds, focusedRowId]);

  const commitCountLabel = useMemo(() => (
    `${batch.commitCount} ${batch.commitCount === 1 ? 'commit' : 'commits'}`
  ), [batch.commitCount]);

  return (
    <ChatCardWrapper
      focusTargetId={batch.representativeMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      onFocus={() => onFocusCommit(batch.representativeMessageId)}
      onSelect={() => {}}
      onContextMenu={onContextMenu}
      className="bg-gradient-to-br from-teal-50/60 via-cyan-50/40 to-sky-50/20 dark:from-teal-950/20 dark:via-cyan-950/15 dark:to-sky-950/10"
    >
      {/* Header */}
      <div className="mb-4 flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Archive Icon */}
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-teal-200/60 bg-gradient-to-br from-teal-100 to-cyan-50 text-teal-600 shadow-sm dark:border-teal-800 dark:from-teal-950/50 dark:to-cyan-950/40 dark:text-teal-400">
            <Archive size={16} strokeWidth={2} />
          </div>
          
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="min-w-0 truncate text-sm font-semibold text-teal-700 dark:text-teal-400">
              {batch.title}
            </span>
          </div>
        </div>
        
        {/* Count badge */}
        <div
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-teal-200/70 bg-teal-50/80 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-400 shadow-sm"
          title={commitCountLabel}
        >
          <Layers size={12} strokeWidth={2} />
          {batch.commitCount}
        </div>
      </div>

      {/* Commit List - scrollable with max height */}
      <div 
        ref={scrollContainerRef}
        className="min-w-0 max-w-full space-y-1.5 overflow-y-auto overflow-x-hidden pr-1 custom-scrollbar"
        style={{ maxHeight: '280px' }}
      >
        {rows.map((row) => {
          const selected = selectedCommitIds.has(row.focusMessageId);
          const focused = batch.sourceKind === 'manual'
            ? focusedRowId === row.id
            : baseMessageId === row.focusMessageId;
          return (
            <button
              key={row.id}
              type="button"
              data-chat-batch-focus-id={row.focusMessageId}
              data-chat-batch-row-id={row.id}
              onClick={(event) => {
                event.stopPropagation();
                setLocalFocusedRowId(row.id);
                onFocusCommit(row.focusMessageId, getCommitBatchRowFocusMetadata(batch, row));
              }}
              onContextMenu={(event) => onContextMenuCommit(row.focusMessageId, event)}
              className={cn(
                'flex w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                focused
                  ? 'border-indigo-400 bg-indigo-50/90 dark:border-indigo-700 dark:bg-indigo-950/35'
                  : selected
                    ? 'border-blue-300 bg-blue-50/80 dark:border-blue-800 dark:bg-blue-950/30'
                    : 'border-emerald-200/50 bg-white/45 hover:bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-slate-950/20 dark:hover:bg-emerald-950/25'
              )}
            >
              <code className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                {row.sha?.slice(0, 7) ?? 'commit'}
                <CopyCommitShaButton commitSha={row.sha} className="h-3 w-3 text-emerald-700/70 dark:text-emerald-300/70" />
              </code>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-foreground">{row.subject}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                  {row.authorName ? <span className="truncate">{row.authorName}</span> : null}
                  {row.authoredAt ? <span className="shrink-0">{new Date(row.authoredAt).toLocaleDateString()}</span> : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </ChatCardWrapper>
  );
});

ChatExternalCommitBatchCard.displayName = 'ChatExternalCommitBatchCard';
