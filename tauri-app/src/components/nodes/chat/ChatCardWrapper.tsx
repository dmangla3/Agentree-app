import React, { memo } from 'react';
import { cn } from '../../../lib/utils';
import { withHexAlpha, CARD_TOKENS } from '../../../lib/visualTokens';

interface ChatCardWrapperProps {
  children: React.ReactNode;
  focusTargetId?: string | null;
  isFocused: boolean;
  isSelected: boolean;
  scopeColor?: string | null;
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
  scopeColor,
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
        borderColor: isFocused || isSelected ? undefined : scopeColor ? withHexAlpha(scopeColor, '40') : undefined,
        ...style
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
          "border-primary/50",
          "ring-2 ring-primary/20",
          "shadow-md"
        ],

        // Selected state
        isSelected && !isFocused && [
          "border-blue-400/50",
          "ring-2 ring-blue-500/20",
          "shadow-md"
        ],

        // Default border
        !isFocused && !isSelected && [
          scopeColor && "border-opacity-40"
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
        {/* Subtle inner glow for scoped cards */}
        {scopeColor && (
          <div
            className="absolute inset-0 pointer-events-none opacity-40"
            style={{
              background: `radial-gradient(ellipse at top, ${withHexAlpha(scopeColor, '12')} 0%, transparent 60%)`
            }}
          />
        )}

        {/* Content */}
        <div className="relative flex min-w-0 w-full max-w-full flex-1 flex-col px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
});

ChatCardWrapper.displayName = 'ChatCardWrapper';
