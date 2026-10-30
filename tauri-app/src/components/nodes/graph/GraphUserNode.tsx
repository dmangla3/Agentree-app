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
  focusFeedbackEnabled,
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
      focusFeedbackEnabled={focusFeedbackEnabled}
      disableHoverCard={disableHoverCard}
      heightKey={heightKey}
      className={cn(
        'border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-bg-muted)/0.78)]',
        'rounded-b-[5px] shadow-[0_8px_22px_-18px_hsl(var(--foreground)/0.28)]'
      )}
      style={{ width: 200, height: 82 }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      controlledHoverCardKey={controlledHoverCardKey}
      onControlledHoverCardDismiss={onControlledHoverCardDismiss}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="flex h-full items-start gap-2.5">
        <div
          className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel)/0.72)] text-muted-foreground'
          )}
          title="User prompt"
        >
          <MessageSquareText size={13} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-graph-user)/0.72)]" />
            <span data-design-typography="soft-label" className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              User
            </span>
          </div>
          {isMinimalDetail ? (
            <div className="mt-3 h-1.5 w-full rounded-full bg-[hsl(var(--app-border)/0.58)]" />
          ) : (
            <p className={cn(
              'text-[12px] font-medium leading-snug text-foreground',
              detailLevel === 'compact' ? 'line-clamp-1' : 'line-clamp-2',
            )}>
              {entity.preview}
            </p>
          )}
        </div>
      </div>
    </GraphNodeWrapper>
  );
});

GraphUserNode.displayName = 'GraphUserNode';
