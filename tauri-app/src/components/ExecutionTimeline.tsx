import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { 
  ChevronDown, 
  ChevronRight, 
  Terminal, 
  CheckCircle2, 
  XCircle,
  Sparkles,
  AlertTriangle,
  Activity,
  Clock,
  MessageSquarePlus
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ToolFileChangesDiff } from './diff/ToolFileChangesDiff';
import { TimelineErrorNotice } from './TimelineErrorNotice';

const MAX_TIMELINE_TEXT_CONTENT_CHARS = 6000;
const TIMELINE_TEXT_TRUNCATION_NOTICE = '\n\n... [truncated for display]';
const MAX_TOOL_PAYLOAD_CONTENT_CHARS = 12000;
const MAX_TOOL_SUMMARY_CHARS = 180;
const TOOL_PAYLOAD_TRUNCATION_NOTICE = '\n\n... [truncated for display]';

export interface TimelineEvent {
    type: 'thinking' | 'tool_use' | 'tool_result' | 'message' | 'error' | 'user_steer_requested';
    timestamp: number;
    content?: string; // For thinking or message
    toolName?: string;
    toolInput?: any;
    toolOutput?: any;
    isError?: boolean;
    durationMs?: number;
    toolUseId?: string;
    tool_use_id?: string;
    id?: string;
    // Legacy/local timeline shape
    tool?: string;
    input?: any;
    output?: any;
    error?: string | null;
    duration_ms?: number;
    commandActions?: CommandAction[];
    providerItem?: any;
    provider_item?: any;
    provider_item_id?: string;
}

export type CommandAction =
    | {
          type: 'read';
          cmd: string;
          name: string;
          path: string;
      }
    | {
          type: 'list_files';
          cmd: string;
          path?: string | null;
      }
    | {
          type: 'search';
          cmd: string;
          query?: string | null;
          path?: string | null;
      }
    | {
          type: 'unknown';
          command?: string;
          cmd?: string;
      };

type CommandSummaryItem = {
    label: 'Read' | 'List' | 'Search' | 'Run';
    text: string;
};

export type FileChangeSummary = {
    path: string;
    kind: string;
    additions: number;
    deletions: number;
};

type FileChangesSummary = {
    files: FileChangeSummary[];
    totalAdditions: number;
    totalDeletions: number;
};

interface ExecutionTimelineProps {
    events: TimelineEvent[];
    className?: string;
    isNodeActive?: boolean;
}

export function ExecutionTimeline({ events, className, isNodeActive = false }: ExecutionTimelineProps) {
    const [isOpen, setIsOpen] = useState(isNodeActive);

    useEffect(() => {
        if (isNodeActive) {
            setIsOpen(true);
        }
    }, [isNodeActive]);

    if (!events || events.length === 0) return null;

    // Filter out pure message events as they are shown in the main message body
    const timelineEvents = events.filter(e => e.type !== 'message');

    const rows = useMemo(() => buildTimelineRows(timelineEvents), [timelineEvents]);

    if (rows.length === 0) return null;

    return (
        <div
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
        >
            <Collapsible
                open={isOpen}
                onOpenChange={setIsOpen}
                className={cn("w-full border rounded-lg bg-muted/20 mb-4 overflow-hidden", className)}
            >
                <CollapsibleTrigger asChild>
                    <button
                        type="button"
                        className={cn(
                            "flex items-center justify-between w-full px-4 py-2.5",
                            "bg-gradient-to-r from-muted/60 to-muted/30",
                            "hover:from-muted/70 hover:to-muted/40",
                            "border-b border-border/50",
                            "transition-[background-color,border-color] duration-normal ease-out-cubic motion-reduce:transition-none"
                        )}
                        aria-label="Toggle execution timeline"
                    >
                        <div className="flex items-center gap-3">
                            <div className={cn(
                                "p-1 rounded-md transition-[background-color,transform] duration-normal ease-out-cubic motion-reduce:transition-none",
                                isOpen ? "bg-primary/10 rotate-0" : "bg-muted -rotate-90"
                            )}>
                                <ChevronDown size={14} className={isOpen ? "text-primary" : "text-muted-foreground"} />
                            </div>
                            <Activity size={14} className="text-muted-foreground/70" />
                            <span className="text-xs font-semibold text-foreground">Execution</span>
                            <Badge 
                                variant="outline" 
                                className="text-[10px] h-5 px-2 bg-background/60 border-border/50 font-medium"
                            >
                                {countTimelineActivities(rows)} steps
                            </Badge>
                        </div>
                    </button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                    <div className="p-4 space-y-3 text-sm bg-gradient-to-b from-background to-muted/10">
                        {rows.map((row, index) => (
                            <TimelineRowItem key={row.key ?? index} row={row} isLast={index === rows.length - 1} />
                        ))}
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </div>
    );
}

export type TimelineToolRow = {
    kind: 'tool';
    key?: string;
    toolName: string;
    toolInput?: any;
    toolOutput?: any;
    isError?: boolean;
    durationMs?: number;
    startedAtMs?: number | null;
    completedAtMs?: number | null;
    commandActions?: CommandAction[];
};

export type TimelineRow =
    | {
          kind: 'message';
          key?: string;
          content?: string;
      }
    | {
          kind: 'thinking';
          key?: string;
          content?: string;
          durationMs?: number;
      }
    | {
          kind: 'user_steer';
          key?: string;
          content?: string;
      }
    | {
          kind: 'error';
          key?: string;
          content?: string;
      }
    | TimelineToolRow
    | {
          kind: 'tool_group';
          key?: string;
          activity: 'command' | 'search';
          status: 'running' | 'completed' | 'error';
          durationMs?: number;
          toolCalls: TimelineToolRow[];
      }
    | {
          kind: 'exploration';
          key?: string;
          status: 'running' | 'completed' | 'error';
          durationMs?: number;
          items: CommandSummaryItem[];
          toolCalls: Array<{
              key: string;
              toolName: string;
              toolInput?: any;
              toolOutput?: any;
              durationMs?: number;
              isError?: boolean;
              commandActions?: CommandAction[];
          }>;
      };

