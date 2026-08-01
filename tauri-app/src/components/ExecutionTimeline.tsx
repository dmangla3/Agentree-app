import { useEffect, useMemo, useState } from 'react';
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
  Clock
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";

export interface TimelineEvent {
    type: 'thinking' | 'tool_use' | 'tool_result' | 'message' | 'error';
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
                            "transition-all duration-200"
                        )}
                        aria-label="Toggle execution timeline"
                    >
                        <div className="flex items-center gap-3">
                            <div className={cn(
                                "p-1 rounded-md transition-all duration-200",
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
                                {rows.length} steps
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

type TimelineRow =
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
          kind: 'error';
          key?: string;
          content?: string;
      }
    | {
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
      }
    | {
          kind: 'exploration';
          key?: string;
          status: 'running' | 'completed' | 'error';
          durationMs?: number;
          items: CommandSummaryItem[];
          toolCalls: Array<{
              key: string;
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
                        "border border-blue-200 dark:border-blue-800",
                        "shadow-sm"
                    )}>
                        <Sparkles size={12} className="text-blue-600 dark:text-blue-400" />
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
                    <p className="text-[11px] font-semibold text-red-600 dark:text-red-400 mb-1 flex items-center gap-1.5">
                        Error
                    </p>
                    <p className="text-muted-foreground/80 text-[11px] leading-relaxed line-clamp-2">{row.content}</p>
                </div>
            </div>
        );
    }

    if (row.kind === 'exploration') {
        const isRunning = row.status === 'running';
        const isError = row.status === 'error';
        const title = isRunning ? 'Exploring' : 'Explored';
        return (
            <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
                <div className="flex flex-col items-center">
                    <div className={cn(
                        "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                        "border shadow-sm transition-all duration-200",
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
                            "transition-all duration-200"
                        )}
                        onClick={() => setIsDetailsOpen(v => !v)}
                        aria-expanded={isDetailsOpen}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="text-[11px] font-semibold text-foreground/85">{title}</div>
                                <div className="mt-1 space-y-1">
                                    {row.items.map((item, index) => (
                                        <div key={`${item.label}_${item.text}_${index}`} className="flex min-w-0 items-start gap-2 text-[11px]">
                                            <span className="shrink-0 rounded-md border border-amber-200/70 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                                                {item.label}
                                            </span>
                                            <span className="min-w-0 break-words text-muted-foreground/85">{item.text}</span>
                                        </div>
                                    ))}
                                </div>
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
                                            Command {index + 1}
                                        </span>
                                        {call.durationMs ? (
                                            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                                                {formatDuration(call.durationMs)}
                                            </span>
                                        ) : null}
                                    </div>
                                    {call.toolInput !== undefined ? (
                                        <pre className="max-h-32 overflow-x-auto rounded-md bg-muted/40 p-2 text-[10px] text-muted-foreground/80">
                                            {formatToolPayload(call.toolInput)}
                                        </pre>
                                    ) : null}
                                </div>
                            ))}
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            </div>
        );
    }

    const summary = getToolSummary(row.toolName, row.toolInput);
    const status = row.isError ? 'error' : row.toolOutput ? 'completed' : 'running';

    return (
        <div className="flex gap-3 group/item" onClick={stopCardFocus} onMouseDown={stopCardFocus}>
            <div className="flex flex-col items-center">
                <div className={cn(
                    "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
                    "border shadow-sm transition-all duration-200",
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
                        "transition-all duration-200"
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
                        {row.toolInput !== undefined && (
                            <div className="text-[10px]">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <div className="w-1 h-1 rounded-full bg-blue-400" />
                                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Input</span>
                                </div>
                                <pre className={cn(
                                    "text-[10px] bg-muted/40 p-2.5 rounded-lg border overflow-x-auto font-mono",
                                    "text-muted-foreground/80 max-h-32"
                                )}>
                                    {formatToolPayload(row.toolInput)}
                                </pre>
                            </div>
                        )}
                        {row.toolOutput !== undefined && (
                            <div className="text-[10px]">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <div className="w-1 h-1 rounded-full bg-emerald-400" />
                                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">Output</span>
                                </div>
                                <pre className={cn(
                                    "text-[10px] bg-muted/40 p-2.5 rounded-lg border overflow-x-auto font-mono",
                                    "text-muted-foreground/80 max-h-32"
                                )}>
                                    {formatToolPayload(row.toolOutput)}
                                </pre>
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

export type { TimelineRow };

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
            const lastRow = rows[rows.length - 1];
            if (lastRow?.kind === 'message') {
                lastRow.content = `${lastRow.content || ''}${content}`;
            } else {
                rows.push({
                    kind: 'message',
                    key: buildRowKey('message', event),
                    content,
                });
            }
            continue;
        }

        if (event.type === 'thinking') {
            rows.push({
                kind: 'thinking',
                key: buildRowKey('thinking', event),
                content: event.content,
                durationMs: event.durationMs,
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
            const toolRow: TimelineRow = {
                kind: 'tool',
                key: buildRowKey(toolName || 'tool', event),
                toolName: toolName || 'tool',
                toolInput: extractToolInput(event),
                durationMs: event.durationMs ?? event.duration_ms,
                startedAtMs: getTimestampMs(event.timestamp),
            };
            const rowIndex = rows.push(toolRow) - 1;
            const toolUseId = extractToolUseId(event);
            if (toolUseId) toolRowById.set(toolUseId, rowIndex);
            lastOpenToolIndex = rowIndex;
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

    return coalesceExplorationRows(rows);
}

function extractToolUseId(event: TimelineEvent): string | undefined {
    return event.toolUseId || event.tool_use_id || (event.id ? String(event.id) : undefined);
}

function extractToolName(event: TimelineEvent): string | undefined {
    return event.toolName || event.tool || (event as any).tool_name || (event as any).name;
}

function extractToolInput(event: TimelineEvent): any {
    if (event.toolInput !== undefined) return event.toolInput;
    if (event.input !== undefined) return event.input;
    return (event as any).tool_input ?? (event as any).parameters ?? undefined;
}

function extractToolOutput(event: TimelineEvent): any {
    if (event.toolOutput !== undefined) return event.toolOutput;
    if (event.output !== undefined) return event.output;
    return (event as any).tool_output ?? (event as any).result ?? undefined;
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
    if (payload === null || payload === undefined) return '';
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload, null, 2);
    } catch {
        return String(payload);
    }
}

export function getToolSummary(toolName: string, toolInput: any): string {
    if (!toolInput) return '';
    const name = toolName?.toLowerCase?.() ?? '';

    if (typeof toolInput === 'string') return toolInput;
    if (name === 'commandexecution') {
        const items = getCommandExecutionSummaryItems(toolInput);
        if (items.length > 0) return summarizeCommandItems(items);
    }
    if (name === 'bash' && typeof toolInput.command === 'string') return toolInput.command;
    if (name === 'glob' && typeof toolInput.pattern === 'string') return toolInput.pattern;
    if (name === 'grep' && typeof toolInput.pattern === 'string') {
        return toolInput.path ? `${toolInput.pattern} in ${toolInput.path}` : toolInput.pattern;
    }
    if (name === 'read' && typeof toolInput.path === 'string') return toolInput.path;
    if (name === 'write' && typeof toolInput.path === 'string') return toolInput.path;
    if (name === 'edit' && typeof toolInput.file_path === 'string') return toolInput.file_path;
    if (name === 'apply_patch' && typeof toolInput.path === 'string') return toolInput.path;
    if (name === 'webfetch' && typeof toolInput.url === 'string') return toolInput.url;
    if (name === 'codesearch' && typeof toolInput.query === 'string') return toolInput.query;
    if (name === 'task' && typeof toolInput.description === 'string') return toolInput.description;

    const knownKey = toolInput.file_path || toolInput.path || toolInput.query || toolInput.url || toolInput.pattern;
    if (typeof knownKey === 'string') return knownKey;

    try {
        return JSON.stringify(toolInput);
    } catch {
        return String(toolInput);
    }
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
        : rows.some((row) => row.toolOutput === undefined)
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
            toolInput: row.toolInput,
            toolOutput: row.toolOutput,
            durationMs: row.durationMs,
            isError: row.isError,
            commandActions: row.commandActions,
        })),
    };
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
        const scope = rgFiles[1]?.trim();
        return [{ label: 'List', text: scope && scope.length > 0 ? scope : 'files' }];
    }

    const rgSearch = trimmed.match(/\brg\b(?:[^'"]|\s|'[^']*'|"[^"]*")*?\s(?:-n\s+)?(?:"([^"]+)"|'([^']+)'|([^\s\|]+))(?:\s+([^\|\&;]+))?/);
    if (rgSearch) {
        const query = rgSearch[1] || rgSearch[2] || rgSearch[3];
        const scope = rgSearch[4]?.trim();
        if (query) {
            return [{ label: 'Search', text: scope ? `${query} in ${scope}` : query }];
        }
    }

    const sedRead = trimmed.match(/\bsed\s+-n\s+'[^']*p'\s+([^\|\&;]+)/);
    if (sedRead?.[1]) {
        return [{ label: 'Read', text: basenameLike(sedRead[1].trim()) }];
    }

    const catRead = trimmed.match(/\bcat\s+([^\|\&;]+)/);
    if (catRead?.[1]) {
        return [{ label: 'Read', text: basenameLike(catRead[1].trim()) }];
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
