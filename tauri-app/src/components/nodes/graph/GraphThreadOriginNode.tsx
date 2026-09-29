import { memo } from 'react';
import { GitBranchPlus } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';

export const GraphThreadOriginNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  disableHoverCard,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  controlledHoverCardKey,
  onControlledHoverCardDismiss,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => (
  <GraphNodeWrapper
    nodeId={nodeId}
    isFocused={isFocused}
    isSelected={isSelected}
    disableHoverCard={disableHoverCard}
    heightKey={heightKey}
    className={cn(
      'border-zinc-200/90 bg-zinc-100/90 text-zinc-800 shadow-[0_8px_20px_-18px_rgba(24,24,27,0.5)]',
      'dark:border-zinc-800/90 dark:bg-zinc-900/85 dark:text-zinc-100'
    )}
    style={{ width: 200, height: 64 }}
    onMeasureHeight={onMeasureHeight}
    hoverCardContent={hoverCardContent}
    controlledHoverCardKey={controlledHoverCardKey}
    onControlledHoverCardDismiss={onControlledHoverCardDismiss}
    onFocus={onFocus}
    onSelect={onSelect}
    onContextMenu={onContextMenu}
  >
    <div className="flex h-full items-center gap-2.5">
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-700 shadow-sm',
          'dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200'
        )}
        title="Thread origin"
      >
        <GitBranchPlus size={13} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
          Thread
        </div>
        <p className="truncate text-[12px] font-medium leading-snug text-zinc-800 dark:text-zinc-100">
          {entity.preview || 'Thread origin'}
        </p>
      </div>
    </div>
  </GraphNodeWrapper>
));

GraphThreadOriginNode.displayName = 'GraphThreadOriginNode';