function TimelineRowItem({ row, isLast }: { row: TimelineRow; isLast: boolean }) {
    const [isDetailsOpen, setIsDetailsOpen] = useState(false);
    const stopCardFocus = (event: React.MouseEvent) => {
        event.stopPropagation();
    };

    if (row.kind === 'message') {
        return null;
    }

    if (row.kind === 'thinking') {
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "bg-gradient-to-br from-blue-50 to-indigo-50",
                        "dark:from-blue-900/30 dark:to-indigo-900/20",
                        "border border-blue-200 dark:border-white/10 dark:bg-white/[0.04]",
                        "shadow-sm"
                    )}>
                        <Sparkles size={12} className="text-blue-600 dark:text-zinc-300" />
                    </div>
                    {!isLast && (
                        <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                    )}
                </div>
                <div className="pb-2 flex-1 min-w-0 pt-0.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-[11px] font-semibold text-foreground/80 flex items-center gap-1.5">
                            Thinking
                        </p>
                        {row.durationMs && (
                            <span className="text-[10px] text-muted-foreground/70 tabular-nums flex items-center gap-1">
                                <Clock size={9} className="opacity-60" />
                                {formatDuration(row.durationMs)}
                            </span>
                        )}
                    </div>
                    <p className="text-muted-foreground/80 text-[11px] leading-relaxed line-clamp-2">{row.content}</p>
                </div>
            </div>
        );
    }

    if (row.kind === 'user_steer') {
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "bg-gradient-to-br from-violet-50 to-fuchsia-50",
                        "dark:from-violet-900/30 dark:to-fuchsia-900/20",
                        "border border-violet-200 dark:border-white/10 dark:bg-white/[0.04]",
                        "shadow-sm"
                    )}>
                        <MessageSquarePlus size={12} className="text-violet-600 dark:text-zinc-300" />
                    </div>
                    {!isLast && (
                        <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                    )}
                </div>
                <div className="pb-2 flex-1 min-w-0 pt-0.5">
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-zinc-300">
                        User Steer
                    </p>
                    <p className="text-muted-foreground/85 text-[11px] leading-relaxed whitespace-pre-wrap break-words">{row.content}</p>
                </div>
            </div>
        );
    }

    if (row.kind === 'error') {
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "bg-gradient-to-br from-red-50 to-rose-50",
                        "dark:from-red-900/30 dark:to-rose-900/20",
                        "border border-red-200 dark:border-red-800",
                        "shadow-sm"
                    )}>
                        <AlertTriangle size={12} className="text-red-600 dark:text-red-400" />
                    </div>
                    {!isLast && (
                        <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                    )}
                </div>
                <div className="pb-2 flex-1 min-w-0 pt-0.5">
                    <TimelineErrorNotice error={row.content} compact showIcon={false} />
                </div>
            </div>
        );
    }

    if (row.kind === 'tool_group') {
        const isRunning = row.status === 'running';
        const isError = row.status === 'error';
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "border shadow-sm transition-[background-color,border-color,color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none",
                        isError
                            ? "bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-900/30 dark:to-rose-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                            : isRunning
                                ? "bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-900/30 dark:to-yellow-900/20 border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400"
                                : "bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/30 dark:to-green-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400"
                    )}>
                        {isError ? <XCircle size={12} /> : isRunning ? <Terminal size={12} /> : <CheckCircle2 size={12} />}
                    </div>
                    {!isLast && (
                        <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                    )}
                </div>
                <div className="pb-2 w-full min-w-0 pt-0.5">
                    <button
                        type="button"
                        className={cn(
                            "min-h-10 w-full text-left group rounded-lg px-2 py-1.5 -mx-1 -my-0.5",
                            "hover:bg-muted/60 hover:shadow-sm active:scale-[0.99]",
                            "transition-[background-color,box-shadow,transform] duration-150"
                        )}
                        onClick={() => setIsDetailsOpen(value => !value)}
                        aria-expanded={isDetailsOpen}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-[11px] font-semibold text-foreground/85 tabular-nums">
                                {getToolGroupTitle(row)}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {row.durationMs ? (
                                    <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                                        {formatDuration(row.durationMs)}
                                    </span>
                                ) : null}
                                <ChevronRight
                                    size={12}
                                    className={cn(
                                        "text-muted-foreground/50 transition-transform duration-150",
                                        isDetailsOpen && "rotate-90"
                                    )}
                                />
                            </div>
                        </div>
                    </button>

                    <Collapsible open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                        <CollapsibleContent className="mt-2 space-y-2 border-l border-border/50 pl-3">
                            {row.toolCalls.map((call, index) => (
                                <TimelineRowItem
                                    key={call.key || index}
                                    row={call}
                                    isLast={index === row.toolCalls.length - 1}
                                />
                            ))}
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            </div>
        );
    }

    if (row.kind === 'exploration') {
        const isRunning = row.status === 'running';
        const isError = row.status === 'error';
        const title = isRunning ? 'Exploring' : 'Explored';
        const compactSummary = summarizeExplorationItems(row.items);
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "border shadow-sm transition-[background-color,border-color,color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none",
                        isError
                            ? "bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-900/30 dark:to-rose-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                            : isRunning
                                ? "bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-900/30 dark:to-yellow-900/20 border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400"
                                : "bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/30 dark:to-green-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400"
                    )}>
                        {isError ? <XCircle size={12} /> : isRunning ? <Terminal size={12} /> : <CheckCircle2 size={12} />}
                    </div>
                    {!isLast && (
                        <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                    )}
                </div>
                <div className="pb-2 w-full min-w-0 pt-0.5">
                    <button
                        type="button"
                        className={cn(
                            "w-full text-left group rounded-lg px-2 py-1.5 -mx-1 -my-0.5",
                            "hover:bg-muted/60 hover:shadow-sm",
                            "transition-[background-color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none"
                        )}
                        onClick={() => setIsDetailsOpen(v => !v)}
                        aria-expanded={isDetailsOpen}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="text-[11px] font-semibold text-foreground/85">{title}</div>
                                {compactSummary ? (
                                    <div className="mt-1 truncate text-[11px] text-muted-foreground/85" title={compactSummary}>
                                        {compactSummary}
                                    </div>
                                ) : null}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {row.durationMs ? (
                                    <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                                        {formatDuration(row.durationMs)}
                                    </span>
                                ) : null}
                                <ChevronRight
                                    size={12}
                                    className={cn(
                                        "text-muted-foreground/50 transition-transform duration-200",
                                        isDetailsOpen && "rotate-90"
                                    )}
                                />
                            </div>
                        </div>
                    </button>

                    <Collapsible open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                        <CollapsibleContent className="mt-2 space-y-2">
                            {row.toolCalls.map((call, index) => (
                                <div key={call.key || index} className="rounded-lg border bg-muted/20 p-2">
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/65">
                                            {call.toolName}
                                        </span>
                                        {call.durationMs ? (
                                            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                                                {formatDuration(call.durationMs)}
                                            </span>
                                        ) : null}
                                    </div>
                                    {!isEmptyToolPayload(call.toolInput) ? (
                                        <ToolPayloadDisplay payload={call.toolInput} className="max-h-32" variant="raw" />
                                    ) : null}
                                </div>
                            ))}
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            </div>
        );
    }

    const summary = getToolSummary(row.toolName, row.toolInput) || getToolSummary(row.toolName, row.toolOutput);
    const status = row.isError
        ? 'error'
        : row.completedAtMs != null || (row.toolOutput !== undefined && row.toolOutput !== null)
            ? 'completed'
            : 'running';

    return (
        <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
            <div className="flex flex-col items-center">
                <div className={cn(
                    "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                    "border shadow-sm transition-[background-color,border-color,color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none",
                    status === 'error'
                        ? "bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-900/30 dark:to-rose-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                        : status === 'completed'
                            ? "bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/30 dark:to-green-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400"
                            : "bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-900/30 dark:to-yellow-900/20 border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400"
                )}>
                    {status === 'error' 
                        ? <XCircle size={12} /> 
                        : status === 'completed' 
                            ? <CheckCircle2 size={12} /> 
                            : <Terminal size={12} />
                    }
                </div>
                {!isLast && (
                    <div className="w-px flex-1 bg-gradient-to-b from-border via-border/50 to-transparent my-1.5" />
                )}
            </div>
            <div className="pb-2 w-full min-w-0 pt-0.5">
                <button
                    type="button"
                    className={cn(
                        "w-full text-left group rounded-lg px-2 py-1.5 -mx-1 -my-0.5",
                        "hover:bg-muted/60 hover:shadow-sm",
                        "transition-[background-color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none"
                    )}
                    onClick={() => setIsDetailsOpen(v => !v)}
                    aria-expanded={isDetailsOpen}
                >
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <code className={cn(
                                "text-[10px] px-2 py-0.5 rounded-md border font-medium",
                                "bg-amber-50 dark:bg-amber-950/30",
                                "border-amber-200 dark:border-amber-800",
                                "text-amber-700 dark:text-amber-400",
                                "shrink-0"
                            )}>
                                {row.toolName}
                            </code>
                            {summary && (
                                <span
                                    className="text-[11px] text-muted-foreground/80 truncate"
                                    title={summary}
                                >
                                    {summary}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {row.durationMs && (
                                <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                                    {formatDuration(row.durationMs)}
                                </span>
                            )}
                            <ChevronRight 
                                size={12} 
                                className={cn(
                                    "text-muted-foreground/50 transition-transform duration-200",
                                    isDetailsOpen && "rotate-90"
                                )} 
                            />
                        </div>
                    </div>
                </button>

                <Collapsible open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
                    <CollapsibleContent className="mt-2 space-y-2">
                        {!isEmptyToolPayload(row.toolInput) && (
                            <div className="text-[10px]">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <div className="w-1 h-1 rounded-full bg-blue-400" />
                                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Input</span>
                                </div>
                                <ToolPayloadDisplay payload={row.toolInput} className="max-h-32" variant="raw" />
                            </div>
                        )}
                        {row.toolOutput !== undefined && (
                            <div className="text-[10px]">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <div className="w-1 h-1 rounded-full bg-emerald-400" />
                                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Output</span>
                                </div>
                                <ToolPayloadDisplay payload={row.toolOutput} className="max-h-32" variant="raw" />
                            </div>
                        )}
                        {row.isError && row.toolOutput == null && (
                            <div className="text-[10px] text-red-500 flex items-center gap-1.5">
                                <AlertTriangle size={10} />
                                Tool execution failed
                            </div>
                        )}
                    </CollapsibleContent>
                </Collapsible>
            </div>
        </div>
    );
}

export function buildTimelineRows(events: TimelineEvent[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    const toolRowById = new Map<string, number>();
    let lastOpenToolIndex: number | null = null;
    let fallbackRowSequence = 0;

    const buildRowKey = (prefix: string, event: TimelineEvent, explicitId?: string) => {
        if (explicitId) return `${prefix}_${explicitId}`;
        const toolUseId = extractToolUseId(event);
        if (toolUseId) return `${prefix}_${toolUseId}`;
        const providerItemId = (event as any).provider_item_id;
        if (providerItemId) return `${prefix}_${providerItemId}`;
        const timestampPart = event.timestamp != null ? String(event.timestamp) : 'unknown';
        const seqPart = fallbackRowSequence++;
        return `${prefix}_${timestampPart}_${seqPart}`;
    };

    for (const event of events) {
        if (event.type === 'message') {
            const content = event.content ?? '';
            if (!content) continue;
            rows.push({
                kind: 'message',
                key: buildRowKey('message', event),
                content: truncateTimelineText(content),
            });
            continue;
        }

        if (event.type === 'thinking') {
            const eventLike = event as any;
            const hasDeltaMarker =
                Object.prototype.hasOwnProperty.call(eventLike, 'isDelta') ||
                Object.prototype.hasOwnProperty.call(eventLike, 'is_delta');
            const isDelta = Boolean(eventLike.isDelta || eventLike.is_delta);
            const lastRow = rows[rows.length - 1];
            if ((isDelta || !hasDeltaMarker) && lastRow?.kind === 'thinking') {
                lastRow.content = appendTimelineText(lastRow.content, event.content);
                lastRow.durationMs = event.durationMs ?? lastRow.durationMs;
            } else {
                rows.push({
                    kind: 'thinking',
                    key: buildRowKey('thinking', event),
                    content: truncateTimelineText(event.content),
                    durationMs: event.durationMs,
                });
            }
            continue;
        }

        if (event.type === 'user_steer_requested') {
            rows.push({
                kind: 'user_steer',
                key: buildRowKey('user_steer_requested', event),
                content: event.content ?? '',
            });
            continue;
        }

        if (event.type === 'error') {
            rows.push({
                kind: 'error',
                key: buildRowKey('error', event),
                content: event.content ?? event.error ?? undefined,
            });
            continue;
        }

        const toolName = extractToolName(event);
        if (event.type === 'tool_use') {
            const toolUseId = extractToolUseId(event);
            if (toolUseId && toolRowById.has(toolUseId)) {
                const existingIndex = toolRowById.get(toolUseId)!;
                const existing = rows[existingIndex] as Extract<TimelineRow, { kind: 'tool' }>;
                existing.toolName = chooseSpecificToolName(existing.toolName, toolName || existing.toolName);
                const nextInput = extractToolInput(event);
                if (!isEmptyToolPayload(nextInput)) existing.toolInput = nextInput;
                const nextOutput = extractToolOutput(event);
                if (nextOutput !== undefined && nextOutput !== null) existing.toolOutput = nextOutput;
                existing.isError = existing.isError || extractIsError(event);
                existing.commandActions = extractCommandActions(event) ?? existing.commandActions;
                existing.startedAtMs = existing.startedAtMs ?? getTimestampMs(event.timestamp);
                existing.durationMs = event.durationMs ?? event.duration_ms ?? existing.durationMs;
                lastOpenToolIndex = existingIndex;
                continue;
            }
            const toolRow: TimelineRow = {
                kind: 'tool',
                key: buildRowKey(toolName || 'tool', event),
                toolName: toolName || 'tool',
                toolInput: extractToolInput(event),
                toolOutput: extractToolOutput(event) ?? undefined,
                isError: extractIsError(event),
                durationMs: event.durationMs ?? event.duration_ms,
                startedAtMs: getTimestampMs(event.timestamp),
                commandActions: extractCommandActions(event),
            };
            const rowIndex = rows.push(toolRow) - 1;
            if (toolUseId) toolRowById.set(toolUseId, rowIndex);
            lastOpenToolIndex = rowIndex;
            continue;
        }

        if ((event as any).type === 'tool_output_delta') {
            const toolUseId = extractToolUseId(event);
            const delta = typeof (event as any).delta === 'string' ? (event as any).delta : '';
            let rowIndex = toolUseId ? toolRowById.get(toolUseId) : undefined;
            if (rowIndex === undefined && lastOpenToolIndex !== null) {
                rowIndex = lastOpenToolIndex;
            }
            if (rowIndex !== undefined && delta) {
                const row = rows[rowIndex] as Extract<TimelineRow, { kind: 'tool' }>;
                const existingOutput = typeof row.toolOutput === 'string' ? row.toolOutput : '';
                row.toolOutput = existingOutput ? `${existingOutput}${delta}` : delta;
            }
            continue;
        }

        if (event.type === 'tool_result' || (event as any).type === 'tool_error') {
            const toolUseId = extractToolUseId(event);
            let rowIndex = toolUseId ? toolRowById.get(toolUseId) : undefined;
            if (rowIndex === undefined && lastOpenToolIndex !== null) {
                const candidate = rows[lastOpenToolIndex];
                if (candidate?.kind === 'tool' && candidate.toolOutput === undefined) {
                    rowIndex = lastOpenToolIndex;
                }
            }

            if (rowIndex !== undefined) {
                const row = rows[rowIndex] as Extract<TimelineRow, { kind: 'tool' }>;
                row.toolOutput = extractToolOutput(event);
                row.isError = extractIsError(event);
                row.completedAtMs = getTimestampMs(event.timestamp);
                const explicitDuration = event.durationMs ?? event.duration_ms;
                if (explicitDuration) {
                    row.durationMs = explicitDuration;
                } else if (row.startedAtMs && row.completedAtMs) {
                    row.durationMs = Math.max(0, row.completedAtMs - row.startedAtMs);
                }
                continue;
            }

            rows.push({
                kind: 'tool',
                key: buildRowKey(toolName || 'tool', event),
                toolName: toolName || 'tool',
                toolInput: extractToolInput(event),
                toolOutput: extractToolOutput(event),
                isError: extractIsError(event),
                durationMs: event.durationMs ?? event.duration_ms,
                completedAtMs: getTimestampMs(event.timestamp),
                commandActions: extractCommandActions(event),
            });
        }
    }

    return groupRelatedToolRows(coalesceExplorationRows(rows));
}

function appendTimelineText(existing: string | undefined, addition: string | undefined): string {
    if (!addition) return existing ?? '';
    if ((existing ?? '').includes(TIMELINE_TEXT_TRUNCATION_NOTICE)) return existing ?? '';
    return truncateTimelineText(`${existing ?? ''}${addition}`) ?? '';
}

function truncateTimelineText(content: string | undefined): string | undefined {
    if (!content || content.length <= MAX_TIMELINE_TEXT_CONTENT_CHARS) return content;
    return `${content.slice(0, MAX_TIMELINE_TEXT_CONTENT_CHARS).trimEnd()}${TIMELINE_TEXT_TRUNCATION_NOTICE}`;
}

function extractToolUseId(event: TimelineEvent): string | undefined {
    const providerItem = (event as any).providerItem ?? (event as any).provider_item;
    return event.toolUseId
        || event.tool_use_id
        || (event as any).provider_item_id
        || (event.id ? String(event.id) : undefined)
        || (providerItem?.id ? String(providerItem.id) : undefined);
}

function extractToolName(event: TimelineEvent): string | undefined {
    const providerItem = (event as any).providerItem ?? (event as any).provider_item;
    return event.toolName
        || event.tool
        || (event as any).tool_name
        || (event as any).name
        || providerItem?.type
        || providerItem?.name
        || providerItem?.tool;
}

function chooseSpecificToolName(current: string, next: string): string {
    const currentName = current || 'tool';
    const nextName = next || 'tool';
    if (currentName.toLowerCase() === 'tool' && nextName.toLowerCase() !== 'tool') return nextName;
    return currentName;
}

function extractToolInput(event: TimelineEvent): any {
    if (event.toolInput !== undefined) return event.toolInput;
    if (event.input !== undefined) return event.input;
    const providerItem = (event as any).providerItem ?? (event as any).provider_item;
    return (event as any).tool_input
        ?? (event as any).parameters
        ?? providerItem?.input
        ?? providerItem?.arguments
        ?? providerItem
        ?? undefined;
}

function extractToolOutput(event: TimelineEvent): any {
    if (event.toolOutput !== undefined) return event.toolOutput;
    if (event.output !== undefined) return event.output;
    const directOutput = (event as any).tool_output ?? (event as any).result ?? undefined;
    if (directOutput !== undefined) return directOutput;
    const providerItem = (event as any).providerItem ?? (event as any).provider_item;
    if (providerItem?.result !== undefined || providerItem?.aggregatedOutput !== undefined) return providerItem;
    return undefined;
}

function extractIsError(event: TimelineEvent): boolean {
    if (event.isError !== undefined) return event.isError;
    if (event.error) return true;
    return (event as any).type === 'tool_error';
}

function getTimestampMs(timestamp: unknown): number | null {
    if (typeof timestamp === 'number') return timestamp;
    if (typeof timestamp === 'string') {
        const ms = Date.parse(timestamp);
        return Number.isNaN(ms) ? null : ms;
    }
    return null;
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatToolPayload(payload: any): string {
    const formatted = formatFullToolPayload(payload);
    if (formatted.length <= MAX_TOOL_PAYLOAD_CONTENT_CHARS) return formatted;
    return `${formatted.slice(0, MAX_TOOL_PAYLOAD_CONTENT_CHARS).trimEnd()}${TOOL_PAYLOAD_TRUNCATION_NOTICE}`;
}

function formatFullToolPayload(payload: any): string {
    if (payload === null || payload === undefined) return '';
    return formatReadableToolValue(payload, new WeakSet<object>());
}

export function isEmptyToolPayload(payload: any): boolean {
    if (payload === null || payload === undefined) return true;
    if (typeof payload === 'object' && !Array.isArray(payload)) {
        return Object.keys(payload).length === 0;
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbablyBinaryData(value: string): boolean {
    if (value.startsWith('data:image/') || value.startsWith('data:audio/') || value.startsWith('data:video/')) return true;
    if (value.length < 512 || /\s/.test(value)) return false;
    const sample = value.slice(0, 2048);
    return /^[A-Za-z0-9+/=_-]+$/.test(sample);
}

function formatReadableToolValue(value: unknown, seen: WeakSet<object>): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') {
        if (value === '') return '""';
        return isProbablyBinaryData(value) ? `[binary data omitted - ${value.length.toLocaleString()} characters]` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular reference omitted]';
    seen.add(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value
            .map((item) => formatReadableToolValue(item, seen).trim())
            .filter(Boolean)
            .map((item) => item.includes('\n') ? `• ${item.replace(/\n/g, '\n  ')}` : `• ${item}`);
        return items.join('\n');
    }

    if (Object.keys(value).length === 0) return '{}';
    const lines: string[] = [];
    for (const [key, child] of Object.entries(value)) {
        const formatted = formatReadableToolValue(child, seen).trim();
        if (formatted.includes('\n') || (typeof child === 'object' && child !== null)) {
            lines.push(`${key}\n${formatted.split('\n').map((line) => `  ${line}`).join('\n')}`);
        } else {
            lines.push(`${key}: ${formatted}`);
        }
    }
    return lines.join('\n\n');
}

function getChangeKind(change: Record<string, any>): string {
    const kind = change.kind;
    if (typeof kind === 'string') return kind;
    if (isRecord(kind) && typeof kind.type === 'string') return kind.type;
    return 'updated';
}

function cleanChangePath(path: string): string {
    const worktreeMatch = path.match(/\/\.git\/agentree\/worktrees\/[^/]+\/(.+)$/);
    if (worktreeMatch?.[1]) return worktreeMatch[1];
    const agentWorktreeMatch = path.match(/\/\.agentree\/worktrees\/[^/]+\/nodes\/[^/]+\/(.+)$/);
    if (agentWorktreeMatch?.[1]) return agentWorktreeMatch[1];
    if (!path.startsWith('/')) return path;
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-3).join('/') || path;
}

function countNonEmptyLines(text: string): number {
    return text.split('\n').filter((line, index, lines) => (
        line.length > 0 || index < lines.length - 1
    )).length;
}

function countUnifiedDiffLines(diff: string, kind: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        if (line.startsWith('-')) deletions += 1;
    }

    if (additions === 0 && deletions === 0) {
        const lineCount = countNonEmptyLines(diff);
        if (kind === 'add') additions = lineCount;
        if (kind === 'delete') deletions = lineCount;
    }

    return { additions, deletions };
}

export function summarizeFileChangesPayload(payload: unknown): FileChangesSummary | null {
    if (!isRecord(payload) || !Array.isArray(payload.changes)) return null;

    const files = payload.changes.flatMap((change): FileChangeSummary[] => {
        if (!isRecord(change) || typeof change.path !== 'string') return [];
        const kind = getChangeKind(change);
        const diff = typeof change.diff === 'string' ? change.diff : '';
        const counts = countUnifiedDiffLines(diff, kind);
        return [{
            path: cleanChangePath(change.path),
            kind,
            additions: counts.additions,
            deletions: counts.deletions,
        }];
    });

    if (files.length === 0) return null;

    return {
        files,
        totalAdditions: files.reduce((total, file) => total + file.additions, 0),
        totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
    };
}

export function formatFileChangesSummaryLabel(summary: FileChangesSummary): string {
    const fileLabel = summary.files.length === 1 ? 'file' : 'files';
    return `${summary.files.length} ${fileLabel} changed (+${summary.totalAdditions}/-${summary.totalDeletions})`;
}

function FileChangesSummaryView({ summary, className }: { summary: FileChangesSummary; className?: string }) {
    const fileLabel = summary.files.length === 1 ? 'file' : 'files';
    const visibleFiles = summary.files.slice(0, 3);
    const hiddenFileCount = Math.max(0, summary.files.length - visibleFiles.length);
    return (
        <div
            className={cn(
                "overflow-hidden rounded-md border border-[hsl(var(--app-border)/0.62)]",
                "bg-[hsl(var(--app-panel)/0.72)]",
                "text-[10px] text-muted-foreground/80",
                "shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.5)]",
                "dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                className
            )}
        >
            <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--app-border)/0.52)] bg-muted/40 px-2.5 py-1.5">
                <div className="min-w-0">
                    <span className="block truncate text-[11px] font-semibold leading-none text-foreground/80">
                        {summary.files.length} {fileLabel} changed
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] leading-none tabular-nums">
                    <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                        +{summary.totalAdditions}
                    </span>
                    <span className="rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-red-600 dark:text-red-300">
                        -{summary.totalDeletions}
                    </span>
                </div>
            </div>
            <div className="px-2 py-1.5">
                <div className="space-y-1">
                    {visibleFiles.map((file, index) => (
                        <div
                            key={`${file.path}_${index}`}
                            className="flex min-w-0 items-center gap-2"
                        >
                            <span className={cn(
                                "inline-flex w-8 shrink-0 justify-center rounded border px-1 py-0.5 font-mono text-[8px] font-semibold leading-none",
                                getFileChangeToneClass(file.kind)
                            )}>
                                {formatFileChangeKind(file.kind)}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-tight text-foreground/75" title={file.path}>
                                {file.path}
                            </span>
                            <span className="shrink-0 font-mono text-[9px] leading-none tabular-nums">
                                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                                <span className="px-0.5 text-muted-foreground/40">/</span>
                                <span className="text-red-500 dark:text-red-400">-{file.deletions}</span>
                            </span>
                        </div>
                    ))}
                </div>
                {hiddenFileCount > 0 ? (
                    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-[hsl(var(--app-border)/0.42)] pt-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground/70">
                            {hiddenFileCount} more {hiddenFileCount === 1 ? 'file' : 'files'}
                        </span>
                        <span className="text-[9px] font-medium text-muted-foreground/60">
                            expand for full diff
                        </span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function formatFileChangeKind(kind: string): string {
    const normalized = kind.toLowerCase();
    if (normalized === 'add' || normalized === 'added' || normalized === 'create') return 'ADD';
    if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove') return 'DEL';
    if (normalized === 'move' || normalized === 'rename') return 'REN';
    if (normalized === 'update' || normalized === 'modify' || normalized === 'modified') return 'MOD';
    return normalized.slice(0, 3).toUpperCase() || 'CHG';
}

function getFileChangeToneClass(kind: string): string {
    const normalized = kind.toLowerCase();
    if (normalized === 'add' || normalized === 'added' || normalized === 'create') {
        return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    }
    if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove') {
        return 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300';
    }
    if (normalized === 'move' || normalized === 'rename') {
        return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    }
    return 'border-border/50 bg-muted/40 text-muted-foreground/80';
}

export function ToolPayloadDisplay({
    payload,
    className,
    variant = 'summary',
}: {
    payload: unknown;
    className?: string;
    variant?: 'summary' | 'raw';
}): ReactNode {
    const [showProviderPayload, setShowProviderPayload] = useState(false);
    const fileChangesSummary = summarizeFileChangesPayload(payload);
    if (variant === 'summary' && fileChangesSummary) {
        return <FileChangesSummaryView summary={fileChangesSummary} className={className} />;
    }
    if (variant === 'raw' && fileChangesSummary) {
        return (
            <div className="min-w-0 max-w-full">
                <ToolFileChangesDiff payload={payload} className={className} />
                <button
                    type="button"
                    className="mt-1 min-h-8 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted/50 hover:text-foreground/80 active:scale-[0.98]"
                    onClick={(event) => {
                        event.stopPropagation();
                        setShowProviderPayload((value) => !value);
                    }}
                >
                    {showProviderPayload ? 'Hide provider payload' : 'Show provider payload'}
                </button>
                {showProviderPayload ? <ToolPayloadTextView payload={payload} className={className} /> : null}
            </div>
        );
    }

    return <ToolPayloadTextView payload={payload} className={className} />;
}

function ToolPayloadTextView({ payload, className }: { payload: unknown; className?: string }): ReactNode {
    const [showFullPayload, setShowFullPayload] = useState(false);
    const fullPayload = formatFullToolPayload(payload);
    const isTruncated = fullPayload.length > MAX_TOOL_PAYLOAD_CONTENT_CHARS;
    const displayedPayload = showFullPayload
        ? fullPayload
        : isTruncated
            ? `${fullPayload.slice(0, MAX_TOOL_PAYLOAD_CONTENT_CHARS).trimEnd()}${TOOL_PAYLOAD_TRUNCATION_NOTICE}`
            : fullPayload;

    return (
        <div className="min-w-0 max-w-full">
            <pre className={cn(
                "overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-2.5 font-mono text-[10px] text-muted-foreground/80",
                className,
            )}>
                {displayedPayload}
            </pre>
            {isTruncated ? (
                <button
                    type="button"
                    className="mt-1 min-h-8 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted/50 hover:text-foreground/80 active:scale-[0.98]"
                    onClick={(event) => {
                        event.stopPropagation();
                        setShowFullPayload((value) => !value);
                    }}
                >
                    {showFullPayload
                        ? 'Show payload preview'
                        : `Show full payload (${Math.ceil(fullPayload.length / 1024).toLocaleString()} KB)`}
                </button>
            ) : null}
        </div>
    );
}

export function getToolSummary(toolName: string, toolInput: any): string {
    const summary = buildToolSummary(toolName, toolInput).replace(/\s+/g, ' ').trim();
    if (summary.length <= MAX_TOOL_SUMMARY_CHARS) return summary;
    return `${summary.slice(0, MAX_TOOL_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function buildToolSummary(toolName: string, toolInput: any): string {
    if (isEmptyToolPayload(toolInput)) return '';
    const name = toolName?.toLowerCase?.() ?? '';
    const fileChangesSummary = summarizeFileChangesPayload(toolInput);
    if (fileChangesSummary) return formatFileChangesSummaryLabel(fileChangesSummary);

    if (typeof toolInput === 'string') return summarizeToolText(name, toolInput);
    if (!isRecord(toolInput)) return Array.isArray(toolInput) && toolInput.length > 0 ? `${toolInput.length} items` : '';
    if (name === 'commandexecution') {
        const items = getCommandExecutionSummaryItems(toolInput);
        if (items.length > 0) return summarizeCommandItems(items);
    }
    if (name === 'bash' && typeof toolInput.command === 'string') return summarizeShellCommand(toolInput.command);
    if (name === 'glob' && typeof toolInput.pattern === 'string') return toolInput.pattern;
    if (name === 'grep' && typeof toolInput.pattern === 'string') {
        return toolInput.path ? `${toolInput.pattern} in ${toolInput.path}` : toolInput.pattern;
    }
    if (name === 'read') {
        const path = toolInput.path || toolInput.file_path;
        if (typeof path === 'string') return formatPathWithLineRange(cleanChangePath(path), lineRangeFromToolInput(toolInput));
    }
    if (name === 'write' && typeof toolInput.path === 'string') return cleanChangePath(toolInput.path);
    if (name === 'edit' && typeof toolInput.file_path === 'string') return cleanChangePath(toolInput.file_path);
    if (name === 'apply_patch' && typeof toolInput.path === 'string') return toolInput.path;
    if (name === 'webfetch' && typeof toolInput.url === 'string') return toolInput.url;
    if (name === 'codesearch' && typeof toolInput.query === 'string') return toolInput.query;
    if (name === 'task' && typeof toolInput.description === 'string') return toolInput.description;
    const agentreeSummary = summarizeAgentreeMcpTool(name, toolInput);
    if (agentreeSummary) return agentreeSummary;

    const knownKey = toolInput.description
        || toolInput.title
        || toolInput.file_path
        || toolInput.path
        || toolInput.query
        || toolInput.url
        || toolInput.pattern
        || toolInput.skill
        || toolInput.status;
    if (typeof knownKey === 'string') return firstNonEmptyLine(knownKey);
    return formatToolPayload(toolInput);
}

function summarizeAgentreeMcpTool(toolName: string, input: Record<string, any>): string | null {
    const name = toolName.replace(/^mcp__/, '').replace(/^agentree(?:__|[._-])/, '');
    const templateId = typeof input.template_id === 'string' ? input.template_id : null;
    const messageLine = typeof input.message === 'string' ? firstNonEmptyLine(input.message) : null;

    if (name === 'spawn_thread') {
        const titleLine = typeof input.title === 'string' ? firstNonEmptyLine(input.title) : null;
        return titleLine ? `Create child thread: ${titleLine}` : 'Create child thread';
    }
    if (name === 'send_message') {
        return messageLine ? `Send agent: ${messageLine}` : 'Send agent message';
    }
    if (name === 'show_thread') {
        return typeof input.thread_id === 'string' ? `Show thread ${input.thread_id.slice(0, 8)}` : 'Show current thread';
    }
    if (name === 'steer_agent' || name === 'stop_agent') {
        const action = name === 'steer_agent' ? 'Steer' : 'Stop';
        const assistantNodeId = typeof input.assistant_node_id === 'string' ? input.assistant_node_id.slice(0, 8) : 'agent';
        return `${action} ${assistantNodeId}`;
    }

    if (name === 'wait_for_agents') {
        const ids = Array.isArray(input.assistant_node_ids) ? input.assistant_node_ids.length : null;
        const condition = typeof input.condition === 'string' ? input.condition : 'all_done';
        const noun = 'agent';
        return ids ? `Wait for ${ids} ${ids === 1 ? noun : `${noun}s`} (${condition})` : `Wait for ${noun}s (${condition})`;
    }
    if (name === 'list_prompt_templates') {
        const kind = typeof input.kind === 'string' ? input.kind : null;
        return kind ? `List ${kind} templates` : 'List prompt templates';
    }
    if (name === 'get_prompt_template') {
        return templateId ? `Read ${templateId}` : 'Read prompt template';
    }
    return null;
}

function summarizeToolText(toolName: string, text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const name = toolName.toLowerCase();

    if (name === 'read') {
        const range = lineRangeFromOutput(trimmed);
        return range ? `lines ${range.start}-${range.end}` : firstNonEmptyLine(trimmed);
    }

    if (name === 'grep') {
        const foundFiles = summarizeFoundFiles(trimmed);
        if (foundFiles) return foundFiles;
        const range = lineRangeFromOutput(trimmed);
        if (range) return range.start === range.end ? `match at line ${range.start}` : `matches at lines ${range.start}-${range.end}`;
    }

    if (name === 'edit' || name === 'write' || name === 'multiedit') {
        const updatedPath = extractUpdatedFilePath(trimmed);
        if (updatedPath) return `Updated ${updatedPath}`;
        const toolError = extractToolUseError(trimmed);
        if (toolError) return toolError;
    }

    if (name === 'bash') {
        const buildSummary = summarizeBuildOutput(trimmed);
        if (buildSummary) return buildSummary;
    }

    if (name === 'todowrite') {
        if (/todos? (?:have been )?modified successfully/i.test(trimmed)) return 'Updated todos';
    }

    return firstNonEmptyLine(trimmed);
}

function firstNonEmptyLine(text: string): string {
    return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text.trim();
}

function summarizeShellCommand(command: string): string {
    const summaryItems = parseCommandSummaryFromShell(command);
    if (summaryItems.length > 0) return summarizeCommandItems(summaryItems);
    return stripShellWrapper(command).trim();
}

function numericValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
}

function lineRangeFromToolInput(input: Record<string, any>): { start: number; end: number } | null {
    const start = numericValue(input.start)
        ?? numericValue(input.start_line)
        ?? numericValue(input.startLine)
        ?? numericValue(input.offset);
    const end = numericValue(input.end)
        ?? numericValue(input.end_line)
        ?? numericValue(input.endLine);
    const limit = numericValue(input.limit);
    if (start == null && end == null) return null;
    const resolvedStart = start ?? end!;
    const resolvedEnd = end ?? (limit != null ? resolvedStart + Math.max(0, limit - 1) : resolvedStart);
    return { start: resolvedStart, end: resolvedEnd };
}

function formatPathWithLineRange(path: string, range: { start: number; end: number } | null): string {
    if (!range) return path;
    return range.start === range.end ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`;
}

function lineRangeFromOutput(text: string): { start: number; end: number } | null {
    const numbers: number[] = [];
    for (const line of text.split('\n')) {
        const match = line.match(/^\s*(\d+)(?:\t|[:-])/);
        if (match?.[1]) numbers.push(Number(match[1]));
    }
    if (numbers.length === 0) return null;
    return { start: Math.min(...numbers), end: Math.max(...numbers) };
}

function summarizeFoundFiles(text: string): string | null {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const header = lines[0]?.match(/^Found\s+(\d+)\s+files?$/i);
    if (!header) return null;
    const count = Number(header[1]);
    const files = lines.slice(1, 4).map(cleanChangePath);
    const suffix = count > files.length ? `, +${count - files.length} more` : '';
    return files.length > 0 ? `Found ${count} ${count === 1 ? 'file' : 'files'}: ${files.join(', ')}${suffix}` : `Found ${count} ${count === 1 ? 'file' : 'files'}`;
}

function extractUpdatedFilePath(text: string): string | null {
    const match = text.match(/^The file\s+(.+?)\s+has been updated successfully\.?$/i);
    return match?.[1] ? cleanChangePath(match[1]) : null;
}

function extractToolUseError(text: string): string | null {
    const match = text.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i);
    return match?.[1] ? firstNonEmptyLine(match[1]).replace(/\s+/g, ' ') : null;
}

