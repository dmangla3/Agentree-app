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
      data-design-scope="nodes"
      data-design-part="chat-node"
      data-design-focused={isFocused ? 'true' : 'false'}
      data-design-selected={isSelected ? 'true' : 'false'}
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
          ? 'hsl(var(--app-selection) / 0.92)'
          : isSelected
            ? 'hsl(var(--app-selection) / 0.68)'
            : style?.borderColor,
      }}
      className={cn(
        // Base styles
        "relative box-border flex min-w-0 w-full max-w-full overflow-hidden",
        CARD_TOKENS.radius,
        "rounded-xl",
        CARD_TOKENS.border,
        "bg-clip-padding",
        "transition-[border-color,box-shadow,transform] duration-normal ease-out-cubic motion-reduce:transition-none",

        // Shadow
        CARD_TOKENS.shadow,

        // Focused state
        isFocused && [
          "ring-2 ring-[hsl(var(--app-selection)/0.9)]",
          "shadow-[0_12px_30px_-26px_hsl(var(--foreground)/0.42)]"
        ],

        // Selected state
        isSelected && !isFocused && [
          "ring-2 ring-[hsl(var(--app-selection)/0.48)]",
          "shadow-[0_12px_30px_-26px_hsl(var(--foreground)/0.42)]"
        ],

        // Hover effect
        "hover:border-[hsl(var(--app-border-strong)/0.76)] hover:shadow-[0_12px_30px_-26px_hsl(var(--foreground)/0.38)]",

        className
      )}
    >
      {/* Accent Strip */}
      {accentColor && (
        <div data-design-part="chat-node-accent" className={cn("w-0.5 shrink-0", accentColor)} />
      )}

      {/* Content wrapper */}
      <div className="relative flex min-w-0 w-full max-w-full flex-1 flex-col">
        {/* Content */}
        <div data-design-part="chat-node-body" className="relative flex min-w-0 w-full max-w-full flex-1 flex-col px-3.5 py-3">
          {children}
        </div>
      </div>
    </div>
  );
});

ChatCardWrapper.displayName = 'ChatCardWrapper';
