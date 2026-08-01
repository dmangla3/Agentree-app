import { memo } from 'react';
import { User } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

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
        ROLE_COLORS.user_message.bg,
        ROLE_COLORS.user_message.border
      )}
      style={{ width: 220, minHeight: 64 }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Ultra-compact: Icon inline with text */}
      <div className="flex items-start gap-2">
        <div
          className={cn("p-1 rounded-md shrink-0 mt-0.5", ROLE_COLORS.user_message.chip)}
          title="User message"
        >
          <User size={10} />
        </div>
        <p className={cn("text-xs font-medium line-clamp-3 leading-relaxed", ROLE_COLORS.user_message.text)}>
          {entity.preview}
        </p>
      </div>
    </GraphNodeWrapper>
  );
});

GraphUserNode.displayName = 'GraphUserNode';