function summarizeBuildOutput(text: string): string | null {
    if (!/\bFinished\s+`?[^`\n]+`?\s+profile/i.test(text)) return null;
    const warningCount = (text.match(/\bwarning:/g) ?? []).length;
    if (warningCount > 0) return `Build completed with ${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`;
    return 'Build completed';
}

function extractCommandActions(event: TimelineEvent): CommandAction[] | undefined {
    const direct = event.commandActions;
    if (Array.isArray(direct)) return direct;

    const toolInput = extractToolInput(event);
    if (toolInput && Array.isArray(toolInput.commandActions)) return toolInput.commandActions;
    if (toolInput && Array.isArray(toolInput.command_actions)) return toolInput.command_actions;

    const providerItem = (event as any).providerItem ?? (event as any).provider_item;
    if (providerItem && Array.isArray(providerItem.commandActions)) return providerItem.commandActions;
    if (providerItem && Array.isArray(providerItem.command_actions)) return providerItem.command_actions;

    return undefined;
}

function getCommandExecutionSummaryItems(toolInput: any): CommandSummaryItem[] {
    if (!toolInput || typeof toolInput !== 'object') return [];
    if (Array.isArray(toolInput.commandActions)) return mapCommandActionsToItems(toolInput.commandActions);
    if (Array.isArray(toolInput.command_actions)) return mapCommandActionsToItems(toolInput.command_actions);
    if (typeof toolInput.command === 'string') return parseCommandSummaryFromShell(toolInput.command);
    return [];
}

function isCommandExecutionToolRow(row: TimelineRow): row is Extract<TimelineRow, { kind: 'tool' }> {
    return row.kind === 'tool' && row.toolName === 'commandExecution';
}

function isStandardCommandAction(action: CommandAction): boolean {
    return action.type === 'read' || action.type === 'list_files' || action.type === 'search';
}

function isStandardCommandExecutionRow(row: Extract<TimelineRow, { kind: 'tool' }>): boolean {
    return Array.isArray(row.commandActions) && row.commandActions.length > 0 && row.commandActions.every(isStandardCommandAction);
}

function getToolActivity(toolName: string): 'command' | 'search' | null {
    const tokens = toolName
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter(Boolean);

    if (tokens.some((token) => token === 'search' || token === 'grep' || token === 'glob' || token === 'find')) {
        return 'search';
    }
    if (tokens.some((token) => token === 'command' || token === 'exec' || token === 'execute' || token === 'execution' || token === 'run' || token === 'bash' || token === 'shell')) {
        return 'command';
    }
    return null;
}

function getToolRowStatus(row: TimelineToolRow): 'running' | 'completed' | 'error' {
    if (row.isError) return 'error';
    return row.completedAtMs != null || (row.toolOutput !== undefined && row.toolOutput !== null)
        ? 'completed'
        : 'running';
}

function buildToolGroup(activity: 'command' | 'search', rows: TimelineToolRow[]): Extract<TimelineRow, { kind: 'tool_group' }> {
    const durationMs = rows.reduce<number | undefined>((total, row) => {
        if (typeof row.durationMs !== 'number') return total;
        return (total ?? 0) + row.durationMs;
    }, undefined);
    const statuses = rows.map(getToolRowStatus);

    return {
        kind: 'tool_group',
        key: rows.map((row) => row.key).filter(Boolean).join('__'),
        activity,
        status: statuses.includes('error')
            ? 'error'
            : statuses.includes('running')
                ? 'running'
                : 'completed',
        durationMs,
        toolCalls: rows,
    };
}

export function groupRelatedToolRows(rows: TimelineRow[]): TimelineRow[] {
    const result: TimelineRow[] = [];
    let pendingActivity: 'command' | 'search' | null = null;
    let pendingRows: TimelineToolRow[] = [];

    const flush = () => {
        if (pendingRows.length === 1) {
            result.push(pendingRows[0]);
        } else if (pendingActivity && pendingRows.length > 1) {
            result.push(buildToolGroup(pendingActivity, pendingRows));
        }
        pendingActivity = null;
        pendingRows = [];
    };

    for (const row of rows) {
        if (row.kind !== 'tool') {
            flush();
            result.push(row);
            continue;
        }
        const activity = getToolActivity(row.toolName);
        if (!activity) {
            flush();
            result.push(row);
            continue;
        }
        if (pendingActivity && pendingActivity !== activity) flush();
        pendingActivity = activity;
        pendingRows.push(row);
    }
    flush();

    return result;
}

export function getToolGroupTitle(row: Extract<TimelineRow, { kind: 'tool_group' }>): string {
    const count = row.toolCalls.length;
    if (row.activity === 'command') return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`;
    return `${count} ${count === 1 ? 'search' : 'searches'}`;
}

export function countTimelineActivities(rows: TimelineRow[]): number {
    return rows.reduce((count, row) => {
        if (row.kind === 'tool_group' || row.kind === 'exploration') return count + row.toolCalls.length;
        return count + 1;
    }, 0);
}

function coalesceExplorationRows(rows: TimelineRow[]): TimelineRow[] {
    const result: TimelineRow[] = [];

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (!isCommandExecutionToolRow(row) || !isStandardCommandExecutionRow(row)) {
            result.push(row);
            continue;
        }

        const grouped: Extract<TimelineRow, { kind: 'tool' }>[] = [row];
        while (index + 1 < rows.length) {
            const next = rows[index + 1];
            if (!isCommandExecutionToolRow(next) || !isStandardCommandExecutionRow(next)) break;
            grouped.push(next);
            index += 1;
        }

        result.push(buildExplorationRow(grouped));
    }

    return result;
}

