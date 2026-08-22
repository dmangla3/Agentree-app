import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { NodePreviewRenderer } from './NodePreviewRenderer';
import { Button } from '../../@/components/ui/button';
import { Input } from '../../@/components/ui/input';
import { Loader2, Reply } from 'lucide-react';
import { useHeadlessQuickReply } from '../hooks/useHeadlessQuickReply';
import { useRunStatusStore } from '../stores/runStatusStore';
import { getHoverReplyMode, stopQuickReplyControlEvent } from '../lib/quickReply';
import { cn } from '../lib/utils';
import { isActiveAgentRunStatus } from '../lib/agentRunSteering';

interface NodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  projection?: WorkspaceProjection;
  headerAccessory?: ReactNode;
}

export function NodeHoverCardContent({ entity, projection, headerAccessory }: NodeHoverCardContentProps) {
  const [quickReplyPrompt, setQuickReplyPrompt] = useState('');
  const quickReplyInputRef = useRef<HTMLInputElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const { sendQuickReply, sendSteeringReply, isSending, error } = useHeadlessQuickReply();
  const replyParentId = entity?.focusMessageId || entity?.messageId || null;
  const replyRunStatus = useRunStatusStore((state) => (
    replyParentId ? state.byNodeId[replyParentId]?.status ?? null : null
  ));
  const resolvedRunStatus = replyRunStatus ?? entity?.status ?? entity?.message?.status ?? null;
  const isAssistantAgentHover = entity?.message?.role === 'assistant' || entity?.kind === 'assistant_message';
  const shouldDefaultScrollPreviewToBottom = isAssistantAgentHover && isActiveAgentRunStatus(resolvedRunStatus);
  useLayoutEffect(() => {
    if (!shouldDefaultScrollPreviewToBottom) return;
    const scrollArea = previewScrollRef.current;
    if (!scrollArea) return;

    let settledFrameId: number | null = null;
    const scrollToBottom = () => {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    };

    scrollToBottom();
    const frameId = window.requestAnimationFrame(() => {
      scrollToBottom();
      settledFrameId = window.requestAnimationFrame(scrollToBottom);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (settledFrameId !== null) {
        window.cancelAnimationFrame(settledFrameId);
      }
    };
  }, [replyParentId, shouldDefaultScrollPreviewToBottom]);

  if (!entity || !projection) return null;
  const replyMode = getHoverReplyMode(entity, replyRunStatus);
  const showReplyAction = Boolean(replyMode && replyParentId);
  const canSendQuickReply = quickReplyPrompt.trim().length > 0 && !isSending;
  const isSteeringReply = replyMode === 'steer';
  const inputLabel = isSteeringReply ? 'Steering prompt' : 'Quick reply prompt';
  const actionLabel = isSteeringReply ? 'Steer' : 'Quick Reply';
  const sendingLabel = isSteeringReply ? 'Steering' : 'Sending';
  const focusQuickReplyInput = () => {
    const input = quickReplyInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const handleQuickReply = async () => {
    const prompt = quickReplyPrompt.trim();
    const workspaceId = entity.message?.workspaceId ?? projection.messageMap.get(replyParentId ?? '')?.workspaceId ?? null;
    if (!replyParentId || !prompt || isSending || !replyMode) return;
    try {
      if (replyMode === 'steer') {
        await sendSteeringReply({
          assistantNodeId: replyParentId,
          prompt,
        });
      } else {
        if (!workspaceId) return;
        await sendQuickReply({
          workspaceId,
          replyParentId,
          prompt,
          messages: projection.messages,
        });
      }
      setQuickReplyPrompt('');
      window.requestAnimationFrame(() => {
        focusQuickReplyInput();
      });
    } catch {
      // Error text is exposed through the hook state.
      window.requestAnimationFrame(focusQuickReplyInput);
    }
  };

  return (
    <div
      data-agentree-node-hover-card="true"
      className="flex w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] max-w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] flex-col overflow-hidden rounded-[24px] border border-[hsl(var(--app-border)/0.76)] bg-[hsl(var(--app-panel)/0.96)] p-3 text-foreground shadow-[0_24px_64px_-40px_hsl(var(--foreground)/0.58),0_10px_24px_-20px_hsl(var(--foreground)/0.32),inset_0_1px_0_hsl(var(--background)/0.22)]"
    >
      {headerAccessory}
      <div
        ref={previewScrollRef}
        className="max-h-[calc(min(70vh,720px)-1.5rem)] w-full overflow-y-auto overscroll-contain"
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="min-w-0">
          <div className="min-w-0 rounded-[20px] border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.42)] p-1 shadow-[inset_0_1px_0_hsl(var(--background)/0.16)]">
            <NodePreviewRenderer entity={entity} projection={projection} />
          </div>
        </div>
      </div>
      {showReplyAction && replyParentId && (
        <div
          className="mt-3 flex items-center gap-2 border-t border-[hsl(var(--app-border)/0.62)] pt-3"
          onPointerDown={stopQuickReplyControlEvent}
          onMouseDown={stopQuickReplyControlEvent}
          onPointerUp={stopQuickReplyControlEvent}
          onMouseUp={stopQuickReplyControlEvent}
          onClick={stopQuickReplyControlEvent}
          onDoubleClick={stopQuickReplyControlEvent}
          onFocus={stopQuickReplyControlEvent}
        >
          <Input
            ref={quickReplyInputRef}
            aria-label={inputLabel}
            value={quickReplyPrompt}
            onChange={(event) => setQuickReplyPrompt(event.target.value)}
            onPointerDown={stopQuickReplyControlEvent}
            onMouseDown={stopQuickReplyControlEvent}
            onPointerUp={stopQuickReplyControlEvent}
            onMouseUp={stopQuickReplyControlEvent}
            onClick={stopQuickReplyControlEvent}
            onFocus={stopQuickReplyControlEvent}
            onKeyDown={(event) => {
              stopQuickReplyControlEvent(event);
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleQuickReply();
              }
            }}
            placeholder={isSteeringReply ? 'Steer...' : 'Reply...'}
            className="h-8 min-w-0 flex-1 rounded-lg border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-bg-muted)/0.54)] text-xs shadow-[inset_0_1px_0_hsl(var(--background)/0.12)] focus-visible:border-[hsl(var(--app-border-strong)/0.9)] focus-visible:ring-[hsl(var(--app-focus)/0.22)]"
            disabled={isSending}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={cn(
              "h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium transition-[background-color,color,box-shadow,transform,opacity]",
              canSendQuickReply && "border border-[hsl(var(--app-accent)/0.48)] bg-[hsl(var(--app-accent))] text-white shadow-[0_12px_28px_-20px_hsl(var(--app-accent)/0.72),inset_0_1px_0_rgba(255,255,255,0.16)] hover:brightness-105 dark:text-white"
            )}
            disabled={!canSendQuickReply}
            onPointerDown={stopQuickReplyControlEvent}
            onMouseDown={stopQuickReplyControlEvent}
            onPointerUp={stopQuickReplyControlEvent}
            onMouseUp={stopQuickReplyControlEvent}
            onClick={(event) => {
              event.preventDefault();
              stopQuickReplyControlEvent(event);
              void handleQuickReply();
            }}
          >
            {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Reply className="h-3.5 w-3.5" />}
            {isSending ? sendingLabel : actionLabel}
          </Button>
          {error && <div className="sr-only" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
