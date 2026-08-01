import { lazy, Suspense, useState, useMemo, useEffect } from 'react';
import { cn } from '../lib/utils';
import { Clipboard, Check, Globe, Tag, X, BrainCircuit, ChevronDown, ChevronUp, FileText, MessageSquarePlus, MessageSquare, Clock, Hash, Sigma, Settings2, Pilcrow, FileCode2, FilePlus, FilePen, Terminal, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { calculateCumulativeTokens } from '../lib/graphUtils';
import { useMessages, useSummaries } from '../hooks/useMessages';
import { Summary, useWorkspaceStore } from '../stores/workspaceStore';
import { OptimisticMessageIndicator, isOptimisticMessage } from './OptimisticMessageIndicator';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { AgentToolPanel } from './AgentToolPanel';
import { NodeLink, extractNodeMappings } from './NodeLink';
import { Button } from '../../@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Message } from '../stores/workspaceStore';
import { useUpdateTags, useAddComment, useDeleteComment } from '../hooks/useMessages';
import { Badge } from "../../@/components/ui/badge";
import { AttachmentPreview } from './AttachmentPreview';
import { TagInputPopover } from './ui/TagInputPopover';
import { CommentInputPopover } from './ui/CommentInputPopover';

import { OpenNodeButton } from './OpenNodeButton';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useBranches } from '../hooks/useBranches';
import { GitNodeMeta } from './GitNodeMeta';
import { ParentRefMoveAction } from './ParentRefMoveAction';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../@/components/ui/accordion";
import { Popover, PopoverContent, PopoverTrigger } from "../../@/components/ui/popover";
import { ScrollArea } from "../../@/components/ui/scroll-area";
import { ExecutionTimeline, TimelineEvent, buildTimelineRows, type TimelineRow, formatToolPayload, getToolSummary } from './ExecutionTimeline';
import { useNodeEvents } from '../hooks/useNodeEvents';
import { FileChangePreview } from './FileChangePreview';

// --- Constants ---
const CHAR_THRESHOLD = 750;
const COLLAPSED_MAX_HEIGHT_REM = 16;
const LazyMermaidDiagram = lazy(() => import('./MermaidDiagram'));
const LazySyntaxHighlighter = lazy(() => import('./LazySyntaxHighlighter'));

const applyNodeLinksToContent = (input: string, nodeMapping: Record<string, string>) => {
  if (!input || Object.keys(nodeMapping).length === 0) return input;
  return input.replace(/\b(n\d+)\b/g, (match, shortId) => {
    const uuid = nodeMapping[shortId];
    if (!uuid) return match;
    return `[${shortId}](#nodelink/${shortId}/${uuid})`;
  });
};

type LatencyTraceMark = {
  ts?: number;
  source?: string;
  detail?: Record<string, unknown>;
};

type LatencyTraceData = {
  trace_id?: string | null;
  marks?: Record<string, LatencyTraceMark>;
  summary_ms?: Record<string, number>;
  updated_at_ts?: number;
};

// --- Component Interfaces ---
interface MessageCardProps {
  message: Message;
  className?: string;
  showTags?: boolean;
  bulkToggleTrigger?: 'expand' | 'collapse' | null;
  onLocalToggle?: () => void;
  forceExpand?: boolean; // New prop
  agentType?: string | null;
  workspaceId: string;
  layout?: 'default' | 'compact';
  showMetaHeader?: boolean;
  compactFileChanges?: boolean;
}

// --- Internal Component for Code Blocks ---
interface CodeBlockWrapperProps {
  language: string | undefined;
  code: string;
}
const CodeBlockWrapper: React.FC<CodeBlockWrapperProps> = ({ language, code }) => {
  const [isCopied, setIsCopied] = useState(false);
  const handleCopy = async () => { try { await navigator.clipboard.writeText(code); setIsCopied(true); setTimeout(() => setIsCopied(false), 2000); } catch (err) { console.error('Failed to copy code:', err); } };
  const codeBlockBg = 'bg-gray-800 dark:bg-gray-950';
  const headerBg = 'bg-gray-700/80 dark:bg-gray-800/50 backdrop-blur-sm';

  return (
    <div className={cn("code-block-wrapper relative group my-1.5 rounded-md overflow-hidden border border-border/20", codeBlockBg)}>
      <div className={cn("flex justify-between items-center px-3 py-1 text-xs text-gray-400", headerBg)}>
        <span>{language || 'code'}</span>
        <Button variant="ghost" size="icon" className={cn("h-6 w-6 text-gray-400 hover:text-gray-100 hover:bg-gray-600/50 rounded-sm", isCopied ? "text-green-400" : "")} onClick={handleCopy} aria-label="Copy code">
          {isCopied ? <Check size={14} /> : <Clipboard size={14} />}
        </Button>
      </div>
      <Suspense
        fallback={
          <pre className="code-block !m-0 overflow-x-auto whitespace-pre-wrap break-words bg-transparent p-3 text-sm text-gray-100">
            <code>{code}</code>
          </pre>
        }
      >
        <LazySyntaxHighlighter language={language} code={code} />
      </Suspense>
    </div>
  );
};

