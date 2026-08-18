import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Wrench, ChevronDown, Terminal, Tag, X, Hash, Sigma, Sparkles, AlertTriangle, Copy, Check, CheckCircle2, GitCommitHorizontal, Zap } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { ChatMarkdown } from './ChatMarkdown';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { getAgentColorClass } from '../../../lib/graphUtils';
import { useAgents } from '../../../hooks/useAgents';
import type { AgentStatus } from '@shared/agentStatus';
import { buildTimelineRows, getToolSummary, summarizeFileChangesPayload, ToolPayloadDisplay, type TimelineRow } from '../../ExecutionTimeline';
import { useUpdateTags } from '../../../hooks/useMessages';
import { mergeLiveMessage } from '../../../hooks/useLiveMessages';
import { Badge } from '../../../../@/components/ui/badge';
import { TagInputPopover } from '../../ui/TagInputPopover';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { useAgentRunProjectionStore } from '../../../stores/agentRunProjectionStore';
import { resolveNodeState } from '../../../lib/runStateResolver';
import { agentRunManager } from '../../../agent-runs/agentRunManager';
import { recordAssistantTextVisible } from '../../../perf/agentRunVisibilityPerf';
import { getAssistantIdentityLabel } from '../../../lib/assistantIdentity';
import { getNodeFailureReason, isNodeFailureStatus } from '../../../lib/nodeFailureReason';

const AgentChip = ({
  agentId,
  llmModel,
  llmProvider,
}: {
  agentId?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
}) => {
  const { data: agents = [] } = useAgents();
  const agent = agents.find(a => a.id === agentId);

  const name = getAssistantIdentityLabel({
    agentName: agent?.name,
    llmModel,
    llmProvider,
  });
  const colorName = agent?.color;
  const colorClass = getAgentColorClass(colorName) || 'bg-slate-500';

  return (
    <div className={cn(
      "inline-flex min-w-0 max-w-[12rem] rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm",
      colorClass
    )}>
      <span className="truncate">{name}</span>
    </div>
  );
};

const AiLabelChip = ({ aiLabel }: { aiLabel?: string | null }) => {
  const label = aiLabel?.trim();
  if (!label) return null;

  return (
    <span
      className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`AI label: ${label}`}
    >
      <Tag size={9} strokeWidth={2.5} />
      <span className="truncate">{label}</span>
    </span>
  );
};

const isStreamingStatus = (
  status:
    | AgentStatus
    | 'creating'
    | 'initializing'
    | null
    | undefined
) =>
  status === 'creating' ||
  status === 'initializing' ||
  status === 'running' || status === 'streaming' || status === 'pending';

const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const targetText = typeof text === 'string' ? text : '';
  const [shouldRenderMarkdown, setShouldRenderMarkdown] = useState(!isStreaming);
  const idleRef = useRef<number | null>(null);

  useEffect(() => {
    const clearIdle = () => {
      if (idleRef.current === null) return;
      const idleApi = window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      if (typeof idleApi.cancelIdleCallback === 'function') {
        idleApi.cancelIdleCallback(idleRef.current);
      } else {
        window.clearTimeout(idleRef.current);
      }
      idleRef.current = null;
    };

    clearIdle();

    if (isStreaming) {
      setShouldRenderMarkdown(false);
      return clearIdle;
    }

    if (targetText.length > 0) {
      const enableMarkdown = () => {
        idleRef.current = null;
        setShouldRenderMarkdown(true);
      };
      if (targetText.length < 2000) {
        enableMarkdown();
      } else {
        const idleApi = window as Window & {
          requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        };
        if (typeof idleApi.requestIdleCallback === 'function') {
          idleRef.current = idleApi.requestIdleCallback(enableMarkdown, { timeout: 300 });
        } else {
          idleRef.current = window.setTimeout(enableMarkdown, 120);
        }
      }
    } else {
      setShouldRenderMarkdown(true);
    }

    return clearIdle;
  }, [isStreaming, targetText]);

  if (isStreaming || !shouldRenderMarkdown) {
    return <div className="min-w-0 max-w-full whitespace-pre-wrap break-words text-[14px] leading-[1.62] text-foreground/90 [overflow-wrap:anywhere]">{targetText}</div>;
  }

  return (
    <ChatMarkdown>{targetText}</ChatMarkdown>
  );
});

const LIVE_DELTA_ACTIVE_MS = 900;