function buildExplorationRow(rows: Extract<TimelineRow, { kind: 'tool' }>[]): Extract<TimelineRow, { kind: 'exploration' }> {
    const allItems = rows.flatMap((row) => mapCommandActionsToItems(row.commandActions || []));
    const items: CommandSummaryItem[] = [];

    for (let index = 0; index < allItems.length; index++) {
        const item = allItems[index];
        const previous = items[items.length - 1];
        if (item.label === 'Read' && previous?.label === 'Read') {
            const nextNames = item.text.split(', ').filter(Boolean);
            const prevNames = previous.text.split(', ').filter(Boolean);
            previous.text = Array.from(new Set([...prevNames, ...nextNames])).join(', ');
            continue;
        }
        items.push(item);
    }

    const durationMs = rows.reduce<number | undefined>((total, row) => {
        if (typeof row.durationMs !== 'number') return total;
        return (total ?? 0) + row.durationMs;
    }, undefined);
    const status = rows.some((row) => row.isError)
        ? 'error'
        : rows.some((row) => row.completedAtMs == null && (row.toolOutput === undefined || row.toolOutput === null))
            ? 'running'
            : 'completed';

    return {
        kind: 'exploration',
        key: rows.map((row) => row.key).filter(Boolean).join('__'),
        status,
        durationMs,
        items,
        toolCalls: rows.map((row, index) => ({
            key: row.key ?? `command_${index}`,
            toolName: row.toolName,
            toolInput: row.toolInput,
            toolOutput: row.toolOutput,
            durationMs: row.durationMs,
            isError: row.isError,
            commandActions: row.commandActions,
        })),
    };
}

