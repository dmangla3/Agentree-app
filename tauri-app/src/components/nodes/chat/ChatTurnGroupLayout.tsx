import React, { memo } from 'react';
import { cn } from '../../../lib/utils';

interface ChatTurnGroupLayoutProps {
  children: React.ReactNode;
  isFocused?: boolean;
}

export const ChatTurnGroupLayout = memo(({
  children,
  isFocused
}: ChatTurnGroupLayoutProps) => {
  return (
    <div
      data-design-scope="chat"
      data-design-part="chat-turn-group"
      data-design-focused={isFocused ? 'true' : 'false'}
      className={cn(
        "mb-4 box-border flex min-w-0 w-full max-w-full flex-col gap-1.5 rounded-xl px-3 py-2 transition-colors duration-normal ease-out-cubic last:mb-0 motion-reduce:transition-none md:px-5 md:py-3",
        isFocused && "bg-[hsl(var(--app-bg-muted)/0.62)]"
      )}
    >
      {children}
    </div>
  );
});

ChatTurnGroupLayout.displayName = 'ChatTurnGroupLayout';
