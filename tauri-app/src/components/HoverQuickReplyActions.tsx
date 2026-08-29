import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import TextareaAutosize from 'react-textarea-autosize';
import { Loader2, Reply, Square } from 'lucide-react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { Button } from '../../@/components/ui/button';
import { useHeadlessQuickReply } from '../hooks/useHeadlessQuickReply';
import { agentClient } from '../lib/agentClient';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { getHoverReplyMode, stopQuickReplyControlEvent } from '../lib/quickReply';
import { cn } from '../lib/utils';

const MAX_HOVER_QUICK_REPLY_DRAFTS = 200;
const hoverQuickReplyDrafts = new Map<string, string>();

const rememberHoverQuickReplyDraft = (draftKey: string, prompt: string) => {
  if (!prompt) {
    hoverQuickReplyDrafts.delete(draftKey);
    return;
  }
  hoverQuickReplyDrafts.delete(draftKey);
  hoverQuickReplyDrafts.set(draftKey, prompt);
  while (hoverQuickReplyDrafts.size > MAX_HOVER_QUICK_REPLY_DRAFTS) {
    const oldestDraftKey = hoverQuickReplyDrafts.keys().next().value;
    if (!oldestDraftKey) break;
    hoverQuickReplyDrafts.delete(oldestDraftKey);
  }
};

export function clearHoverQuickReplyDraftsForTest() {
  hoverQuickReplyDrafts.clear();
}

export function HoverQuickReplyActions({
  entity,
  projection,
  replyParentId,
  replyRunStatus,
  canReply,
  canSteer,
}: {
  entity: ProjectedNodeEntity;
  projection: WorkspaceProjection;
  replyParentId: string;
  replyRunStatus: string | null;
  canReply: boolean;
  canSteer: boolean;
}) {
  const queryClient = useQueryClient();
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const { sendQuickReply, sendSteeringReply, isSending, error } = useHeadlessQuickReply();
  const rawReplyMode = getHoverReplyMode(entity, replyRunStatus);
  const replyMode = rawReplyMode === 'steer' && !canSteer
    ? null
    : rawReplyMode === 'reply' && !canReply
      ? null
      : rawReplyMode;
  const isSteeringReply = replyMode === 'steer';
  const canCancelRunningAgent = isSteeringReply && !isCancelling;
  const inputLabel = isSteeringReply ? 'Steering prompt' : 'Quick reply prompt';
  const actionLabel = isSteeringReply ? 'Steer' : 'Quick Reply';
  const sendingLabel = isSteeringReply ? 'Steering' : 'Sending';
  const handleQuickReply = useCallback(async (draftPrompt: string): Promise<boolean> => {
    const prompt = draftPrompt.trim();
    const workspaceId = entity.message?.workspaceId ?? projection.messageMap.get(replyParentId)?.workspaceId ?? null;
    if (!prompt || isSending || !replyMode) return false;
    if (replyMode === 'steer') {
      await sendSteeringReply({
        assistantNodeId: replyParentId,
        prompt,
      });
      return true;
    }
    if (!workspaceId) return false;
    await sendQuickReply({
      workspaceId,
      replyParentId,
      prompt,
      messages: projection.messages,
    });
    return true;
  }, [entity.message?.workspaceId, isSending, projection.messageMap, projection.messages, replyMode, replyParentId, sendQuickReply, sendSteeringReply]);
  const handleCancelRunningAgent = useCallback(async () => {
    const workspaceId = entity.message?.workspaceId ?? projection.messageMap.get(replyParentId)?.workspaceId ?? null;
    const assistantMessage = projection.messageMap.get(replyParentId) ?? entity.message ?? null;
    if (!workspaceId || isCancelling) return;

    setCancelError(null);
    setIsCancelling(true);
    try {
      await agentClient.stopAgent(replyParentId);
      agentRunManager.dispatch(replyParentId, {
        type: 'cancel',
        reason: 'cancelled',
      }, {
        workspaceId,
        parentId: assistantMessage?.parentId ?? null,
        role: 'assistant',
        agentId: assistantMessage?.agent_id ?? null,
        content: assistantMessage?.content ?? '',
        executionData: (assistantMessage?.execution_data ?? {}) as Record<string, any>,
      });
      void scheduleMessagesRefreshWhenGraphIdle(queryClient, workspaceId, { reason: 'cancel-agent' });
      hoverQuickReplyDrafts.delete(replyParentId);
      setDraftResetVersion((version) => version + 1);
    } catch (caught) {
      console.error('[NodeHoverCardContent] Failed to stop agent:', caught);
      setCancelError('Unable to cancel this run.');
    } finally {
      setIsCancelling(false);
    }
  }, [entity.message, isCancelling, projection.messageMap, queryClient, replyParentId]);

  if (!replyMode) return null;

  return (
    <HoverQuickReplyComposer
      draftKey={replyParentId}
      inputLabel={inputLabel}
      actionLabel={actionLabel}
      sendingLabel={sendingLabel}
      placeholder={isSteeringReply ? 'Steer...' : 'Reply...'}
      isSending={isSending}
      isCancelling={isCancelling}
      isSteeringReply={isSteeringReply}
      canCancelRunningAgent={canCancelRunningAgent}
      error={error || cancelError}
      resetVersion={draftResetVersion}
      onSubmit={handleQuickReply}
      onCancelRunningAgent={handleCancelRunningAgent}
    />
  );
}

