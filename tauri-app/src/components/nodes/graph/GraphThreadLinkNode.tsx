import { memo } from 'react';
import { GitBranch } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';

export const GraphThreadLinkNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  disableHoverCard,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
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
      'border-cyan-200/90 bg-cyan-50/95 text-cyan-950 shadow-[0_8px_20px_-18px_rgba(8,145,178,0.55)]',
      'dark:border-cyan-900/75 dark:bg-cyan-950/70 dark:text-cyan-50'
    )}
    style={{ width: 200, height: 64 }}
    onMeasureHeight={onMeasureHeight}
    hoverCardContent={hoverCardContent}
    onFocus={onFocus}
    onSelect={onSelect}
    onContextMenu={onContextMenu}
  >
    <div className="flex h-full items-center gap-2.5">
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cyan-200 bg-white text-cyan-700 shadow-sm',
          'dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-200'
        )}
        title="Open thread"
      >
        <GitBranch size={13} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-cyan-700/80 dark:text-cyan-300/80">
          Thread
        </div>
        <p className="truncate text-[12px] font-medium leading-snug text-cyan-950 dark:text-cyan-50">
          {entity.preview || 'Open thread'}
        </p>
      </div>
    </div>
  </GraphNodeWrapper>
));

GraphThreadLinkNode.displayName = 'GraphThreadLinkNode';
