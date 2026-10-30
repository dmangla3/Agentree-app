import { memo } from 'react';
import { Layers } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

export const GraphSummaryNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  disableHoverCard,
  detailLevel = 'full',
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  controlledHoverCardKey,
  onControlledHoverCardDismiss,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const isMinimalDetail = detailLevel === 'minimal';

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      disableHoverCard={disableHoverCard}
      heightKey={heightKey}
      className={cn(
        ROLE_COLORS.summary_block.bg, 
        ROLE_COLORS.summary_block.border,
        'border-dashed'
      )}
      style={{ width: 180, minHeight: 64 }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      controlledHoverCardKey={controlledHoverCardKey}
      onControlledHoverCardDismiss={onControlledHoverCardDismiss}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Compact header inline with content */}
      <div className="flex items-start gap-2">
        <div 
          className="mt-0.5 shrink-0 rounded bg-[hsl(var(--app-graph-summary)/0.11)] p-1 text-[hsl(var(--app-graph-summary))]"
          title="Summary"
        >
          <Layers size={10} />
        </div>
        {isMinimalDetail ? (
          <div className="mt-2 h-1.5 min-w-0 flex-1 rounded-full bg-[hsl(var(--app-graph-summary)/0.2)]" />
        ) : (
          <p className={cn(
            'text-[11px] font-medium leading-relaxed text-foreground/80 italic',
            detailLevel === 'compact' ? 'line-clamp-1' : 'line-clamp-3',
          )}>
            {entity.preview}
          </p>
        )}
      </div>
    </GraphNodeWrapper>
  );
});

GraphSummaryNode.displayName = 'GraphSummaryNode';