interface HoverQuickReplyComposerProps {
  draftKey: string;
  inputLabel: string;
  actionLabel: string;
  sendingLabel: string;
  placeholder: string;
  isSending: boolean;
  isCancelling: boolean;
  isSteeringReply: boolean;
  canCancelRunningAgent: boolean;
  error: string | null;
  resetVersion: number;
  onSubmit: (prompt: string) => Promise<boolean>;
  onCancelRunningAgent: () => Promise<void>;
}

const HoverQuickReplyComposer = memo(function HoverQuickReplyComposer({
  draftKey,
  inputLabel,
  actionLabel,
  sendingLabel,
  placeholder,
  isSending,
  isCancelling,
  isSteeringReply,
  canCancelRunningAgent,
  error,
  resetVersion,
  onSubmit,
  onCancelRunningAgent,
}: HoverQuickReplyComposerProps) {
  const [prompt, setPrompt] = useState(() => hoverQuickReplyDrafts.get(draftKey) ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastResetVersionRef = useRef(resetVersion);
  const canSendQuickReply = prompt.trim().length > 0 && !isSending && !isCancelling;

  useEffect(() => {
    setPrompt(hoverQuickReplyDrafts.get(draftKey) ?? '');
  }, [draftKey]);

  useEffect(() => {
    if (resetVersion === lastResetVersionRef.current) return;
    lastResetVersionRef.current = resetVersion;
    hoverQuickReplyDrafts.delete(draftKey);
    setPrompt('');
  }, [draftKey, resetVersion]);

  const focusInput = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const clearDraft = () => {
    hoverQuickReplyDrafts.delete(draftKey);
    setPrompt('');
  };

  const handlePromptChange = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    rememberHoverQuickReplyDraft(draftKey, nextPrompt);
  };

  const submit = async () => {
    try {
      const didSend = await onSubmit(prompt);
      if (didSend) {
        clearDraft();
      }
    } catch {
      // Error text is exposed through the quick reply hook state.
    } finally {
      window.requestAnimationFrame(focusInput);
    }
  };

  return (
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
      <TextareaAutosize
        ref={inputRef}
        aria-label={inputLabel}
        value={prompt}
        onChange={(event) => handlePromptChange(event.target.value)}
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
            void submit();
          }
        }}
        placeholder={placeholder}
        className="max-h-[132px] min-h-8 min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-bg-muted)/0.54)] px-3 py-1.5 text-xs leading-5 text-foreground shadow-[inset_0_1px_0_hsl(var(--background)/0.12)] outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-[hsl(var(--app-border-strong)/0.9)] focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus)/0.22)]"
        disabled={isSending || isCancelling}
        minRows={1}
        maxRows={6}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        cacheMeasurements
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
          void submit();
        }}
      >
        {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Reply className="h-3.5 w-3.5" />}
        {isSending ? sendingLabel : actionLabel}
      </Button>
      {isSteeringReply ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={cn(
            "h-8 shrink-0 gap-1.5 rounded-lg border border-[hsl(var(--app-border)/0.76)] px-2.5 text-xs font-medium text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--background)/0.16)] transition-[background-color,border-color,color,box-shadow,transform,opacity]",
            "hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]",
            "focus-visible:ring-[hsl(var(--app-focus)/0.22)]",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-muted-foreground"
          )}
          disabled={!canCancelRunningAgent}
          onPointerDown={stopQuickReplyControlEvent}
          onMouseDown={stopQuickReplyControlEvent}
          onPointerUp={stopQuickReplyControlEvent}
          onMouseUp={stopQuickReplyControlEvent}
          onClick={(event) => {
            event.preventDefault();
            stopQuickReplyControlEvent(event);
            void onCancelRunningAgent();
          }}
          aria-label="Cancel running agent"
        >
          {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
          {isCancelling ? 'Stopping' : 'Cancel'}
        </Button>
      ) : null}
      {error && (
        <div
          role="alert"
          className="max-w-[18rem] rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] leading-snug text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
});
