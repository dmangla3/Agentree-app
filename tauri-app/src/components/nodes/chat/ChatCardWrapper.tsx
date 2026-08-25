import React, { memo } from 'react';
import { cn } from '../../../lib/utils';
import { CARD_TOKENS } from '../../../lib/visualTokens';

interface ChatCardWrapperProps {
  children: React.ReactNode;
  focusTargetId?: string | null;
  isFocused: boolean;
  isSelected: boolean;
  accentColor?: string;
  className?: string;
  style?: React.CSSProperties;
  onFocus: () => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const ChatCardWrapper = memo(({
  children,
  focusTargetId,
  isFocused,
  isSelected,
  accentColor,
  className,
  style,
  onFocus,
  onSelect,
  onContextMenu
}: ChatCardWrapperProps) => {
  return (
    <div
      data-chat-focus-id={focusTargetId || undefined}
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
        // Base styles
        "relative box-border flex min-w-0 w-full max-w-full overflow-hidden",
        CARD_TOKENS.radius,
        CARD_TOKENS.border,
        "bg-clip-padding",
        "transition-[border-color,box-shadow,transform] duration-200 ease-out",

        // Shadow
        CARD_TOKENS.shadow,

        // Focused state
        isFocused && [
          "ring-2 ring-indigo-500",
          "shadow-md"
        ],

        // Selected state
        isSelected && !isFocused && [
          "ring-2 ring-blue-500/20",
          "shadow-md"
        ],

        // Hover effect
        "hover:border-border hover:-translate-y-[1px] hover:shadow-md",

        className
      )}
    >
      {/* Accent Strip */}
      {accentColor && (
        <div className={cn("w-[3px] shrink-0", accentColor)} />
      )}

      {/* Content wrapper */}
      <div className="relative flex min-w-0 w-full max-w-full flex-1 flex-col">
        {/* Content */}
        <div className="relative flex min-w-0 w-full max-w-full flex-1 flex-col px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
});

ChatCardWrapper.displayName = 'ChatCardWrapper';
