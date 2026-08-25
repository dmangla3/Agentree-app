import { memo, type MouseEvent } from 'react';
import { Sparkles, Clock, Pencil } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { ChatMarkdown } from './ChatMarkdown';
import { CopyMessageContentButton } from './CopyMessageContentButton';
import { SharedNodeProps } from '../../../types/nodes';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { cn } from '../../../lib/utils';

export const ChatUserCard = memo(({
  entity,
  isFocused,
  isSelected,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const timestamp = entity.message?.createdAt
    ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const handleEditClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!entity.message) return;
    window.dispatchEvent(new CustomEvent('editUserMessage', {
      detail: { message: entity.message },
    }));
  };

  return (
    <ChatCardWrapper
      focusTargetId={entity.focusMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      accentColor={ROLE_COLORS.user_message.accent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        "group",
        ROLE_COLORS.user_message.bg,
        ROLE_COLORS.user_message.border
      )}
    >
      {/* Header with timestamp pill */}
      <div className="mb-3 flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <div className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.15em]", ROLE_COLORS.user_message.chip)}>
            <Sparkles size={10} strokeWidth={2} />
            <span>You</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {timestamp && (
            <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
              <Clock size={10} className="opacity-70" />
              {timestamp}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className={cn(
        "prose prose-sm min-w-0 max-w-none break-words text-[14px] font-normal leading-[1.58] [overflow-wrap:anywhere]",
        "prose-p:my-1.5 prose-p:max-w-[74ch] prose-p:text-current prose-p:leading-[1.58] prose-li:max-w-[74ch] prose-li:leading-[1.56]",
        ROLE_COLORS.user_message.text
      )}>
        <ChatMarkdown>{entity.message?.content || ''}</ChatMarkdown>
      </div>

      <button
        type="button"
        onClick={handleEditClick}
        className={cn(
          "absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full text-slate-500 transition-colors",
          "bg-background/70 opacity-0 shadow-sm backdrop-blur-sm",
          "hover:bg-slate-200/80 hover:text-slate-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
          "group-hover:opacity-100 dark:bg-slate-900/55 dark:text-slate-400 dark:hover:bg-slate-700/80 dark:hover:text-slate-100"
        )}
        aria-label="Edit and run this message"
        title="Edit and run"
      >
        <Pencil size={12} strokeWidth={2} />
      </button>

      <CopyMessageContentButton
        text={entity.message?.content}
        ariaLabel="Copy user message"
        title="Copy message"
        className={cn(
          "absolute bottom-2 right-9 z-20 h-6 w-6 bg-background/70 opacity-0 backdrop-blur-sm",
          "focus-visible:opacity-100 group-hover:opacity-100 dark:bg-slate-900/55"
        )}
      />
    </ChatCardWrapper>
  );
});

ChatUserCard.displayName = 'ChatUserCard';
