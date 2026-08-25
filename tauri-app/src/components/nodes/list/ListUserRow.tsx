import { memo } from 'react';
import { User } from 'lucide-react';
import { ListRowWrapper } from './ListRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';

export const ListUserRow = memo(({
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
  const timestamp = entity.message?.createdAt
    ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
      className="mx-1 border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-bg-muted)/0.62)] text-foreground dark:bg-white/[0.026]"
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        {/* Content */}
        <p className={cn("text-sm font-medium whitespace-normal break-words leading-snug min-w-0 line-clamp-2", ROLE_COLORS.user_message.text)}>
          {entity.preview}
        </p>

        {/* Footer Metrics */}
        <div className="mt-1 flex w-full flex-wrap items-center gap-2 gap-y-1 text-[10px] text-muted-foreground">
          <div className={cn("rounded border border-[hsl(var(--app-border)/0.48)] p-0.5", ROLE_COLORS.user_message.chip)} title="User message">
            <User size={10} />
          </div>
          <span className="font-semibold text-muted-foreground">User</span>
          <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-muted-foreground/70 tabular-nums">
            {timestamp}
          </div>
        </div>
      </div>
    </ListRowWrapper>
  );
});

ListUserRow.displayName = 'ListUserRow';
