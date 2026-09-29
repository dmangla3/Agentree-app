import { memo } from 'react';
import { Files, FilePlus, FileMinus, GitBranch, GitMerge, CircleDot } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import type { BranchPointer } from '../../../stores/workspaceStore';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';

export const GraphCommitNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  isComposerBaseCommit,
  disableHoverCard,
  detailLevel = 'full',
  heightKey,
  hoverCardContent,
  controlledHoverCardKey,
  onControlledHoverCardDismiss,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const branchPointers = entity.message?.branchPointers || [];
  const outputCommitSha = getMessageOutputCommitSha(entity.message);
  const hasHead = branchPointers.some((p: BranchPointer) => p.name === 'HEAD');
  const otherBranches = branchPointers.filter((p: BranchPointer) => p.name !== 'HEAD');
  const primaryBranch = otherBranches[0] ?? null;
  const extraBranchCount = Math.max(0, otherBranches.length - 1);
  const isPinnedCommit = hasHead || otherBranches.length > 0;
  const isExternal = !!entity.importedFromRef;
  const filesChanged = ((entity.message?.execution_data as any)?.files_changed || []) as Array<{ additions?: number; deletions?: number }>;
  const totalAdditions = filesChanged.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = filesChanged.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const parentCount = entity.parentShas?.length ?? 0;
  const isMergeCommit = parentCount > 1;
  const sourceLabel = isExternal ? 'Import' : 'Gen';
  const shortSha = (entity.shortSha || outputCommitSha?.slice(0, 8) || 'commit').slice(0, 8);
  const isFullDetail = detailLevel === 'full';
  const isMinimalDetail = detailLevel === 'minimal';

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      isComposerBaseCommit={isComposerBaseCommit}
      disableHoverCard={disableHoverCard}
      heightKey={heightKey}
      className={cn(
        'bg-emerald-50/90 border-emerald-300/65 dark:bg-emerald-950/25 dark:border-emerald-800/70',
        'rounded-l-[2px] rounded-r-[7px] shadow-none',
        isPinnedCommit && 'border-teal-400/80 bg-teal-50/95 dark:border-teal-700/80 dark:bg-teal-950/35'
      )}
      style={{
        width: 120,
        height: '100%',
        boxShadow: isPinnedCommit
          ? 'inset 1px 0 0 rgba(13, 148, 136, 0.18), inset -1px 0 0 rgba(255, 255, 255, 0.42)'
          : 'inset -1px 0 0 rgba(255, 255, 255, 0.34)',
      }}
      bodyClassName="px-2.5 py-2"
      hoverOpenDelay={180}
      onMeasureHeight={undefined}
      hoverCardContent={hoverCardContent}
      controlledHoverCardKey={controlledHoverCardKey}
      onControlledHoverCardDismiss={onControlledHoverCardDismiss}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="absolute left-[-2px] top-0 h-full w-[3px] rounded-l-[2px] bg-emerald-500/70 dark:bg-emerald-500/60" />
      <div className="pointer-events-none absolute inset-y-2 left-[7px] w-px bg-emerald-300/55 dark:bg-emerald-800/70" />

      <div className="flex h-full min-h-0 flex-col gap-1.5">
        <div className="flex w-full items-center justify-between gap-1.5">
          <CircleDot size={7} className="shrink-0 text-emerald-700 dark:text-emerald-400" strokeWidth={2.2} />
          <span className="min-w-0 truncate text-[8px] font-semibold uppercase tracking-[0.08em] text-emerald-800 dark:text-emerald-300">
            {sourceLabel}
          </span>
        </div>

        <div className="flex w-full items-center justify-between gap-1 rounded-[5px] border border-emerald-200/65 bg-white/60 px-1.5 py-1 font-mono text-[9px] leading-none text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/55 dark:text-emerald-200" title={outputCommitSha || undefined}>
          <span className="min-w-0 truncate">{shortSha}</span>
          {isFullDetail && (
            <CopyCommitShaButton commitSha={outputCommitSha} className="h-3.5 w-3.5 shrink-0 text-emerald-700/70 dark:text-emerald-300/70" />
          )}
        </div>

        {isMinimalDetail ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <p
            className={cn(
              'min-h-0 flex-1 text-left text-[11px] font-semibold leading-snug text-zinc-800 dark:text-zinc-200',
              isFullDetail ? 'line-clamp-4' : 'line-clamp-1',
            )}
            title={entity.preview}
          >
            {entity.preview}
          </p>
        )}

        {isFullDetail && isPinnedCommit && (
          <div className="flex w-full flex-col items-center gap-1">
            {hasHead && (
              <span className="w-full rounded-[4px] bg-emerald-600 px-1 py-0.5 text-[8px] font-semibold leading-none text-white">
                HEAD
              </span>
            )}
            {primaryBranch && (
              <span
                className="flex w-full items-center justify-center gap-0.5 rounded-[4px] border border-teal-300/80 bg-white/65 py-0.5 text-[8px] font-semibold text-teal-800 dark:border-teal-800/80 dark:bg-teal-950/60 dark:text-teal-300"
                title={otherBranches.map((pointer: BranchPointer) => pointer.name).join(', ')}
              >
                <GitBranch size={8} />
                {extraBranchCount > 0 ? `+${extraBranchCount}` : null}
              </span>
            )}
          </div>
        )}

        {isFullDetail && (
        <div className="flex w-full items-center justify-start gap-1.5 border-t border-emerald-300/40 pt-1 text-[8px] leading-none text-zinc-600 dark:border-emerald-800/70 dark:text-zinc-400">
          {isMergeCommit && (
            <span className="flex items-center gap-0.5" title={`${parentCount} parents`}>
              <GitMerge size={8} />
              {parentCount}
            </span>
          )}
          {filesChanged.length > 0 && (
            <span className="flex items-center gap-0.5" title={`${filesChanged.length} files changed`}>
              <Files size={8} className="text-emerald-500" />
              {filesChanged.length}
            </span>
          )}
          {totalAdditions > 0 && (
            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title={`${totalAdditions} added lines`}>
              <FilePlus size={8} />
              {totalAdditions}
            </span>
          )}
          {totalDeletions > 0 && (
            <span className="flex items-center gap-0.5 text-red-500 dark:text-red-400" title={`${totalDeletions} deleted lines`}>
              <FileMinus size={8} />
              {totalDeletions}
            </span>
          )}
        </div>
        )}
      </div>
    </GraphNodeWrapper>
  );
});

GraphCommitNode.displayName = 'GraphCommitNode';
