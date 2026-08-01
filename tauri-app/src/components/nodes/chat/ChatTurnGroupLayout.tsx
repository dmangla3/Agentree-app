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
    <div className={cn(
      "box-border flex min-w-0 w-full max-w-full flex-col gap-1.5 px-3 py-3 md:px-6 md:py-4 mb-8 last:mb-0 rounded-[28px] transition-colors",
      isFocused && "bg-slate-100/90 dark:bg-slate-900/30"
    )}>
      {children}
    </div>
  );
});

ChatTurnGroupLayout.displayName = 'ChatTurnGroupLayout';
