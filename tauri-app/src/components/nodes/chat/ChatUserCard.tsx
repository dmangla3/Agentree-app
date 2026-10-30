import { memo, useMemo, useState, type MouseEvent } from 'react';
import { Check, Clock, Copy, Hash, Pencil, UserRound } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { ChatMarkdown } from './ChatMarkdown';
import { CopyMessageContentButton } from './CopyMessageContentButton';
import { SharedNodeProps } from '../../../types/nodes';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { cn } from '../../../lib/utils';
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { useAgentreeSurface } from '../../graph/surfaceCapabilities';
import { AttachmentPreview } from '../../AttachmentPreview';
import { getMessageHighlights } from '../../../lib/messageHighlights';
import { formatMessageTimestamp } from '../../../lib/messageTimestamp';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../@/components/ui/tooltip';

export const ChatUserCard = memo(({
  entity,
  isFocused,
  isSelected,
  layout,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const { capabilities, messageTimestampMode } = useAgentreeSurface();
  const { data: workspaces = [] } = useWorkspaces();
  const [copiedMessageId, setCopiedMessageId] = useState(false);
  const messageId = entity.message?.id ?? entity.messageId ?? null;
  const workspaceId = entity.message?.workspaceId ?? null;
	  const repoPath = useMemo(() => {
	    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
	    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
	  }, [workspaces, workspaceId]);
	  const highlights = useMemo(() => getMessageHighlights(entity.message), [entity.message?.annotations]);
  const timestamp = formatMessageTimestamp(entity.message?.createdAt, { mode: messageTimestampMode });
  const handleEditClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!entity.message) return;
    window.dispatchEvent(new CustomEvent('editUserMessage', {
      detail: { message: entity.message },
    }));
  };
  const handleCopyMessageId = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!messageId) return;
    try {
      await navigator.clipboard.writeText(messageId);
      setCopiedMessageId(true);
      window.setTimeout(() => setCopiedMessageId(false), 1200);
    } catch (_error) {
      // no-op
    }
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
      <div className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2",
        layout === 'hovercard' ? "mb-0" : "mb-3",
      )}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <div className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em]", ROLE_COLORS.user_message.chip)}>
            <UserRound size={10} strokeWidth={2} />
            <span>You</span>
          </div>
          {messageId ? (
            <span className="group/message-id inline-flex h-5 items-center rounded-md border border-[hsl(var(--app-border)/0.44)] bg-[hsl(var(--app-bg-muted)/0.68)] text-muted-foreground/62 tabular-nums">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    aria-label={`Message ID: ${messageId}`}
                    className="inline-flex h-full items-center gap-1 rounded-l-md px-1.5 text-[10px] font-normal outline-none focus-visible:bg-[hsl(var(--app-focus)/0.12)] focus-visible:text-foreground"
                  >
                    <Hash size={9} strokeWidth={2} className="text-muted-foreground/52" />
                    <span className="font-mono text-muted-foreground/76">{messageId.slice(0, 8)}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-72">
                  Unique ID for this message. Pass it to any agent to reference this message.
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={handleCopyMessageId}
                className="relative inline-flex h-5 w-5 items-center justify-center rounded-r-md border-l border-[hsl(var(--app-border)/0.34)] text-muted-foreground/55 opacity-45 transition-[background-color,color,opacity,transform] duration-normal ease-out-cubic after:absolute after:-inset-1 hover:bg-[hsl(var(--app-accent-soft)/0.34)] hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus)/0.24)] group-hover/message-id:opacity-100 active:scale-[0.96]"
                aria-label="Copy message ID"
                title="Copy message ID"
              >
                {copiedMessageId ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2.2} />}
              </button>
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {timestamp && (
            <div
              className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400 tabular-nums"
              title={timestamp.title}
            >
              <Clock size={10} className="opacity-70" />
              {timestamp.label}
            </div>
          )}
        </div>
      </div>

      {layout === 'hovercard' ? (
        <div
          data-agentree-message-header-separator="true"
          className="my-1.5 h-px w-full shrink-0 bg-[hsl(var(--app-border)/0.46)]"
        />
      ) : null}

      {/* Content */}
      <div className={cn(
        "prose prose-sm min-w-0 max-w-none break-words text-[14px] font-normal leading-[1.58] [overflow-wrap:anywhere]",
        "prose-p:my-1.5 prose-p:max-w-[74ch] prose-p:text-current prose-p:leading-[1.58] prose-li:max-w-[74ch] prose-li:leading-[1.56]",
        ROLE_COLORS.user_message.text
      )}>
	        <ChatMarkdown
	          repoPath={repoPath}
	          messageId={entity.message?.id ?? entity.messageId ?? null}
	          highlights={highlights}
	          highlightEnabled
	        >
	          {entity.message?.content || ''}
	        </ChatMarkdown>
      </div>

      {Array.isArray(entity.message?.attachments) && entity.message.attachments.length > 0 ? (
        <div className="relative z-10 mt-3 flex min-w-0 flex-wrap gap-2">
          {entity.message.attachments.map((attachment) => (
            <AttachmentPreview
              key={attachment.path}
              attachment={attachment}
              size="small"
              className="h-16 w-14"
            />
          ))}
        </div>
      ) : null}

      {capabilities.canMutate ? (
        <button
          type="button"
          onClick={handleEditClick}
          className={cn(
            "absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-normal ease-out-cubic active:scale-[0.96]",
            "bg-background/70 opacity-0 shadow-sm backdrop-blur-sm",
            "hover:bg-slate-200/80 hover:text-slate-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
            "group-hover:opacity-100 dark:bg-slate-900/55 dark:text-slate-400 dark:hover:bg-slate-700/80 dark:hover:text-slate-100"
          )}
          aria-label="Edit and run this message"
          title="Edit and run"
        >
          <Pencil size={12} strokeWidth={2} />
        </button>
      ) : null}

      <CopyMessageContentButton
        text={entity.message?.content}
        ariaLabel="Copy user message"
        title="Copy message"
        className={cn(
          "absolute bottom-2 z-20 h-8 w-8 bg-background/70 opacity-0 backdrop-blur-sm",
          capabilities.canMutate ? "right-11" : "right-2",
          "focus-visible:opacity-100 group-hover:opacity-100 dark:bg-slate-900/55"
        )}
      />
    </ChatCardWrapper>
  );
});

ChatUserCard.displayName = 'ChatUserCard';