function InterleavedToolCard({ row }: { row: Extract<TimelineRow, { kind: 'tool' }> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = getToolSummary(row.toolName, row.toolInput) || row.toolName;
  const duration = row.durationMs ? (row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`) : null;
  const stopCardFocus = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div className="py-0.5" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        }}
        className="flex w-full items-center gap-2 px-0 py-0.5 text-left transition-colors hover:text-foreground/90"
        aria-expanded={isExpanded}
      >
        <div className="flex h-4 w-4 shrink-0 items-center justify-center">
          {row.isError ? <AlertTriangle size={11} className="text-red-500/80" /> : row.toolOutput !== undefined ? <CheckCircle2 size={11} className="text-emerald-600/80 dark:text-emerald-400/80" /> : <Terminal size={11} className="text-muted-foreground/55" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-muted-foreground/55" title={summary}>
            {summary}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {duration ? <span className="text-[10px] font-mono text-muted-foreground/45">{duration}</span> : null}
          <ChevronDown size={11} className={cn("text-muted-foreground/45 transition-transform", isExpanded && "rotate-180")} />
        </div>
      </button>

      {isExpanded ? (
        <div className="mt-1 ml-6 space-y-2">
          {row.toolInput !== undefined ? (
            <pre className="max-h-40 overflow-x-auto rounded-md bg-muted/25 p-2 text-[10px] text-muted-foreground">{formatToolPayload(row.toolInput)}</pre>
          ) : null}
          {row.toolOutput !== undefined ? (
            <div>
              <pre className="max-h-40 overflow-x-auto rounded-md bg-muted/25 p-2 text-[10px] text-muted-foreground">{formatToolPayload(row.toolOutput)}</pre>
            </div>
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
    <div className="py-0.5" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsExpanded((value) => !value);
        }}
        className="flex w-full items-start gap-2 px-0 py-0.5 text-left transition-colors hover:text-foreground/90"
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
        <div className="mt-1 ml-6 space-y-2">
          {row.toolCalls.map((call, index) => (
            <pre key={call.key || index} className="max-h-40 overflow-x-auto rounded-md bg-muted/25 p-2 text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
              {formatToolPayload(call.toolInput)}
            </pre>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Internal Meta Header Component ---
function MessageMetaHeader({ message, cachedInputTokens }: { message: Message, cachedInputTokens: number | null }) {
  const disabledSummaryIds = useWorkspaceStore(state => state.disabledSummaryIds);
  const { data: allMessages } = useMessages(message.workspaceId);
  const { data: summaries } = useSummaries(message.workspaceId);

  const messages = useMemo(() => (allMessages as unknown as Message[]) ?? [], [allMessages]);
  const summaryList = useMemo(() => (summaries as unknown as Summary[]) ?? [], [summaries]);
  const disabledSummaryIdsSet = useMemo(() => new Set(disabledSummaryIds), [disabledSummaryIds]);

  const cumulativeTokens = useMemo(() => {
    return calculateCumulativeTokens(messages, message.id, summaryList, disabledSummaryIdsSet);
  }, [messages, message.id, summaryList, disabledSummaryIdsSet]);

  const contentLength = message?.content?.length ?? 0;

  return (
    <div className="px-2 py-1.5 w-full rounded-t-lg -mt-1 mb-2 flex items-center justify-between group/meta">

      {/* Left Metrics - Designer Segmented Pill */}
      <div className="flex items-stretch overflow-hidden rounded-full border border-border/40 shadow-[0_1px_3px_rgba(0,0,0,0.04)] bg-background/80 backdrop-blur-xl text-[10px] text-muted-foreground transition-[background-color,box-shadow] hover:shadow-md hover:bg-background/90 ring-1 ring-white/10 dark:ring-white/5">

        {/* Turn Tokens */}
        <div className="px-2.5 py-1 flex items-center gap-1.5 border-r border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors" title="Turn Tokens (Prompt/Completion)">
          <Hash size={11} className="opacity-80 text-blue-500" />
          <div className="flex items-baseline gap-1">
            <span className="font-mono tabular-nums font-semibold text-foreground/90">{message.totalTokens || '-'}</span>
            {(message.totalTokens || 0) > 0 && (
              <span className="text-[8.5px] opacity-70 font-mono tabular-nums tracking-tighter">
                (P:{message.promptTokens || 0} / C:{message.completionTokens || 0})
              </span>
            )}
            {cachedInputTokens && cachedInputTokens > 0 ? (
              <span className="text-[8.5px] text-amber-700 dark:text-amber-400 font-mono tabular-nums font-medium tracking-tighter ml-0.5 bg-amber-500/15 ring-1 ring-amber-500/30 px-1 rounded-[4px]" title="Cached Tokens">
                +{cachedInputTokens}c
              </span>
            ) : null}
          </div>
        </div>

        {/* Total Tokens */}
        <div className="px-2.5 py-1 flex items-center gap-1.5 border-r border-border/40 bg-muted/10 hover:bg-muted/30 transition-colors" title="Cumulative Tokens">
          <Sigma size={11} className="opacity-80 text-purple-500" />
          <span className="font-mono tabular-nums font-semibold text-foreground/90">{cumulativeTokens > 0 ? cumulativeTokens.toLocaleString() : '-'}</span>
        </div>

        {/* Tools or Length */}
        {(() => {
          const timeline = (message.execution_data as any)?.timeline;
          const toolCalls = timeline?.filter((e: any) => e.type === 'tool_use') || [];
          const toolCount = toolCalls.length;

          if (toolCount > 0) {
            return (
              <div className="px-3 py-1 flex items-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 transition-colors" title={`Tools Used: ${toolCalls[0]?.tool_name || 'various'}`}>
                <Settings2 size={11} className="opacity-90" />
                <span className="font-medium font-mono flex items-center"><span className="font-bold mr-1">{toolCount}</span> call{toolCount !== 1 && 's'}</span>
              </div>
            );
          } else {
            return (
              <div className="px-2.5 py-1 flex items-center gap-1.5 bg-background/40 hover:bg-background/80 transition-colors" title="Message Length">
                <Pilcrow size={11} className="opacity-80 text-emerald-500" />
                <div className="flex items-baseline gap-0.5">
                  <span className="font-mono tabular-nums font-semibold text-foreground/90">{contentLength.toLocaleString()}</span>
                  <span className="text-[8.5px] opacity-70 font-medium">ch</span>
                </div>
              </div>
            );
          }
        })()}
      </div>

      {/* Right Actions & Time */}
      <div className="flex items-center gap-3 pl-2 shrink-0">

        {/* Timestamp */}
        <div className="flex items-center gap-1.5 text-muted-foreground/60 transition-opacity" title="Time">
          <Clock size={10} className="opacity-50" />
          <span className="font-medium tabular-nums tracking-tight text-[9px]">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function safeDelta(start?: number | null, end?: number | null) {
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (end < start) return null;
  return end - start;
}

function LatencyTracePanel({ trace }: { trace: LatencyTraceData }) {
  const marks = trace.marks || {};
  const summary = trace.summary_ms || {};
  const getMarkTs = (name: string) => marks[name]?.ts;

  const totalToVisible = typeof summary.first_visible_text_rendered === 'number'
    ? summary.first_visible_text_rendered
    : null;
  const worktreeMs = safeDelta(getMarkTs('worktree_create_started'), getMarkTs('worktree_create_finished'));
  const spawnMs = safeDelta(getMarkTs('spawn_requested'), getMarkTs('spawn_returned'));
  const adapterBootMs = safeDelta(getMarkTs('sdk_adapter_started'), getMarkTs('thread_ready'));
  const modelFirstMessageMs = safeDelta(getMarkTs('thread_ready'), getMarkTs('first_assistant_message_emitted'));
  const transportMs = safeDelta(getMarkTs('first_assistant_message_emitted'), getMarkTs('first_visible_text_rendered'));

  const primaryRows = [
    { label: 'Total to first text', value: totalToVisible, tone: 'text-foreground' },
    { label: 'Worktree', value: worktreeMs, tone: 'text-amber-700 dark:text-amber-300' },
    { label: 'Spawn', value: spawnMs, tone: 'text-sky-700 dark:text-sky-300' },
    { label: 'SDK boot', value: adapterBootMs, tone: 'text-violet-700 dark:text-violet-300' },
    { label: 'Model wait', value: modelFirstMessageMs, tone: 'text-emerald-700 dark:text-emerald-300' },
    { label: 'Transport/UI', value: transportMs, tone: 'text-rose-700 dark:text-rose-300' },
  ].filter((row) => typeof row.value === 'number');

  const rawMarks = Object.entries(marks)
    .filter(([, mark]) => typeof mark?.ts === 'number')
    .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));

  if (primaryRows.length === 0 && rawMarks.length === 0) return null;

  return (
    <Accordion type="single" collapsible className="mb-2 w-full border-b border-border/30">
      <AccordionItem value="latency-trace" className="border-b-0">
        <AccordionTrigger className="py-1 text-xs font-normal justify-start gap-1 hover:no-underline text-muted-foreground hover:text-foreground">
          <Clock size={14} className="flex-shrink-0 transition-colors" />
          <span>Startup Latency</span>
          {formatDuration(totalToVisible) ? (
            <Badge variant="outline" className="ml-2 h-4 rounded-full px-1.5 font-mono text-[10px]">
              {formatDuration(totalToVisible)}
            </Badge>
          ) : null}
        </AccordionTrigger>
        <AccordionContent className="pt-1 pb-2">
          {primaryRows.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {primaryRows.map((row) => (
                <div key={row.label} className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{row.label}</div>
                  <div className={cn("mt-1 font-mono text-sm font-semibold tabular-nums", row.tone)}>
                    {formatDuration(row.value) || '-'}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {rawMarks.length > 0 ? (
            <div className="mt-2 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Raw Marks</div>
              <div className="space-y-1">
                {rawMarks.map(([name, mark]) => (
                  <div key={name} className="flex items-center justify-between gap-3 text-[11px]">
                    <div className="min-w-0">
                      <span className="font-mono text-foreground/90">{name}</span>
                      {mark.source ? <span className="ml-1 text-muted-foreground">({mark.source})</span> : null}
                    </div>
                    <div className="shrink-0 font-mono tabular-nums text-muted-foreground">
                      {formatDuration(summary[name]) || '-'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

// --- Main MessageCard Component ---
export function MessageCard({
  message,
  className,
  showTags = true,
  bulkToggleTrigger = null,
  onLocalToggle = () => { },
  forceExpand = false, // Destructure new prop with default
  agentType = null,
  workspaceId,
  layout = 'default',
  showMetaHeader = false,
  compactFileChanges = false
}: MessageCardProps) {
  const focusedMessageId = useWorkspaceStore((state) => state.focusedMessageId);
  const { content = "", attachments, annotations, tags, id: messageId, reasoning, role } = message;
  const isOptimistic = isOptimisticMessage(message);
  const changedFiles: string[] = (message.execution_data as any)?.files_changed || [];
  const { data: branchPointersData } = useBranches(workspaceId);
  const outputCommitSha = getMessageOutputCommitSha(message);
  const branchPointers = useMemo(
    () => (branchPointersData ?? []).filter((pointer) => {
      if (!outputCommitSha) return false;
      return getBranchPointerCommitSha(pointer) === outputCommitSha;
    }),
    [branchPointersData, outputCommitSha]
  );
  // Don't load events for optimistic messages (they don't exist on server yet)
  const shouldLoadEvents = role === 'assistant' && !isOptimistic && (message.agent_id || message.status);
  const { data: nodeEventsData } = useNodeEvents(messageId, { enabled: Boolean(shouldLoadEvents) });
  const nodeEvents = (nodeEventsData?.events || []) as TimelineEvent[];
  const persistedTimeline = (((message.execution_data as any)?.timeline || []) as TimelineEvent[]);
  const timelineEvents = persistedTimeline.length > 0 ? persistedTimeline : nodeEvents;
  const isNodeActive = message.status === 'running' || message.status === 'streaming';
  const [isExpandedLocally, setIsExpandedLocally] = useState(false);

  const cachedInputTokens = useMemo(() => {
    const cacheUsage = (message.execution_data as any)?.cache_usage;
    if (!cacheUsage) return null;
    let total = 0;
    let hasValue = false;
    const add = (value: unknown) => {
      if (typeof value === 'number' && !Number.isNaN(value)) { total += value; hasValue = true; }
    };
    add(cacheUsage.cache_read_input_tokens);
    add(cacheUsage.cache_creation_input_tokens);
    add(cacheUsage.cached_input_tokens);
    if (!hasValue) {
      for (const [key, value] of Object.entries(cacheUsage)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey.includes('cache') && normalizedKey.includes('input')) add(value);
      }
    }
    return hasValue ? total : null;
  }, [message.execution_data]);

  const latencyTrace = useMemo(() => {
    const trace = (message.execution_data as any)?.latency_trace;
    if (!trace || typeof trace !== 'object') return null;
    return trace as LatencyTraceData;
  }, [message.execution_data]);

  const extractedFileChanges = useMemo(() => {
    if (!compactFileChanges) return [];
    const changes: { path: string; tool: string }[] = [];
    const seenPaths = new Set<string>();
    for (const entry of timelineEvents) {
      if (entry.type !== 'tool_use') continue;
      const rawEntry = entry as any;
      const toolName = entry.toolName?.toLowerCase() || rawEntry.tool_name?.toLowerCase();
      const input = entry.toolInput || rawEntry.tool_input || {};
      if (['write', 'edit', 'apply_diff', 'create_file'].includes(toolName)) {
        const filePath = input.file_path || input.path || input.filePath;
        if (filePath && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          changes.push({ path: filePath, tool: ['write', 'create_file'].includes(toolName) ? 'created' : 'edited' });
        }
      }
    }
    return changes;
  }, [timelineEvents, compactFileChanges]);

  // Debug log removed - too noisy, enable locally if needed

  const updateTagsMutation = useUpdateTags();
  const addCommentMutation = useAddComment();
  const deleteCommentMutation = useDeleteComment();
  const handleRemoveTag = (tagToRemove: string) => {
    updateTagsMutation.mutate({
      workspaceId,
      messageId,
      tags: [tagToRemove],
      action: 'remove'
    });
  };

  const handleAddTags = async (_msgId: string, newTags: string[]) => {
    await updateTagsMutation.mutateAsync({
      workspaceId,
      messageId,
      tags: newTags,
      action: 'add'
    });
  };

  const isLong = content.length > CHAR_THRESHOLD;
  const collapsedHeightStyle = `${COLLAPSED_MAX_HEIGHT_REM}rem`;

  // Determine final expanded state
  const isEffectivelyExpanded = useMemo(() => {
    if (forceExpand) return true;
    if (bulkToggleTrigger === 'expand') return true;
    if (bulkToggleTrigger === 'collapse') return false;
    return isExpandedLocally; // Fallback to local state if no trigger or forceExpand
  }, [forceExpand, bulkToggleTrigger, isExpandedLocally]);

  // Effect to sync local state if needed (e.g., after a bulk toggle)
  useEffect(() => {
    if (!isLong || forceExpand) return; // Only apply to long, non-forced messages
    if (bulkToggleTrigger === 'expand' && !isExpandedLocally) {
      setIsExpandedLocally(true);
    } else if (bulkToggleTrigger === 'collapse' && isExpandedLocally) {
      setIsExpandedLocally(false);
    }
  }, [bulkToggleTrigger, isLong, forceExpand, isExpandedLocally]);

  // Handler for the local "Show More/Less" button
  const handleToggleClick = () => {
    setIsExpandedLocally(prev => !prev);
    onLocalToggle(); // Notify parent that a local action occurred
  };

  // Determine if collapsing should actually happen
  const shouldCollapse = isLong && !isEffectivelyExpanded && !forceExpand;
  // Determine if the toggle button should be shown
  const showToggleButton = isLong && !forceExpand;
  const shouldRenderPlainText = agentType === 'bash';

  // Extract node mappings from annotations for deep linking
  const nodeMapping = useMemo(() => {
    const mapping = extractNodeMappings(annotations);
    // Node mapping extracted - debug log removed (too noisy)
    return mapping;
  }, [annotations]);

  // Pre-process content to convert node references to markdown links
  const processedContent = useMemo(() => applyNodeLinksToContent(content, nodeMapping), [content, nodeMapping]);

  const transcriptRows = useMemo(() => {
    if (role !== 'assistant') return [] as TimelineRow[];
    return buildTimelineRows(timelineEvents);
  }, [role, timelineEvents]);

  const hasInterleavedTranscript = useMemo(
    () => transcriptRows.some((row) => row.kind === 'message'),
    [transcriptRows]
  );

  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
  const markdownComponents = useMemo(() => ({
    code: (props: any) => { const { node, inline, className: codeClassName, children, ...rest } = props; const match = /language-(\w+)/.exec(codeClassName || ''); const language = match?.[1]; const codeContent = String(children).replace(/\n$/, ''); if (language === 'mermaid' && !inline) return <div className="my-2 flex justify-center"><Suspense fallback={<pre className="text-xs text-muted-foreground">Rendering diagram...</pre>}><LazyMermaidDiagram chart={codeContent} /></Suspense></div>; if (!inline && match) return <CodeBlockWrapper language={language} code={codeContent} />; return <code className={cn("bg-muted/50 dark:bg-muted/30 px-1 py-0.5 rounded-sm text-[0.9em] font-mono break-words", codeClassName)} {...rest}>{children}</code>; },
    pre: (props: any) => <pre className="my-1.5 bg-transparent" {...props} />,
    p: (props: any) => <p className="mb-1 last:mb-0 break-words" {...props} />,
    a: (props: any) => {
      const { href, children, ...rest } = props;
      // Check if this is a node link (hash format: #nodelink/shortId/uuid)
      if (href?.startsWith('#nodelink/')) {
        const parts = href.replace('#nodelink/', '').split('/');
        const shortId = parts[0];
        const uuid = parts[1];
        // Node link detected - debug log removed (too noisy)
        return <NodeLink shortId={shortId} workspaceId={workspaceId} nodeMapping={{ [shortId]: uuid }} />;
      }
      return <a target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all" href={href} {...rest}>{children}</a>;
    },
    blockquote: (props: any) => <blockquote className="pl-3 italic border-l-2 border-border my-1.5 break-words" {...props} />,
    ul: (props: any) => <ul className="list-disc list-inside my-1.5 space-y-1 pl-2" {...props} />,
    ol: (props: any) => <ol className="list-decimal list-inside my-1.5 space-y-1 pl-2" {...props} />,
    li: (props: any) => <li className="pl-1 break-words" {...props} />,
    table: (props: any) => <div className="overflow-x-auto my-1.5"><table className="table-auto w-full border-collapse border border-border" {...props} /></div>,
    th: (props: any) => <th className="border border-border px-2 py-1 text-left font-semibold bg-muted/50" {...props} />,
    td: (props: any) => <td className="border border-border px-2 py-1" {...props} />,
  }), [workspaceId]);
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

  const currentTags = useMemo(() => tags || [], [tags]);

  const { data: workspaces } = useWorkspaces();
  const repoPath = useMemo(() => {
    const workspace = workspaces?.find(c => c.id === workspaceId) ?? null;
    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  }, [workspaces, workspaceId]);
  const showParentRefMoveAction = role === 'assistant' && !isOptimistic && focusedMessageId === messageId;

  return (
    <div className={cn(
      "w-full leading-relaxed group/message relative", 
      layout === 'compact' ? 'pt-0 text-xs' : 'pt-1 text-sm', 
      className,
      isOptimistic && "opacity-90"
    )}>
      {/* Optimistic State Indicator */}
      {isOptimistic && (
        <div className="mb-2">
          <OptimisticMessageIndicator message={message as AgentRunProjectedMessage} />
        </div>
      )}

      {showMetaHeader && role === 'assistant' && !isOptimistic && <MessageMetaHeader message={message} cachedInputTokens={cachedInputTokens} />}
      {showMetaHeader && role === 'assistant' && !isOptimistic && latencyTrace && <LatencyTracePanel trace={latencyTrace} />}

      {/* Tags & Add Tag Button Area - ONLY FOR ASSISTANT MESSAGES */}
      {(showTags ?? true) && role === 'assistant' && (
        <div className="mb-1.5 flex flex-wrap gap-1.5 items-center">
          {currentTags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary" // Use secondary for themed background
              className="text-[11px] font-medium px-1.5 py-0 h-5 group/tag relative pr-5 shadow-xs cursor-default" // Adjusted variant and removed border
            >
              <span className="opacity-90">{tag}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleRemoveTag(tag); }}
                className={cn(
                  "absolute top-[1px] bottom-[1px] right-[1px] ml-1 rounded-sm p-0 w-4 h-[calc(100%-2px)]",
                  "flex items-center justify-center text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10", // Adjusted hover text color
                  "opacity-0 group-hover/tag:opacity-100 focus-visible:opacity-100 transition-opacity"
                )}
                aria-label={`Remove tag: ${tag}`}
                title={`Remove tag: ${tag}`}
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </Badge>
          ))}
          {/* Add Tag Button using Popover */}
          <TagInputPopover
            messageId={messageId}
            existingTags={currentTags}
            onAddTags={handleAddTags}
            // Styling the trigger button
            triggerClassName={cn(
              "h-5 w-5 p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-accent/50",
              "border border-dashed border-border/60 rounded-full transition-colors"
            )}
          >
            {/* Use Tag icon for the trigger */}
            <Tag size={12} strokeWidth={2} />
          </TagInputPopover>
          {/* Add Comment Button */}
          <CommentInputPopover
            messageId={messageId}
            workspaceId={workspaceId}
            onAddComment={async (params) => {
              await addCommentMutation.mutateAsync(params);
            }}
            triggerClassName={cn(
              "h-5 w-5 p-0.5 text-blue-500/70 hover:text-blue-600 hover:bg-blue-500/10",
              "border border-dashed border-blue-400/60 rounded-full transition-colors"
            )}
          >
            <MessageSquarePlus size={12} strokeWidth={2} />
          </CommentInputPopover>
          <GitNodeMeta
            commitSha={getMessageOutputCommitSha(message)}
            branchPointers={branchPointers}
          />
          {showParentRefMoveAction ? (
            <ParentRefMoveAction
              message={message}
              workspaceId={workspaceId}
              repoPath={repoPath}
              visible={showParentRefMoveAction}
            />
          ) : null}
          {/* Open in Editor/Terminal - pushed to right */}
          <div className="ml-auto">
            <OpenNodeButton
              nodeId={messageId}
              workspaceId={workspaceId}
              repoPath={repoPath}
              nodeStatus={message.status}
              message={message}
              compact
            />
          </div>
        </div>
      )}



      {/* Execution Timeline - legacy fallback when no interleaved transcript exists */}
      {!hasInterleavedTranscript && timelineEvents.length > 0 && (
        <ExecutionTimeline
          events={timelineEvents as TimelineEvent[]}
          isNodeActive={isNodeActive}
          className="mb-2"
        />
      )}

      {/* Changed Files */}
      {compactFileChanges ? (
        extractedFileChanges.length > 0 && (
          <div className="mt-2.5 pt-2 border-t border-border/30 mb-2 px-2">
            <div className="flex items-center gap-1.5 text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">
              <FileCode2 size={9} />
              <span>File Changes</span>
              <span className="text-[8px] font-normal">({extractedFileChanges.length})</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {extractedFileChanges.slice(0, 5).map((change, idx) => {
                const fileName = change.path.split('/').pop() || change.path;
                return (
                  <Badge key={idx} variant="outline" className={`text-[9px] px-1.5 py-0 h-4 font-mono ${change.tool === 'created' ? 'bg-green-50 dark:bg-green-900/20 border-green-200/50 dark:border-green-800/50 text-green-700 dark:text-green-300' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200/50 dark:border-amber-800/50 text-amber-700 dark:text-amber-300'}`} title={change.path}>
                    {change.tool === 'created' ? <FilePlus size={8} className="mr-1" /> : <FilePen size={8} className="mr-1" />}
                    {fileName}
                  </Badge>
                );
              })}
              {extractedFileChanges.length > 5 && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 text-muted-foreground">
                  +{extractedFileChanges.length - 5} more
                </Badge>
              )}
            </div>
          </div>
        )
      ) : (
        changedFiles.length > 0 && (
          <FileChangePreview
            messageId={messageId}
            workspaceId={workspaceId}
            initialFiles={changedFiles}
            className="mb-2"
          />
        )
      )}

      {/* Agent Tool Panel - Show tool calls ONLY (reasoning is shown separately below) */}
      {role === 'assistant' && !hasInterleavedTranscript && annotations && annotations.some(a => a?.type === 'tool_call') && (
        <AgentToolPanel
          annotations={annotations}
          reasoning={null}
          className="mb-2"
        />
      )}

      {/* Reasoning Section - Always show if reasoning exists */}
      {reasoning && reasoning.trim() !== '' && (
        <Accordion type="single" collapsible className="mb-2 w-full border-b border-border/30">
          <AccordionItem value="reasoning" className="border-b-0">
            <AccordionTrigger className="text-xs text-muted-foreground hover:no-underline py-1 font-normal justify-start gap-1 [&[data-state=open]>svg]:text-primary hover:text-foreground">
              <BrainCircuit size={14} className="flex-shrink-0 transition-colors" />
              <span>Show Reasoning Process</span>
            </AccordionTrigger>
            <AccordionContent className="pt-1 pb-2">
              <div className="prose prose-sm dark:prose-invert max-w-none p-2 rounded bg-muted/40 dark:bg-muted/20 border border-border/50 text-foreground/80 dark:text-foreground/70">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                  {reasoning}
                </ReactMarkdown>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      {/* Collapsible Content Area */}
      <div className="relative">
        <div
          className={cn(
            "content-wrapper overflow-hidden",
            "transition-all duration-500 ease-out", // Enhanced transition
            shouldCollapse && "cursor-pointer group/expand", // Make clickable when collapsed
          )}
          // Apply max-height only if collapsing should happen
          style={{ maxHeight: shouldCollapse ? collapsedHeightStyle : 'none' }}
          onClick={shouldCollapse ? handleToggleClick : undefined}
          role={shouldCollapse ? "button" : undefined}
          aria-expanded={shouldCollapse ? false : undefined}
          aria-label={shouldCollapse ? "Click to expand message" : undefined}
          tabIndex={shouldCollapse ? 0 : undefined}
        >
          {hasInterleavedTranscript ? (
            <div className="space-y-3">
              {transcriptRows.map((row, index) => {
                if (row.kind === 'message') {
                  const blockContent = applyNodeLinksToContent(row.content || '', nodeMapping);
                  if (!blockContent) return null;
                  return (
                    <div
                      key={row.key ?? `message-${index}`}
                      className="rounded-xl border border-border/40 bg-background/80 px-3 py-2.5 shadow-sm"
                    >
                      {shouldRenderPlainText ? (
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                          {row.content || ''}
                        </pre>
                      ) : (
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-0 prose-blockquote:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-table:my-1.5 prose-th:py-1 prose-td:py-1 break-words">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                            {blockContent}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  );
                }

                if (row.kind === 'tool') {
                  return (
                    <InterleavedToolCard
                      key={row.key ?? `tool-${index}`}
                      row={row}
                    />
                  );
                }

                if (row.kind === 'exploration') {
                  return (
                    <InterleavedExplorationCard
                      key={row.key ?? `exploration-${index}`}
                      row={row}
                    />
                  );
                }

                if (row.kind === 'thinking') {
                  if (!row.content) return null;
                  return (
                    <div
                      key={row.key ?? `thinking-${index}`}
                      className="rounded-xl border border-blue-200/70 bg-blue-50/50 px-3 py-2 text-[11px] text-blue-900/80 dark:border-blue-900/70 dark:bg-blue-950/20 dark:text-blue-200/80"
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
                      className="rounded-xl border border-red-200/70 bg-red-50/60 px-3 py-2 text-[11px] text-red-900/90 dark:border-red-900/70 dark:bg-red-950/20 dark:text-red-200/90"
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
          ) : content && (
            <div className={cn(
              "prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-0 prose-blockquote:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-table:my-1.5 prose-th:py-1 prose-td:py-1 break-words",
              shouldCollapse && "group-hover/expand:bg-accent/5 transition-colors duration-200 rounded-md p-2 -m-2"
            )}>
              {shouldRenderPlainText ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {content}
                </pre>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                  {processedContent || ''}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>

        {/* Enhanced Fade Overlay - Only show if collapsing */}
        {shouldCollapse && (
          <div className="absolute bottom-0 left-0 right-0 pointer-events-none z-10">
            {/* Multi-layer gradient for better visual effect */}
            <div className="h-20 bg-gradient-to-t from-card via-card/95 via-card/80 to-transparent dark:from-background dark:via-background/95 dark:via-background/80" />

            {/* Expand indicator */}
            <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex items-center gap-1 text-xs text-muted-foreground/70 group-hover/expand:text-muted-foreground transition-colors duration-200">
              <ChevronDown size={12} className="animate-pulse" />
              <span className="font-medium">Click to expand</span>
              <ChevronDown size={12} className="animate-pulse" />
            </div>
          </div>
        )}
      </div>

      {/* Attachments & Citations */}
      {attachments && attachments.length > 0 && (
        <div className="mt-2 pt-1.5 border-t border-border/30 flex flex-wrap gap-2">
          {attachments.map((att, index) => (<AttachmentPreview key={att.path || index} attachment={att} size="small" className="flex-shrink-0" />))}
        </div>
      )}

      {useMemo(() => {
        const safeAnnotations = Array.isArray(annotations) ? annotations : [];
        type UrlCitationAnnotation = { type: 'url_citation'; url_citation: { url: string; title?: string } };
        const urlCitations = safeAnnotations.filter(
          (ann): ann is UrlCitationAnnotation =>
            ann?.type === 'url_citation' && typeof (ann as UrlCitationAnnotation).url_citation?.url === 'string'
        );
        if (!urlCitations || urlCitations.length === 0) return null;
        return (
          <div className="mt-2 pt-1.5 border-t border-border/30">
            <p className="text-xs font-medium text-muted-foreground mb-1">Sources:</p>
            <div className="flex flex-wrap gap-1.5">
              {urlCitations.map((ann, index) => {
                const { url, title } = ann.url_citation;
                let hostname = 'Source';
                try {
                  hostname = new URL(url).hostname.replace(/^www\./, '');
                } catch {
                  /* ignore */
                }
                const displayTitle = title || hostname;
                const tooltip = title ? `${title} (${hostname})` : url;
                return (
                  <a key={`cite-${index}-${url}`} href={url} target="_blank" rel="noopener noreferrer" className="no-underline" title={tooltip}>
                    <Badge variant="outline" className="flex items-center gap-1 px-1.5 py-0.5 hover:border-primary/80 hover:bg-primary/5 transition-colors cursor-pointer border-primary/50 text-primary dark:text-primary dark:border-primary/70 text-xs h-auto shadow-xs">
                      <Globe size={12} className="flex-shrink-0 mr-0.5" /> <span className="font-normal truncate max-w-[160px]">{displayTitle}</span>
                    </Badge>
                  </a>
                );
              })}
            </div>
          </div>
        );
      }, [annotations])}

      {/* Citations from Knowledge Base */}
      {message.citations && message.citations.length > 0 && (
        <div className="mt-2 pt-1.5 border-t border-border/30">
          <p className={cn(
            "text-xs font-medium mb-1",
            role === 'user' ? "text-primary-foreground/80" : "text-muted-foreground"
          )}>Used Knowledge:</p>
          <div className="flex flex-wrap gap-1.5">
            {message.citations.map((cite, index) => (
              <Popover key={`kb-cite-${index}`}>
                <PopoverTrigger asChild>
                  <Badge
                    variant="outline"
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 text-xs h-auto shadow-xs cursor-pointer transition-colors",
                      role === 'user'
                        ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20"
                        : "border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
                    )}
                    title={`Similarity: ${(cite.similarity * 100).toFixed(1)}%`}
                  >
                    <FileText size={12} className="flex-shrink-0 mr-0.5" />
                    <span className="font-normal truncate max-w-[160px]">{cite.fileName}</span>
                  </Badge>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-3" align="start">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b pb-1">
                      <h4 className="font-medium text-sm truncate" title={cite.fileName}>{cite.fileName}</h4>
                      {/* Removed % Match as per user request for explicit selection */}
                    </div>
                    <ScrollArea className="h-48 w-full rounded-md border bg-muted/50 p-2">
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                        {cite.content || "No preview content available."}
                      </p>
                    </ScrollArea>
                  </div>
                </PopoverContent>
              </Popover>
            ))}
          </div>
        </div>
      )}

      {/* Structured Comments / Context Notes */}
      {message.comments && message.comments.length > 0 && (
        <div className="mt-2 pt-1.5 border-t border-border/30">
          <p className="text-xs font-medium text-muted-foreground mb-1">Context Notes:</p>
          <div className="space-y-1.5">
            {message.comments.map((comment, idx) => (
              <div key={idx} className="text-xs bg-muted/30 p-1.5 rounded border border-border/40 flex gap-2 items-start group/comment">
                <MessageSquare size={12} className="mt-0.5 text-blue-500 shrink-0 opacity-70" />
                <div className="flex-1 min-w-0">
                  <span className="font-semibold opacity-80 mr-1 capitalize text-foreground/90">{comment.type.replace(/_/g, ' ')}:</span>
                  <span className="opacity-90 text-muted-foreground">{comment.content}</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteCommentMutation.mutate({
                      workspaceId,
                      messageId,
                      commentIndex: idx,
                    });
                  }}
                  className="shrink-0 opacity-0 group-hover/comment:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-0.5 rounded hover:bg-destructive/10"
                  title="Delete comment"
                  disabled={deleteCommentMutation.isPending}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* "Show Less" Button - Only show when expanded */}
      {showToggleButton && isEffectivelyExpanded && (
        <div className="flex justify-center mt-3 relative z-20">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleClick}
            className={cn(
              "h-8 text-xs px-4 font-medium transition-all duration-300 ease-out",
              "border border-border/40 hover:border-border/80",
              "bg-background/50 hover:bg-accent/80 backdrop-blur-sm",
              "text-muted-foreground hover:text-foreground",
              "shadow-sm hover:shadow-md",
              "group/button"
            )}
            aria-expanded={true}
          >
            <ChevronUp
              size={14}
              className="mr-1.5 transition-transform duration-300 group-hover/button:scale-110"
            />
            <span>Show Less</span>
          </Button>
        </div>
      )}

    </div>
  );
}
