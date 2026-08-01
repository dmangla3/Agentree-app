import { memo } from 'react';
import { Sparkles, FileText, Quote } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';

export const ChatSummaryCard = memo(({
  entity,
  isFocused,
  isSelected,
  scopeColor,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  return (
    <ChatCardWrapper
      focusTargetId={entity.focusMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      scopeColor={scopeColor}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        "bg-gradient-to-br from-violet-50/80 via-purple-50/60 to-fuchsia-50/30",
        "dark:from-violet-950/25 dark:via-purple-950/20 dark:to-fuchsia-950/10"
      )}
    >
      {/* Header */}
      <div className="mb-4 flex min-w-0 max-w-full items-center gap-3">
        {/* Summary Icon */}
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-200/60 bg-gradient-to-br from-violet-100 to-purple-50 text-violet-600 shadow-sm dark:border-violet-800 dark:from-violet-950/50 dark:to-purple-950/40 dark:text-violet-400">
          <Sparkles size={16} strokeWidth={2} />
        </div>
        
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">
            Summary
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-200/70 bg-violet-50/80 px-1.5 py-0.5 text-[9px] font-medium text-violet-600 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-400">
            <FileText size={8} strokeWidth={2} />
            Compressed
          </span>
        </div>
      </div>

      {/* Content with quote styling */}
      <div className="relative min-w-0 max-w-full">
        <Quote size={20} className="absolute -top-1 -left-1 text-violet-200 dark:text-violet-800/40" strokeWidth={1.5} />
        
        <div className="min-w-0 max-w-full break-words pl-6 text-[14px] text-foreground/90 leading-relaxed font-medium [overflow-wrap:anywhere]">
          {entity.summary?.content || entity.preview}
        </div>
      </div>

      {/* Footer hint */}
      <div className="mt-4 flex min-w-0 max-w-full items-center gap-2 border-t border-violet-200/30 pt-3 text-[10px] text-muted-foreground/70 dark:border-violet-800/20">
        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
        <span>Condensed from previous workspace context</span>
      </div>
    </ChatCardWrapper>
  );
});

ChatSummaryCard.displayName = 'ChatSummaryCard';
