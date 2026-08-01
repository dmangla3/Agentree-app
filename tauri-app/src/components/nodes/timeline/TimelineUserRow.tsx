import { memo } from 'react';
import { User } from 'lucide-react';
import { TimelineRowWrapper } from './TimelineRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

export const TimelineUserRow = memo(({
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
  const timestamp = entity.message?.createdAt
    ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
      className={cn(ROLE_COLORS.user_message.bg, ROLE_COLORS.user_message.border, "border mx-2")}
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        {/* Content */}
        <p className={cn("text-sm font-medium whitespace-normal break-words leading-snug min-w-0 line-clamp-2", ROLE_COLORS.user_message.text)}>
          {entity.preview}
        </p>

        {/* Footer Metrics */}
        <div className="flex flex-wrap items-center gap-2 mt-1 gap-y-1 text-[10px] text-slate-500 w-full">
          <div className={cn("p-0.5 rounded", ROLE_COLORS.user_message.chip)} title="User message">
            <User size={10} />
          </div>
          <span className="font-semibold text-slate-600 dark:text-slate-400">User</span>
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-slate-400 tabular-nums">
            {timestamp}
          </div>
        </div>
      </div>
    </TimelineRowWrapper>
  );
});

TimelineUserRow.displayName = 'TimelineUserRow';