function getStreamingTailText({
  hasInterleavedTranscript,
  transcriptRows,
  content,
}: {
  hasInterleavedTranscript: boolean;
  transcriptRows: TimelineRow[];
  content: string;
}) {
  if (!hasInterleavedTranscript) return content;

  for (let index = transcriptRows.length - 1; index >= 0; index -= 1) {
    const row = transcriptRows[index];
    if (row.kind === 'message' && row.content) {
      return row.content;
    }
  }

  return content;
}

const LiveComposerCue = memo(function LiveComposerCue({
  isStreaming,
  text,
}: {
  isStreaming: boolean;
  text: string;
}) {
  const [isActivelyStreaming, setIsActivelyStreaming] = useState(false);
  const inactiveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (inactiveTimerRef.current !== null) {
      window.clearTimeout(inactiveTimerRef.current);
      inactiveTimerRef.current = null;
    }

    if (!isStreaming) {
      setIsActivelyStreaming(false);
      return;
    }

    if (!text.trim()) {
      setIsActivelyStreaming(false);
      return;
    }

    setIsActivelyStreaming(true);
    inactiveTimerRef.current = window.setTimeout(() => {
      inactiveTimerRef.current = null;
      setIsActivelyStreaming(false);
    }, LIVE_DELTA_ACTIVE_MS);

    return () => {
      if (inactiveTimerRef.current !== null) {
        window.clearTimeout(inactiveTimerRef.current);
        inactiveTimerRef.current = null;
      }
    };
  }, [isStreaming, text]);

  if (!isStreaming) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative mt-3 overflow-hidden rounded-xl border border-sky-200/55 bg-gradient-to-r from-sky-50/90 via-white/75 to-cyan-50/80 px-3 py-2 shadow-[0_10px_30px_rgba(14,165,233,0.08)] dark:border-sky-900/60 dark:from-sky-950/30 dark:via-slate-950/10 dark:to-cyan-950/20"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-300/80 to-transparent dark:via-sky-500/50" />
      <div className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-white/55 via-white/25 to-transparent dark:from-white/5 dark:via-white/0 dark:to-transparent animate-pulse" />
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500/80 shadow-[0_0_10px_rgba(14,165,233,0.45)] animate-pulse" />
          {isActivelyStreaming ? (
            <span className="inline-flex h-4 items-end">
              <span className="h-4 w-[3px] rounded-full bg-sky-600/80 shadow-[0_0_10px_rgba(14,165,233,0.35)] animate-pulse dark:bg-sky-300/80" />
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="h-1.5 w-1.5 rounded-full bg-sky-500/75 animate-pulse dark:bg-sky-300/75"
                  style={{ animationDelay: `${dot * 160}ms` }}
                />
              ))}
            </span>
          )}
        </div>
        <div className="text-[11px] font-medium tracking-[0.01em] text-sky-900/70 dark:text-sky-100/70">
          {isActivelyStreaming ? 'Writing response' : 'working'}
        </div>
      </div>
    </div>
  );
});



const formatTokenValue = (value: number | null | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();
};

