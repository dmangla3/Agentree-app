import { memo } from 'react';
import { Layers } from 'lucide-react';
import { ListRowWrapper } from './ListRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

export const ListSummaryRow = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  showSelectionControl,
  disableHoverCard,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const timestamp = entity.sortTs
    ? new Date(entity.sortTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <ListRowWrapper
      rowId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      disableHoverCard={disableHoverCard}
      hoverCardContent={hoverCardContent}
      className="mx-1 border-dashed border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.46)] dark:bg-white/[0.025]"
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="whitespace-normal break-words text-sm font-medium italic leading-snug text-muted-foreground line-clamp-2">
          "{entity.preview}"
        </p>
        <div className="mt-1 flex w-full flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <div className={cn("flex min-w-0 items-center gap-1 rounded border border-[hsl(var(--app-border)/0.48)] px-1 py-0.5", ROLE_COLORS.summary_block.chip)}>
            <Layers size={10} />
            <span data-design-typography="soft-label" className="text-[9px] font-medium uppercase tracking-wider">Summary</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-muted-foreground/70 tabular-nums">
            {timestamp}
          </div>
        </div>
      </div>
    </ListRowWrapper>
  );
});

ListSummaryRow.displayName = 'ListSummaryRow';
