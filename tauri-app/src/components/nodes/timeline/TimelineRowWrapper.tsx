import React, { memo } from 'react';
import { cn } from '../../../lib/utils';
import { CARD_TOKENS } from '../../../lib/visualTokens';
import { Checkbox } from '../../../../@/components/ui/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';

interface TimelineRowWrapperProps {
  children: React.ReactNode;
  rowId?: string;
  messageId?: string | null;
  isFocused: boolean;
  isSelected: boolean;
  disableHoverCard?: boolean;
  hoverCardContent?: React.ReactNode;
  scopeColor?: string | null;
  onFocus: () => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  showSelectionControl?: boolean;
}

export const TimelineRowWrapper = memo(({
  children,
  rowId,
  messageId,
  isFocused,
  isSelected,
  disableHoverCard,
  hoverCardContent,
  scopeColor,
  onFocus,
  onSelect,
  onContextMenu,
  className,
  style,
  showSelectionControl = true
}: TimelineRowWrapperProps) => {
  const rowBody = (
    <div
      id={rowId}
      data-agentree-timeline-message-id={messageId || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          onSelect(true);
          return;
        }
        onFocus();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
      style={{
        borderLeftColor: isFocused ? undefined : scopeColor || undefined,
        ...style
      }}
      className={cn(
        "group relative flex items-start gap-2.5 px-3 py-2 cursor-pointer transition-all duration-200 border w-full min-w-0",
        CARD_TOKENS.radius,
        isFocused ? "bg-primary/5 dark:bg-primary/10 border-primary ring-2 ring-primary/20 shadow-md z-10" : "border-transparent",
        isSelected && "bg-blue-50/50 dark:bg-blue-950/20",
        !isFocused && "hover:-translate-y-[1px] hover:shadow-sm",
        className
      )}
    >
      {showSelectionControl && (
        <div className="flex flex-col items-center justify-start relative z-10 w-[14px] shrink-0 mt-[3px]">
          <div onClick={(e) => { e.stopPropagation(); onSelect(e.metaKey || e.ctrlKey || e.shiftKey); }}>
            <Checkbox checked={isSelected} className="h-3.5 w-3.5" />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col gap-1.5 min-w-0 relative z-10">
        {children}
      </div>
    </div>
  );

  if (!hoverCardContent || disableHoverCard) {
    return rowBody;
  }

  return (
    <HoverCard openDelay={500} closeDelay={120}>
      <HoverCardTrigger asChild>
        {rowBody}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="center" sideOffset={8} className="w-auto border-none bg-transparent p-0 shadow-none z-50">
        {hoverCardContent}
      </HoverCardContent>
    </HoverCard>
  );
});

TimelineRowWrapper.displayName = 'TimelineRowWrapper';