function InterleavedToolCard({ row }: { row: Extract<TimelineRow, { kind: 'tool' }> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = getToolSummary(row.toolName, row.toolInput) || row.toolName;
  const fileChangesPayload = summarizeFileChangesPayload(row.toolInput)
    ? row.toolInput
    : summarizeFileChangesPayload(row.toolOutput)
      ? row.toolOutput
      : null;
  const duration = row.durationMs ? (row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`) : null;
  const stopCardFocus = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div className="min-w-0 max-w-full py-0.5" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        }}
        className={cn(
          "flex min-w-0 w-full max-w-full items-start gap-2 rounded-md px-0 py-0.5 text-left",
          "transition-[background-color,color] duration-150 hover:text-foreground/90",
          fileChangesPayload && "-mx-1 px-1 py-0.5 hover:bg-muted/30"
        )}
        aria-expanded={isExpanded}
      >
        <div className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center",
          fileChangesPayload && "mt-1"
        )}>
          {row.isError ? <AlertTriangle size={11} className="text-red-500/80" /> : row.toolOutput !== undefined ? <CheckCircle2 size={11} className="text-emerald-600/80 dark:text-emerald-400/80" /> : <Terminal size={11} className="text-muted-foreground/55" />}
        </div>
        <div className="min-w-0 flex-1">
          {fileChangesPayload ? (
            <ToolPayloadDisplay payload={fileChangesPayload} className="shadow-none" />
          ) : (
            <div className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground/55" title={summary}>
              {summary}
            </div>
          )}
        </div>
        <div className={cn(
          "flex shrink-0 items-center gap-2",
          fileChangesPayload && "pt-1"
        )}>
          {duration ? <span className="text-[10px] font-mono text-muted-foreground/45">{duration}</span> : null}
          <ChevronDown size={11} className={cn("text-muted-foreground/45 transition-transform", isExpanded && "rotate-180")} />
        </div>
      </button>

      {isExpanded ? (
        <div className="mt-1 ml-6 min-w-0 max-w-full space-y-2">
          {row.toolInput !== undefined ? (
            <ToolPayloadDisplay payload={row.toolInput} className="max-h-40 min-w-0 max-w-full" variant="raw" />
          ) : null}
          {row.toolOutput !== undefined ? (
            <ToolPayloadDisplay payload={row.toolOutput} className="max-h-40 min-w-0 max-w-full" variant="raw" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function InterleavedExplorationCard({ row }: { row: Extract<TimelineRow, { kind: 'exploration' }> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const title = row.status === 'running' ? 'Exploring' : 'Explored';
  const duration = row.durationMs ? (row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`) : null;
  const stopCardFocus = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div className="min-w-0 max-w-full py-0.5" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        }}
        className="flex min-w-0 w-full max-w-full items-start gap-2 px-0 py-0.5 text-left transition-colors hover:text-foreground/90"
        aria-expanded={isExpanded}
      >
        <div className="flex h-4 w-4 shrink-0 items-center justify-center pt-0.5">
          {row.status === 'error'
            ? <AlertTriangle size={11} className="text-red-500/80" />
            : row.status === 'completed'
              ? <CheckCircle2 size={11} className="text-emerald-600/80 dark:text-emerald-400/80" />
              : <Terminal size={11} className="text-muted-foreground/55" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[11px] text-foreground/80">{title}</div>
          <div className="mt-1 space-y-1">
            {row.items.map((item, index) => (
              <div key={`${item.label}_${item.text}_${index}`} className="flex min-w-0 items-start gap-2">
                <span className="rounded border border-amber-200/70 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                  {item.label}
                </span>
                <span className="min-w-0 text-[11px] text-muted-foreground/70 break-words">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {duration ? <span className="text-[10px] font-mono text-muted-foreground/45">{duration}</span> : null}
          <ChevronDown size={11} className={cn("text-muted-foreground/45 transition-transform", isExpanded && "rotate-180")} />
        </div>
      </button>

      {isExpanded ? (
        <div className="mt-1 ml-6 min-w-0 max-w-full space-y-2">
          {row.toolCalls.map((call, index) => (
            <ToolPayloadDisplay key={call.key || index} payload={call.toolInput} className="max-h-40 min-w-0 max-w-full" variant="raw" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Status indicator following the segmented pill style
const StatusBadge = ({ status }: { status: AgentStatus | null | undefined }) => {
  if (!status) return null;

  const config = getAgentVisualState(status);
  const Icon = config.icon;

  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
      config.badgeContainerClass
    )}>
      <Icon size={10} className={cn(config.animate && "animate-spin")} strokeWidth={2.5} />
      {config.label}
    </span>
  );
};

export const ChatAssistantCard = memo(({
  entity,
  isFocused,
  isSelected,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const [copiedMessageId, setCopiedMessageId] = useState(false);
  const updateTagsMutation = useUpdateTags();
  const messageId = entity.message?.id ?? entity.messageId ?? null;
  useEffect(() => {
    if (!messageId) return;
    agentRunManager.watch(messageId, 'chat-focus');
    return () => {
      agentRunManager.unwatch(messageId, 'chat-focus');
    };
  }, [messageId]);
  const liveMessage = useAgentRunProjectionStore((state) => (
    messageId ? state.projectionsById[messageId] ?? null : null
  ));
  const message = useMemo(
    () => liveMessage ? mergeLiveMessage(entity.message ?? null, liveMessage) : entity.message,
    [entity.message, liveMessage]
  );
  const displayStatus = resolveNodeState(entity.message ?? null, liveMessage).status ?? entity.status;
  const contentLength = typeof message?.content === 'string' ? message.content.length : 0;
  const hasRenderableContent = contentLength > 0 && Boolean(message?.content?.trim());

  useEffect(() => {
    if (!messageId || !hasRenderableContent) return;
    recordAssistantTextVisible({
      nodeId: messageId,
      contentLength,
      status: displayStatus ?? null,
    });
  }, [contentLength, displayStatus, hasRenderableContent, messageId]);

  const workspaceId = message?.workspaceId ?? null;
  const tags = useMemo(() => message?.tags ?? [], [message?.tags]);
  const executionData = (message?.execution_data as any) ?? null;
  const timeline = executionData?.timeline || [];
  const hasStructuredTimeline = useMemo(
    () => timeline.some((event: any) => event?.type && event.type !== 'message'),
    [timeline]
  );
  const transcriptRows = useMemo(
    () => hasStructuredTimeline ? buildTimelineRows(timeline) : [],
    [hasStructuredTimeline, timeline]
  );
  const hasInterleavedTranscript = useMemo(
    () => hasStructuredTimeline && transcriptRows.some((row) => row.kind === 'message'),
    [hasStructuredTimeline, transcriptRows]
  );
  const usage = executionData?.usage ?? null;
  const providerErrorCode = executionData?.meta?.provider_error_code ?? null;
  const providerErrorMessage = executionData?.meta?.provider_error_message ?? null;
  const failureReason = isNodeFailureStatus(displayStatus)
    ? getNodeFailureReason(executionData, providerErrorMessage)
    : null;
  const promptTokens = message?.promptTokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? null;
  const completionTokens = message?.completionTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? null;
  const cachedInputTokens = typeof usage?.cached_input_tokens === 'number' ? usage.cached_input_tokens : null;
  const reasoningTokens = typeof usage?.reasoning_tokens === 'number' ? usage.reasoning_tokens : null;
  const totalTokens = entity.totalTokens ?? message?.totalTokens ?? usage?.total_tokens ?? (
    typeof promptTokens === 'number' || typeof completionTokens === 'number'
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null
  );

  const toolRows = useMemo(
    () => transcriptRows.filter((row) => row.kind === 'tool' || row.kind === 'exploration'),
    [transcriptRows]
  );

  const timestamp = message?.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const shouldRevealStream = isStreamingStatus(displayStatus as any);
  const streamingTailText = useMemo(
    () => getStreamingTailText({
      hasInterleavedTranscript,
      transcriptRows,
      content: message?.content || '',
    }),
    [hasInterleavedTranscript, message?.content, transcriptRows]
  );

  const handleRemoveTag = (tagToRemove: string) => {
    if (!workspaceId || !message?.id) return;
    updateTagsMutation.mutate({
      workspaceId,
      messageId: message.id,
      tags: [tagToRemove],
      action: 'remove',
    });
  };

  const handleAddTags = async (_messageId: string, newTags: string[]) => {
    if (!workspaceId || !message?.id) return;
    await updateTagsMutation.mutateAsync({
      workspaceId,
      messageId: message.id,
      tags: newTags,
      action: 'add',
    });
  };

  const handleCopyMessageId = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!message?.id) return;
    try {
      await navigator.clipboard.writeText(message.id);
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
      accentColor={ROLE_COLORS.assistant_message.accent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        ROLE_COLORS.assistant_message.bg,
        ROLE_COLORS.assistant_message.border
      )}
    >
      {/* Header */}
      <div className="relative z-10 mb-4 min-w-0 max-w-full">
        <div className="flex min-w-0 w-full max-w-full flex-wrap items-start gap-3">
          <div className="flex min-w-0 max-w-full flex-1 items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <AgentChip
                  agentId={message?.agent_id}
                  llmModel={message?.llmModel}
                  llmProvider={message?.llmProvider}
                />
                <StatusBadge status={displayStatus as any} />
                {entity.toolCallCount ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200/70 bg-amber-50/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    <Wrench size={9} strokeWidth={2.5} />
                    {entity.toolCallCount}
                  </span>
                ) : null}

                {entity.commitCount ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-blue-200/70 bg-blue-50/80 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                    <GitCommitHorizontal size={9} strokeWidth={2.5} />
                    {entity.commitCount}
                  </span>
                ) : null}
                {timestamp && (
                  <span className="basis-full text-[10px] text-muted-foreground/60 tabular-nums sm:ml-auto sm:basis-auto">
                    {timestamp}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {message?.id ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                      <Hash size={9} strokeWidth={2.5} />
                      {message.id.slice(0, 8)}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyMessageId}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="Copy message ID"
                      title="Copy message ID"
                    >
                      {copiedMessageId ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2.2} />}
                    </button>
                  </>
                ) : null}
                <AiLabelChip aiLabel={message?.aiLabel} />
                {/* Unified Token Display */}
                {(formatTokenValue(promptTokens) || formatTokenValue(completionTokens) || formatTokenValue(cachedInputTokens) || formatTokenValue(totalTokens)) ? (
                  <div className="inline-flex min-w-0 max-w-full flex-wrap items-center overflow-hidden rounded-lg border border-border/50 bg-muted/30 dark:bg-slate-800/50">
                    {/* Input tokens */}
                    {formatTokenValue(promptTokens) ? (
                      <span 
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 border-r border-border/30 last:border-r-0"
                        title={typeof promptTokens === 'number' ? `${promptTokens.toLocaleString()} input tokens sent as context for this response.` : undefined}
                      >
                        <Zap size={9} strokeWidth={2.5} className="text-emerald-500 dark:text-emerald-400" />
                        {formatTokenValue(promptTokens)}
                      </span>
                    ) : null}
                    {/* Output tokens */}
                    {formatTokenValue(completionTokens) ? (
                      <span 
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 border-r border-border/30 last:border-r-0"
                        title={typeof completionTokens === 'number' ? `${completionTokens.toLocaleString()} output tokens generated in this response.` : undefined}
                      >
                        <Zap size={9} strokeWidth={2.5} className="text-blue-500 dark:text-blue-400" />
                        {formatTokenValue(completionTokens)}
                      </span>
                    ) : null}
                    {/* Cached tokens */}
                    {formatTokenValue(cachedInputTokens) ? (
                      <span 
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 border-r border-border/30 last:border-r-0"
                        title={typeof cachedInputTokens === 'number' ? `${cachedInputTokens.toLocaleString()} cached input tokens reused from prior context.` : undefined}
                      >
                        <Sigma size={9} strokeWidth={2.5} className="text-cyan-500 dark:text-cyan-400" />
                        {formatTokenValue(cachedInputTokens)}
                      </span>
                    ) : null}
                    {/* Reasoning tokens */}
                    {formatTokenValue(reasoningTokens) ? (
                      <span 
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 border-r border-border/30 last:border-r-0"
                        title={typeof reasoningTokens === 'number' ? `${reasoningTokens.toLocaleString()} internal reasoning tokens used by the model.` : undefined}
                      >
                        <Sparkles size={9} strokeWidth={2.5} className="text-violet-500 dark:text-violet-400" />
                        {formatTokenValue(reasoningTokens)}
                      </span>
                    ) : null}
                    {/* Total tokens */}
                    {formatTokenValue(totalTokens) ? (
                      <span 
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/20"
                        title={typeof totalTokens === 'number' ? `${totalTokens.toLocaleString()} total input, output, cached, and reasoning tokens reported for this response.` : undefined}
                      >
                        <Sigma size={9} strokeWidth={2.5} className="text-amber-500 dark:text-amber-400" />
                        {formatTokenValue(totalTokens)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {tags.map((tag: string) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="group/tag relative h-5 cursor-default pr-5 text-[11px] font-medium shadow-xs"
                  >
                    <span className="opacity-90">{tag}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTag(tag);
                      }}
                      className="absolute bottom-[1px] right-[1px] top-[1px] flex h-[calc(100%-2px)] w-4 items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/tag:opacity-100"
                      aria-label={`Remove tag: ${tag}`}
                      title={`Remove tag: ${tag}`}
                    >
                      <X size={10} strokeWidth={2.5} />
                    </button>
                  </Badge>
                ))}
                {message?.id ? (
                  <TagInputPopover
                    messageId={message.id}
                    existingTags={tags}
                    onAddTags={handleAddTags}
                    triggerClassName="h-5 w-5 rounded-full border border-dashed border-border/60 p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    <Tag size={12} strokeWidth={2} />
                  </TagInputPopover>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {providerErrorCode === 'usage_limit_exceeded' && (
        <div className="relative z-10 mb-4 flex min-w-0 max-w-full items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="min-w-0">
            <div className="font-medium">Codex usage limit reached</div>
            <div className="mt-0.5 text-amber-900/90">
              {providerErrorMessage || 'Codex cannot start another run until the account limit resets.'}
            </div>
          </div>
        </div>
      )}

      {failureReason && (
        <div className="relative z-10 mb-4 flex min-w-0 max-w-full items-start gap-2 rounded-md border border-red-200/75 bg-red-50/80 px-3 py-2 text-sm text-red-950 dark:border-red-900/75 dark:bg-red-950/25 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
          <div className="min-w-0">
            <div className="font-medium">Failure reason</div>
            <div className="mt-0.5 break-words text-red-900/90 dark:text-red-100/85">
              {failureReason}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 min-w-0 max-w-full">
        {hasInterleavedTranscript ? (
          <div className="min-w-0 max-w-full space-y-3">
            {transcriptRows.map((row, index) => {
              if (row.kind === 'message') {
                if (!row.content) return null;
                return (
                  <div
                    key={row.key ?? `message-${index}`}
                    className="min-w-0 max-w-full rounded-xl border border-border/40 bg-background/80 px-3 py-2.5 shadow-sm"
                  >
                    <div className="min-w-0 max-w-full prose dark:prose-invert prose-sm max-w-none break-words text-[14px] leading-[1.62] [overflow-wrap:anywhere] prose-p:my-1.5 prose-p:max-w-[74ch] prose-p:text-foreground/90 prose-p:leading-[1.62] prose-li:max-w-[74ch] prose-li:leading-[1.58] prose-pre:my-1.5 prose-pre:max-w-full prose-pre:whitespace-pre-wrap prose-pre:break-words prose-table:my-1.5 prose-th:py-1 prose-td:py-1">
                      <StreamingMarkdown text={row.content} isStreaming={shouldRevealStream} />
                    </div>
                  </div>
                );
              }

              if (row.kind === 'tool') {
                return <InterleavedToolCard key={row.key ?? `tool-${index}`} row={row} />;
              }

              if (row.kind === 'exploration') {
                return <InterleavedExplorationCard key={row.key ?? `exploration-${index}`} row={row} />;
              }

              if (row.kind === 'thinking') {
                if (!row.content) return null;
                return (
                  <div
                    key={row.key ?? `thinking-${index}`}
                    className="min-w-0 max-w-full rounded-xl border border-blue-200/70 bg-blue-50/50 px-3 py-2 text-[11px] text-blue-900/80 dark:border-blue-900/70 dark:bg-blue-950/20 dark:text-blue-200/80"
                  >
                    <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                      <Sparkles size={12} />
                      <span>Thinking</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{row.content}</p>
                  </div>
                );
              }

              if (row.kind === 'error') {
                if (!row.content) return null;
                return (
                  <div
                    key={row.key ?? `error-${index}`}
                    className="min-w-0 max-w-full rounded-xl border border-red-200/70 bg-red-50/60 px-3 py-2 text-[11px] text-red-900/90 dark:border-red-900/70 dark:bg-red-950/20 dark:text-red-200/90"
                  >
                    <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                      <AlertTriangle size={12} />
                      <span>Error</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{row.content}</p>
                  </div>
                );
              }

              return null;
            })}
          </div>
        ) : (
          <div className="min-w-0 max-w-full prose dark:prose-invert prose-sm max-w-none break-words text-[14px] leading-[1.62] [overflow-wrap:anywhere] prose-p:my-1.5 prose-p:max-w-[74ch] prose-p:text-foreground/90 prose-p:leading-[1.62] prose-li:max-w-[74ch] prose-li:leading-[1.58] prose-pre:my-1.5 prose-pre:max-w-full prose-pre:whitespace-pre-wrap prose-pre:break-words prose-table:my-1.5 prose-th:py-1 prose-td:py-1">
            <StreamingMarkdown text={message?.content || ''} isStreaming={shouldRevealStream} />
          </div>
        )}
        <LiveComposerCue isStreaming={shouldRevealStream} text={streamingTailText} />
      </div>

      {/* Tool Calls Section */}
      {!hasInterleavedTranscript && toolRows.length > 0 && (
        <div className="relative z-10 mt-4 min-w-0 max-w-full border-t border-border/30 pt-3">
          {/* Section header */}
          <div className="flex items-center gap-2 mb-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-violet-200/60 bg-violet-50/80 text-violet-600 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-400">
              <Terminal size={12} strokeWidth={2} />
            </div>
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {toolRows.length} {toolRows.length === 1 ? 'Action' : 'Actions'}
            </span>
          </div>

          <div className="min-w-0 max-w-full space-y-1.5">
            {toolRows.map((row, index) => (
              row.kind === 'exploration'
                ? <InterleavedExplorationCard key={row.key ?? `exploration-tool-${index}`} row={row} />
                : <InterleavedToolCard key={row.key ?? `tool-only-${index}`} row={row} />
            ))}
          </div>
        </div>
      )}
    </ChatCardWrapper>
  );
});

ChatAssistantCard.displayName = 'ChatAssistantCard';
