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
        ROLE_COLORS.summary_block.bg, 
        ROLE_COLORS.summary_block.border,
        'border-dashed'
      )}
      style={{ width: 180, minHeight: 64 }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Compact header inline with content */}
      <div className="flex items-start gap-2">
        <div 
          className="p-1 rounded bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400 shrink-0 mt-0.5"
          title="Summary"
        >
          <Layers size={10} />
        </div>
        <p className="text-[11px] font-medium text-slate-700 dark:text-slate-300 line-clamp-3 leading-relaxed italic">
          {entity.preview}
        </p>
      </div>
    </GraphNodeWrapper>
  );
});

GraphSummaryNode.displayName = 'GraphSummaryNode';
