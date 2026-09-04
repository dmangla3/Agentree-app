import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Wrench, ChevronDown, Terminal, Tag, X, Hash, Sparkles, AlertTriangle, Copy, Check, CheckCircle2, GitCommitHorizontal, MessageSquarePlus } from 'lucide-react';
import { ChatCardWrapper } from './ChatCardWrapper';
import { ChatMarkdown } from './ChatMarkdown';
import { CopyMessageContentButton } from './CopyMessageContentButton';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { getAgentColorClass } from '../../../lib/graphUtils';
import { useAgents } from '../../../hooks/useAgents';
import type { AgentStatus } from '@shared/agentStatus';
import { buildTimelineRows, getToolSummary, isEmptyToolPayload, summarizeFileChangesPayload, ToolPayloadDisplay, type TimelineRow } from '../../ExecutionTimeline';
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
import { useWorkspaces } from '../../../hooks/useWorkspaces';
import { useAgentreeSurface } from '../../graph/surfaceCapabilities';
import { TokenUsagePill } from '../../TokenUsagePill';

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
  repoPath,
}: {
  text: string;
  isStreaming: boolean;
  repoPath?: string | null;
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
    <ChatMarkdown repoPath={repoPath}>{targetText}</ChatMarkdown>
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

  const label = isActivelyStreaming ? 'Writing response' : 'Agent running';

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative mt-3 overflow-hidden rounded-[1rem] border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.74)] px-3 py-2 shadow-[var(--app-shadow-soft)] backdrop-blur-xl"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--foreground)/0.16)] to-transparent" />
      <div className="absolute -left-10 top-0 h-full w-24 -skew-x-12 animate-pulse bg-gradient-to-r from-transparent via-[hsl(var(--app-success)/0.14)] to-transparent" />
      <div className="relative flex items-center gap-2.5">
        <div className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[hsl(var(--app-success)/0.24)] bg-[hsl(var(--app-success)/0.10)]">
          <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-[hsl(var(--app-success)/0.25)]" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-success))] shadow-[0_0_12px_hsl(var(--app-success)/0.45)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold leading-none tracking-[0.01em] text-foreground">
            {label}
          </div>
          <div className="mt-1 flex items-end gap-0.5" aria-hidden="true">
            {[0, 1, 2, 3].map((bar) => (
              <span
                key={bar}
                className="w-1 animate-pulse rounded-full bg-[hsl(var(--app-text-soft)/0.62)]"
                style={{
                  height: `${bar % 2 === 0 ? 5 : 8}px`,
                  animationDelay: `${bar * 120}ms`,
                  animationDuration: '900ms',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});



const getTimelineRowReactKey = (row: TimelineRow, index: number, prefix: string) =>
  `${prefix}:${row.key ?? 'row'}:${index}`;

const buildSanitizedWorkLogTimeline = (workLogs: unknown): any[] => {
  if (!Array.isArray(workLogs)) return [];

  return workLogs
    .filter((row) => row && typeof row === 'object')
    .map((row: any, index) => {
      const type = typeof row.type === 'string' && row.type.trim() ? row.type.trim() : 'tool_use';
      const label = typeof row.label === 'string' && row.label.trim()
        ? row.label.trim()
        : type.replace(/_/g, ' ');
      const status = typeof row.status === 'string' && row.status.trim() ? row.status.trim() : null;
      return {
        id: typeof row.id === 'string' && row.id.trim() ? row.id : `public-work-log-${index}`,
        type: type === 'thinking' || type === 'message' || type === 'error' || type === 'user_steer_requested' ? type : 'tool_use',
        toolName: label,
        content: typeof row.content === 'string' && row.content.trim() ? row.content : label,
        timestamp: typeof row.timestamp === 'string' && row.timestamp.trim() ? row.timestamp : undefined,
        durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : undefined,
        toolOutput: status === 'completed' ? '' : undefined,
        isError: status === 'failed' || status === 'error',
      };
    });
};

function InterleavedToolCard({
  row,
  allowExpansion = true,
}: {
  row: Extract<TimelineRow, { kind: 'tool' }>;
  allowExpansion?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = getToolSummary(row.toolName, row.toolInput) || getToolSummary(row.toolName, row.toolOutput) || row.toolName;
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
      <div
        className={cn(
          "flex min-w-0 w-full max-w-full items-start gap-2 rounded-md px-0 py-0.5 text-left",
          allowExpansion && "transition-[background-color,color] duration-150 hover:text-foreground/90",
          fileChangesPayload && allowExpansion && "-mx-1 px-1 py-0.5 hover:bg-muted/30",
          fileChangesPayload && !allowExpansion && "-mx-1 px-1 py-0.5"
        )}
        role={allowExpansion ? 'button' : undefined}
        tabIndex={allowExpansion ? 0 : undefined}
        aria-expanded={allowExpansion ? isExpanded : undefined}
        onClick={allowExpansion ? (event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        } : undefined}
        onKeyDown={allowExpansion ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setIsExpanded((value) => !value);
        } : undefined}
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
          {allowExpansion ? (
            <ChevronDown size={11} className={cn("text-muted-foreground/45 transition-transform", isExpanded && "rotate-180")} />
          ) : null}
        </div>
      </div>

      {allowExpansion && isExpanded ? (
        <div className="mt-1 ml-6 min-w-0 max-w-full space-y-2">
          {!isEmptyToolPayload(row.toolInput) ? (
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

function InterleavedExplorationCard({
  row,
  allowExpansion = true,
}: {
  row: Extract<TimelineRow, { kind: 'exploration' }>;
  allowExpansion?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const title = row.status === 'running' ? 'Exploring' : 'Explored';
  const duration = row.durationMs ? (row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`) : null;
  const stopCardFocus = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div className="min-w-0 max-w-full py-0.5" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
      <div
        className={cn(
          "flex min-w-0 w-full max-w-full items-start gap-2 px-0 py-0.5 text-left",
          allowExpansion && "transition-colors hover:text-foreground/90"
        )}
        role={allowExpansion ? 'button' : undefined}
        tabIndex={allowExpansion ? 0 : undefined}
        aria-expanded={allowExpansion ? isExpanded : undefined}
        onClick={allowExpansion ? (event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        } : undefined}
        onKeyDown={allowExpansion ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setIsExpanded((value) => !value);
        } : undefined}
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
          {allowExpansion ? (
            <ChevronDown size={11} className={cn("text-muted-foreground/45 transition-transform", isExpanded && "rotate-180")} />
          ) : null}
        </div>
      </div>

      {allowExpansion && isExpanded ? (
        <div className="mt-1 ml-6 min-w-0 max-w-full space-y-2">
          {row.toolCalls.map((call, index) => (
            <ToolPayloadDisplay key={call.key || index} payload={call.toolInput} className="max-h-40 min-w-0 max-w-full" variant="raw" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkLogsPanel({
  rows,
  repoPath,
  defaultOpen = false,
  allowToolExpansion = true,
}: {
  rows: TimelineRow[];
  repoPath?: string | null;
  defaultOpen?: boolean;
  allowToolExpansion?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setIsOpen(true);
  }, [defaultOpen]);
  if (rows.length === 0) return null;

  return (
    <div className="relative z-10 mt-2 mb-4 min-w-0 max-w-full rounded-xl border border-border/50 bg-muted/20">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((value) => !value);
        }}
        className="flex min-w-0 w-full max-w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/35"
        aria-expanded={isOpen}
        aria-label="Work logs"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Terminal size={13} className="shrink-0 text-muted-foreground/70" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Work logs
          </span>
          <span className="rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {rows.length}
          </span>
        </div>
        <ChevronDown size={13} className={cn("shrink-0 text-muted-foreground/55 transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen ? (
        <div className="min-w-0 max-w-full space-y-3 border-t border-border/40 px-3 py-3">
          {rows.map((row, index) => {
            if (row.kind === 'message') {
              if (!row.content) return null;
              return (
                <div
                  key={getTimelineRowReactKey(row, index, 'work-message')}
                  className="min-w-0 max-w-full rounded-lg border border-border/40 bg-background/75 px-3 py-2"
                >
                  <div className="min-w-0 max-w-full prose dark:prose-invert prose-sm max-w-none break-words text-[13px] leading-[1.55] [overflow-wrap:anywhere] prose-p:my-1 prose-li:my-0.5 prose-pre:my-1">
                    <StreamingMarkdown text={row.content} isStreaming={false} repoPath={repoPath} />
                  </div>
                </div>
              );
            }

            if (row.kind === 'tool') {
              return <InterleavedToolCard key={getTimelineRowReactKey(row, index, 'work-tool')} row={row} allowExpansion={allowToolExpansion} />;
            }

            if (row.kind === 'exploration') {
              return <InterleavedExplorationCard key={getTimelineRowReactKey(row, index, 'work-exploration')} row={row} allowExpansion={allowToolExpansion} />;
            }

            if (row.kind === 'thinking') {
              if (!row.content) return null;
              return (
                <div
                  key={getTimelineRowReactKey(row, index, 'work-thinking')}
                  className="min-w-0 max-w-full rounded-lg border border-blue-200/70 bg-blue-50/50 px-3 py-2 text-[11px] text-blue-900/80 dark:border-blue-900/70 dark:bg-blue-950/20 dark:text-blue-200/80"
                >
                  <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                    <Sparkles size={12} />
                    <span>Thinking</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{row.content}</p>
                </div>
              );
            }

            if (row.kind === 'user_steer') {
              if (!row.content) return null;
              return (
                <div
                  key={getTimelineRowReactKey(row, index, 'work-user-steer')}
                  className="min-w-0 max-w-full rounded-lg border border-violet-200/70 bg-violet-50/55 px-3 py-2 text-[11px] text-violet-950/85 dark:border-violet-900/70 dark:bg-violet-950/20 dark:text-violet-100/85"
                >
                  <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                    <MessageSquarePlus size={12} />
                    <span>User Steer</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{row.content}</p>
                </div>
              );
            }

            if (row.kind === 'error') {
              if (!row.content) return null;
              return (
                <div
                  key={getTimelineRowReactKey(row, index, 'work-error')}
                  className="min-w-0 max-w-full rounded-lg border border-red-200/70 bg-red-50/60 px-3 py-2 text-[11px] text-red-900/90 dark:border-red-900/70 dark:bg-red-950/20 dark:text-red-200/90"
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
      ) : null}
    </div>
  );
}

// Status indicator following the segmented pill style
const StatusBadge = ({
  status,
  failureReason,
}: {
  status: AgentStatus | null | undefined;
  failureReason?: string | null;
}) => {
  if (!status) return null;

  const config = getAgentVisualState(status);
  const Icon = config.icon;
  const title = isNodeFailureStatus(status) && failureReason
    ? `Agent ${config.label}: ${failureReason}`
    : undefined;

  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
      config.badgeContainerClass
    )} title={title}>
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
  const { surfaceMode, capabilities } = useAgentreeSurface();
  const isPublicShare = surfaceMode === 'public-share';
  const [copiedMessageId, setCopiedMessageId] = useState(false);
  const updateTagsMutation = useUpdateTags();
  const messageId = entity.message?.id ?? entity.messageId ?? null;
  useEffect(() => {
    if (isPublicShare) return;
    if (!messageId) return;
    agentRunManager.watch(messageId, 'chat-focus');
    return () => {
      agentRunManager.unwatch(messageId, 'chat-focus');
    };
  }, [isPublicShare, messageId]);
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
  const { data: workspaces = [] } = useWorkspaces();
  const repoPath = useMemo(() => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  }, [workspaces, workspaceId]);
  const tags = useMemo(() => message?.tags ?? [], [message?.tags]);
  const executionData = (message?.execution_data as any) ?? null;
  const timeline = useMemo(() => {
    const rawTimeline = Array.isArray(executionData?.timeline) ? executionData.timeline : [];
    if (rawTimeline.length > 0) return rawTimeline;
    return buildSanitizedWorkLogTimeline(executionData?.work_logs);
  }, [executionData]);
  const hasStructuredTimeline = useMemo(
    () => timeline.some((event: any) => event?.type && event.type !== 'message'),
    [timeline]
  );
  const transcriptRows = useMemo(
    () => hasStructuredTimeline ? buildTimelineRows(timeline) : [],
    [hasStructuredTimeline, timeline]
  );
  const hasInterleavedTranscript = useMemo(
    () => hasStructuredTimeline && transcriptRows.some((row) => row.kind === 'message' || row.kind === 'user_steer'),
    [hasStructuredTimeline, transcriptRows]
  );
  const showCompletedFinalOnly = displayStatus === 'completed' && hasStructuredTimeline;
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

  const workLogRows = useMemo(() => {
    if (!hasStructuredTimeline) return [];
    if (showCompletedFinalOnly) {
      const normalizedFinalContent = (message?.content || '').replace(/\s+/g, ' ').trim();
      return transcriptRows.filter((row) => {
        if (row.kind !== 'message') return true;
        const normalizedRowContent = (row.content || '').replace(/\s+/g, ' ').trim();
        return normalizedRowContent !== '' && normalizedRowContent !== normalizedFinalContent;
      });
    }
    if (hasInterleavedTranscript) return [];
    return transcriptRows.filter((row) => (
      row.kind === 'tool' ||
      row.kind === 'exploration' ||
      row.kind === 'thinking' ||
      row.kind === 'error'
    ));
  }, [hasInterleavedTranscript, hasStructuredTimeline, message?.content, showCompletedFinalOnly, transcriptRows]);

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
    if (!capabilities.canMutate) return;
    if (!workspaceId || !message?.id) return;
    updateTagsMutation.mutate({
      workspaceId,
      messageId: message.id,
      tags: [tagToRemove],
      action: 'remove',
    });
  };

  const handleAddTags = async (_messageId: string, newTags: string[]) => {
    if (!capabilities.canMutate) return;
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
        "group",
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
                <StatusBadge status={displayStatus as any} failureReason={failureReason} />
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
                <TokenUsagePill
                  promptTokens={promptTokens}
                  completionTokens={completionTokens}
                  cachedInputTokens={cachedInputTokens}
                  reasoningTokens={reasoningTokens}
                  totalTokens={totalTokens}
                />
                {tags.map((tag: string) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className={cn(
                      "group/tag relative h-5 cursor-default text-[11px] font-medium shadow-xs",
                      capabilities.canMutate && "pr-5"
                    )}
                  >
                    <span className="opacity-90">{tag}</span>
                    {capabilities.canMutate ? (
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
                    ) : null}
                  </Badge>
                ))}
                {capabilities.canMutate && message?.id ? (
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

      <WorkLogsPanel
        rows={workLogRows}
        repoPath={repoPath}
        defaultOpen={isPublicShare || shouldRevealStream}
        allowToolExpansion={capabilities.canExpandToolCalls}
      />

      {/* Content */}
      <div className="relative z-10 min-w-0 max-w-full">
        {hasInterleavedTranscript && !showCompletedFinalOnly ? (
          <div className="min-w-0 max-w-full space-y-3">
            {transcriptRows.map((row, index) => {
              if (row.kind === 'message') {
                if (!row.content) return null;
                return (
                  <div
                    key={getTimelineRowReactKey(row, index, 'message')}
                    className="min-w-0 max-w-full rounded-xl border border-border/40 bg-background/80 px-3 py-2.5 shadow-sm"
                  >
                    <div className="min-w-0 max-w-full prose dark:prose-invert prose-sm max-w-none break-words text-[14px] leading-[1.62] [overflow-wrap:anywhere] prose-p:my-1.5 prose-p:max-w-[74ch] prose-p:text-foreground/90 prose-p:leading-[1.62] prose-li:max-w-[74ch] prose-li:leading-[1.58] prose-pre:my-1.5 prose-pre:max-w-full prose-pre:whitespace-pre-wrap prose-pre:break-words prose-table:my-1.5 prose-th:py-1 prose-td:py-1">
                      <StreamingMarkdown text={row.content} isStreaming={shouldRevealStream} repoPath={repoPath} />
                    </div>
                  </div>
                );
              }

              if (row.kind === 'tool') {
                return <InterleavedToolCard key={getTimelineRowReactKey(row, index, 'tool')} row={row} allowExpansion={capabilities.canExpandToolCalls} />;
              }

              if (row.kind === 'exploration') {
                return <InterleavedExplorationCard key={getTimelineRowReactKey(row, index, 'exploration')} row={row} allowExpansion={capabilities.canExpandToolCalls} />;
              }

              if (row.kind === 'thinking') {
                if (!row.content) return null;
                return (
                  <div
                    key={getTimelineRowReactKey(row, index, 'thinking')}
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

              if (row.kind === 'user_steer') {
                if (!row.content) return null;
                return (
                  <div
                    key={getTimelineRowReactKey(row, index, 'user-steer')}
                    className="min-w-0 max-w-full rounded-xl border border-violet-200/70 bg-violet-50/55 px-3 py-2 text-[11px] text-violet-950/85 dark:border-violet-900/70 dark:bg-violet-950/20 dark:text-violet-100/85"
                  >
                    <div className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wide">
                      <MessageSquarePlus size={12} />
                      <span>User Steer</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{row.content}</p>
                  </div>
                );
              }

              if (row.kind === 'error') {
                if (!row.content) return null;
                return (
                  <div
                    key={getTimelineRowReactKey(row, index, 'error')}
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
            <StreamingMarkdown text={message?.content || ''} isStreaming={shouldRevealStream} repoPath={repoPath} />
          </div>
        )}
      </div>

      <CopyMessageContentButton
        text={message?.content}
        ariaLabel="Copy assistant response"
        title="Copy response"
        className={cn(
          "absolute bottom-2 right-2 z-20 h-6 w-6 bg-background/70 opacity-0 backdrop-blur-sm",
          "focus-visible:opacity-100 group-hover:opacity-100 dark:bg-slate-900/55"
        )}
      />

      <LiveComposerCue isStreaming={shouldRevealStream} text={streamingTailText} />
    </ChatCardWrapper>
  );
});

ChatAssistantCard.displayName = 'ChatAssistantCard';