function pluralizeCommandLabel(label: string, count: number): string {
    const normalized = label.toLowerCase();
    if (count === 1) return normalized;
    if (normalized.endsWith('ch') || normalized.endsWith('sh')) return `${normalized}es`;
    if (normalized.endsWith('s')) return `${normalized}es`;
    return `${normalized}s`;
}

export function summarizeExplorationItems(items: Array<{ label: string; text: string }>): string {
    if (items.length === 0) return '';
    if (items.length === 1) return `${items[0].label} ${items[0].text}`.trim();

    const countsByLabel = new Map<string, number>();
    for (const item of items) {
        countsByLabel.set(item.label, (countsByLabel.get(item.label) ?? 0) + 1);
    }

    return Array.from(countsByLabel.entries())
        .map(([label, count]) => `${count} ${pluralizeCommandLabel(label, count)}`)
        .join(' • ');
}

function mapCommandActionsToItems(actions: CommandAction[]): CommandSummaryItem[] {
    return actions.map((action) => {
        switch (action.type) {
            case 'read':
                return { label: 'Read', text: action.name };
            case 'list_files':
                return { label: 'List', text: action.path || action.cmd };
            case 'search':
                if (action.query && action.path) return { label: 'Search', text: `${action.query} in ${action.path}` };
                if (action.query) return { label: 'Search', text: action.query };
                return { label: 'Search', text: action.cmd };
            default:
                return { label: 'Run', text: action.command || action.cmd || 'command' };
        }
    });
}

