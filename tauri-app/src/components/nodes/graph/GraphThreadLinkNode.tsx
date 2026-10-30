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
      'border-[hsl(var(--app-graph-agent)/0.3)] bg-[hsl(var(--app-graph-agent)/0.075)] text-foreground shadow-[0_8px_20px_-18px_hsl(var(--foreground)/0.32)]'
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
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-graph-agent)/0.24)] bg-[hsl(var(--app-panel)/0.7)] text-[hsl(var(--app-graph-agent))]'
        )}
        title="Open thread"
      >
        <GitBranch size={13} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div data-design-typography="soft-label" className="text-[9px] font-medium uppercase tracking-[0.12em] text-[hsl(var(--app-graph-agent))]">
          Thread
        </div>
        <p className="truncate text-[12px] font-medium leading-snug text-foreground">
          {entity.preview || 'Open thread'}
        </p>
      </div>
    </div>
  </GraphNodeWrapper>
));

GraphThreadLinkNode.displayName = 'GraphThreadLinkNode';
