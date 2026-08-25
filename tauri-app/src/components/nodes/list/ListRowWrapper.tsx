import React, { memo } from 'react';
import { cn } from '../../../lib/utils';
import { CARD_TOKENS } from '../../../lib/visualTokens';
import { Checkbox } from '../../../../@/components/ui/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';

interface ListRowWrapperProps {
  children: React.ReactNode;
  rowId?: string;
  messageId?: string | null;
  isFocused: boolean;
  isSelected: boolean;
  disableHoverCard?: boolean;
  hoverCardContent?: React.ReactNode;
  onFocus: () => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  showSelectionControl?: boolean;
}

export const ListRowWrapper = memo(({
  children,
  rowId,
  messageId,
  isFocused,
  isSelected,
  disableHoverCard,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
  className,
  style,
  showSelectionControl = true
}: ListRowWrapperProps) => {
  const rowBody = (
    <div
      id={rowId}
      data-agentree-list-message-id={messageId || undefined}
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
        ...style,
        borderColor: isFocused
          ? '#6366f1'
          : isSelected
            ? '#3b82f6'
            : style?.borderColor,
      }}
      className={cn(
        "group relative flex w-full min-w-0 cursor-pointer items-start gap-2.5 border px-3 py-2.5 transition-[background-color,border-color,box-shadow,transform] duration-200",
        CARD_TOKENS.radius,
        isFocused
          ? "z-10 bg-[hsl(var(--app-accent-soft)/0.34)] shadow-md ring-2 ring-indigo-500"
          : "border-[hsl(var(--app-border)/0.58)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]",
        isSelected && "bg-[hsl(var(--app-accent-soft)/0.24)] ring-2 ring-blue-500",
        !isFocused && "hover:-translate-y-[1px] hover:border-[hsl(var(--app-border)/0.82)] hover:bg-[hsl(var(--app-panel-strong)/0.78)] hover:shadow-[0_12px_28px_-26px_hsl(var(--foreground)/0.48),inset_0_1px_0_hsl(var(--foreground)/0.04)] dark:hover:bg-white/[0.055]",
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

ListRowWrapper.displayName = 'ListRowWrapper';
