import { memo } from 'react';
import { MessageSquareText } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';

export const GraphUserNode = memo(({
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
  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      disableHoverCard={disableHoverCard}
      scopeColor={scopeColor}
      heightKey={heightKey}
      className={cn(
        'bg-zinc-50/95 border-zinc-200/90 dark:bg-zinc-950/80 dark:border-zinc-800/90',
        'rounded-b-[5px] shadow-[0_8px_22px_-18px_rgba(24,24,27,0.45)]'
      )}
      style={{ width: 200, height: 82 }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="flex h-full items-start gap-2.5">
        <div
          className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 shadow-sm',
            'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300'
          )}
          title="User prompt"
        >
          <MessageSquareText size={13} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
              User
            </span>
          </div>
          <p className="line-clamp-2 text-[12px] font-medium leading-snug text-zinc-800 dark:text-zinc-100">
            {entity.preview}
          </p>
        </div>
      </div>
    </GraphNodeWrapper>
  );
});

GraphUserNode.displayName = 'GraphUserNode';
