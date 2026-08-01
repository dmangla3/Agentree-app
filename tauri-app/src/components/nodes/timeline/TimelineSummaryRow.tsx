import { memo } from 'react';
import { Layers } from 'lucide-react';
import { TimelineRowWrapper } from './TimelineRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

export const TimelineSummaryRow = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  scopeColor,
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
    <TimelineRowWrapper
      rowId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      disableHoverCard={disableHoverCard}
      hoverCardContent={hoverCardContent}
      className={cn(ROLE_COLORS.summary_block.bg, "border-dashed border-l-2 mx-2")}
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300 italic whitespace-normal break-words leading-snug line-clamp-2">
          "{entity.preview}"
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] text-slate-500 w-full">
          <div className="flex min-w-0 items-center gap-1 p-0.5 px-1 bg-violet-100 dark:bg-violet-900/40 rounded text-violet-700 dark:text-violet-400">
            <Layers size={10} />
            <span className="font-semibold text-[9px] uppercase tracking-wider">Summary</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-slate-400 tabular-nums">
            {timestamp}
          </div>
        </div>
      </div>
    </TimelineRowWrapper>
  );
});

TimelineSummaryRow.displayName = 'TimelineSummaryRow';
