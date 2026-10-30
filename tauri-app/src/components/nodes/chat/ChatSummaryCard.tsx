import { memo } from 'react';
import { Sparkles, FileText, Quote } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';

export const ChatSummaryCard = memo(({
  entity,
  isFocused,
  isSelected,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  return (
    <ChatCardWrapper
      focusTargetId={entity.focusMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        'border-[hsl(var(--app-graph-summary)/0.24)] bg-[hsl(var(--app-graph-summary)/0.055)]'
      )}
    >
      {/* Header */}
      <div className="mb-4 flex min-w-0 max-w-full items-center gap-3">
        {/* Summary Icon */}
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[hsl(var(--app-graph-summary)/0.22)] bg-[hsl(var(--app-graph-summary)/0.09)] text-[hsl(var(--app-graph-summary))]">
          <Sparkles size={16} strokeWidth={2} />
        </div>
        
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            Summary
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--app-graph-summary)/0.22)] bg-[hsl(var(--app-graph-summary)/0.08)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--app-graph-summary))]">
            <FileText size={8} strokeWidth={2} />
            Compressed
          </span>
        </div>
      </div>

      {/* Content with quote styling */}
      <div className="relative min-w-0 max-w-full">
        <Quote size={20} className="absolute -left-1 -top-1 text-[hsl(var(--app-graph-summary)/0.26)]" strokeWidth={1.5} />
        
        <div className="min-w-0 max-w-full break-words pl-6 text-[14px] text-foreground/90 leading-relaxed font-medium [overflow-wrap:anywhere]">
          {entity.summary?.content || entity.preview}
        </div>
      </div>

      {/* Footer hint */}
      <div className="mt-4 flex min-w-0 max-w-full items-center gap-2 border-t border-[hsl(var(--app-border)/0.48)] pt-3 text-[10px] text-muted-foreground/70">
        <div className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-graph-summary))]" />
        <span>Condensed from previous workspace context</span>
      </div>
    </ChatCardWrapper>
  );
});

ChatSummaryCard.displayName = 'ChatSummaryCard';