function summarizeCommandItems(items: CommandSummaryItem[]): string {
    return items
        .map((item) => `${item.label} ${item.text}`)
        .join(' • ');
}

function parseCommandSummaryFromShell(command: string): CommandSummaryItem[] {
    const script = stripShellWrapper(command);
    const trimmed = script.trim();
    if (!trimmed) return [];

    const rgFiles = trimmed.match(/\brg\s+--files(?:\s+([^\|\&;]+))?/);
    if (rgFiles) {
        const pathHint = rgFiles[1]?.trim();
        return [{ label: 'List', text: pathHint && pathHint.length > 0 ? pathHint : 'files' }];
    }

    const rgSearch = trimmed.match(/\brg\b(?:[^'"]|\s|'[^']*'|"[^"]*")*?\s(?:-n\s+)?(?:"([^"]+)"|'([^']+)'|([^\s\|]+))(?:\s+([^\|\&;]+))?/);
    if (rgSearch) {
        const query = rgSearch[1] || rgSearch[2] || rgSearch[3];
        const pathHint = rgSearch[4]?.trim();
        if (query) {
            return [{ label: 'Search', text: pathHint ? `${query} in ${pathHint}` : query }];
        }
    }

    const readTargets = extractReadTargetsFromShell(trimmed);
    if (readTargets.length > 0) {
        return [{ label: 'Read', text: readTargets.join(', ') }];
    }

    return [{ label: 'Run', text: trimmed }];
}

function stripShellWrapper(command: string): string {
    const zshMatch = command.match(/\/bin\/zsh\s+-lc\s+['"]([\s\S]*)['"]$/);
    if (zshMatch?.[1]) return zshMatch[1];
    const shMatch = command.match(/(?:^|\s)(?:zsh|bash|sh)\s+-lc\s+['"]([\s\S]*)['"]$/);
    if (shMatch?.[1]) return shMatch[1];
    return command;
}

function basenameLike(value: string): string {
    const cleaned = value.replace(/^['"]|['"]$/g, '').trim();
    const parts = cleaned.split('/');
    return parts[parts.length - 1] || cleaned;
}

function extractReadTargetsFromShell(script: string): string[] {
    const targets: string[] = [];
    const addTarget = (value: string) => {
        const cleaned = cleanShellPath(value);
        if (!cleaned || cleaned.startsWith('-')) return;
        targets.push(cleaned);
    };

    const sedReadPattern = /\bsed\s+-n\s+(?:"[^"]*"|'[^']*'|[^\s|&;]+)\s+(--\s+)?(?<path>"[^"]+"|'[^']+'|[^\s|&;]+)/g;
    for (const match of script.matchAll(sedReadPattern)) {
        const path = match.groups?.path;
        if (path) addTarget(path);
    }

    const catReadPattern = /\bcat\s+(?<args>[^|&;]+)/g;
    for (const match of script.matchAll(catReadPattern)) {
        const args = match.groups?.args ?? '';
        for (const token of splitShellWords(args)) {
            if (token.startsWith('-')) continue;
            addTarget(token);
        }
    }

    return Array.from(new Set(targets));
}

function splitShellWords(value: string): string[] {
    return [...value.matchAll(/"[^"]+"|'[^']+'|[^\s]+/g)].map((match) => match[0]);
}

function cleanShellPath(value: string): string {
    const cleaned = value.replace(/^['"]|['"]$/g, '').trim();
    const worktreeMatch = cleaned.match(/\/\.git\/agentree\/worktrees\/[^/]+\/(.+)$/);
    if (worktreeMatch?.[1]) return worktreeMatch[1];
    if (cleaned.includes('/.codex/') && cleaned.endsWith('/SKILL.md')) return 'SKILL.md';
    if (cleaned.startsWith('/')) return basenameLike(cleaned);
    return cleaned;
}
