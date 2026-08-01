import { memo } from 'react';
import { GitCommitHorizontal, Files, FilePlus, FileMinus, GitBranch } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

export const GraphCommitNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  disableHoverCard,
  scopeColor,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const branchPointers = entity.message?.branchPointers || [];
  const outputCommitSha = getMessageOutputCommitSha(entity.message);
  const meta = ((entity.message?.execution_data as any)?.meta || {}) as Record<string, any>;
  const isCommitBatch = meta.node_kind === 'commit_batch';
  const batchCommitCount = typeof meta.commit_count === 'number' ? meta.commit_count : 0;
  const hasHead = branchPointers.some((p: BranchPointer) => p.name === 'HEAD');
  const otherBranches = branchPointers.filter((p: BranchPointer) => p.name !== 'HEAD');
  const primaryBranch = otherBranches[0] ?? null;
  const extraBranchCount = Math.max(0, otherBranches.length - 1);
  const isPinnedCommit = hasHead || otherBranches.length > 0;
  const isExternal = !!entity.importedFromRef;
  const filesChanged = ((entity.message?.execution_data as any)?.files_changed || []) as Array<{ additions?: number; deletions?: number }>;
  const totalAdditions = filesChanged.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = filesChanged.reduce((sum, file) => sum + (file.deletions || 0), 0);

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
        isPinnedCommit && 'border-sky-300/80 dark:border-sky-700/80 bg-gradient-to-br from-sky-50 via-background to-blue-50/80 dark:from-sky-950/35 dark:via-background dark:to-blue-950/20'
      )}
      style={{
        width: 220,
        minHeight: 72,
        boxShadow: isPinnedCommit ? '0 14px 36px rgba(59, 130, 246, 0.18), 0 4px 14px rgba(14, 165, 233, 0.12)' : undefined,
      }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Header: Icon + SHA */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-emerald-600 dark:text-emerald-400',
          isPinnedCommit
            ? 'border-sky-200/80 bg-sky-100/80 shadow-sm dark:border-sky-800/80 dark:bg-sky-950/50'
            : 'border-emerald-200/60 bg-emerald-100/70 dark:border-emerald-800 dark:bg-emerald-950/40'
        )}>
          <GitCommitHorizontal size={11} />
        </div>
        <span
          className="inline-flex items-center gap-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40 px-1 rounded shrink-0"
          title={outputCommitSha || undefined}
        >
          {entity.shortSha}
          <CopyCommitShaButton commitSha={outputCommitSha} className="h-3.5 w-3.5 text-emerald-700/70 dark:text-emerald-300/70" />
        </span>
        {isExternal && (
          <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 border border-emerald-200/50 shrink-0">
            ext
          </span>
        )}
        {isCommitBatch && (
          <span className="text-[8px] px-1 py-0.5 rounded bg-teal-50 dark:bg-teal-950/30 text-teal-600 border border-teal-200/50 shrink-0">
            batch
          </span>
        )}
      </div>

      {isPinnedCommit && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {hasHead && (
            <span className="inline-flex items-center rounded-full bg-emerald-500 px-2 py-0.5 text-[9px] font-semibold text-white shadow-sm">
              HEAD
            </span>
          )}
          {primaryBranch && (
            <span
              className="inline-flex max-w-[150px] items-center gap-1 rounded-full border border-sky-200/80 bg-sky-100/90 px-2 py-0.5 text-[9px] font-semibold text-sky-700 shadow-sm dark:border-sky-800/80 dark:bg-sky-950/60 dark:text-sky-300"
              title={otherBranches.map((pointer: BranchPointer) => pointer.name).join(', ')}
            >
              <GitBranch size={9} />
              <span className="truncate">{primaryBranch.name}</span>
              {extraBranchCount > 0 ? <span className="text-sky-500/80 dark:text-sky-300/80">+{extraBranchCount}</span> : null}
            </span>
          )}
        </div>
      )}

      {/* Message preview */}
      <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200 line-clamp-2 leading-relaxed mb-2 flex-1 text-wrap-pretty">
        {entity.preview}
      </p>

      {/* Footer stats */}
      <div className="flex items-center gap-3 mt-auto pt-1.5 border-t border-emerald-200/30 dark:border-emerald-800/30 text-[9px] text-slate-500">
        {entity.authorName && (
          <span className="truncate max-w-[80px]" title={entity.authorName}>
            {entity.authorName}
          </span>
        )}
        {filesChanged.length > 0 && (
          <div className="flex items-center gap-1 ml-auto" title={`${filesChanged.length} files changed`}>
            <Files size={9} className="text-emerald-500" />
            {filesChanged.length}
          </div>
        )}
        {isCommitBatch && batchCommitCount > 0 && (
          <div className="flex items-center gap-1 ml-auto" title={`${batchCommitCount} commits added`}>
            <GitCommitHorizontal size={9} className="text-emerald-500" />
            {batchCommitCount}
          </div>
        )}
        {totalAdditions > 0 && (
          <div className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title={`${totalAdditions} added lines`}>
            <FilePlus size={9} />
            {totalAdditions}
          </div>
        )}
        {totalDeletions > 0 && (
          <div className="flex items-center gap-0.5 text-red-500 dark:text-red-400" title={`${totalDeletions} deleted lines`}>
            <FileMinus size={9} />
            {totalDeletions}
          </div>
        )}
      </div>
    </GraphNodeWrapper>
  );
});

GraphCommitNode.displayName = 'GraphCommitNode';
