import { useMemo, useState, useCallback } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../../../@/components/ui/button';
import { Badge } from '../../../@/components/ui/badge';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '../../../@/components/ui/hover-card';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { BlameEntry, BlameResult, BlameContextResponse, ToolCallMatch } from '../../lib/agentClient';
import { User, GitBranch, AlertTriangle, Eye, Copy, Check, ExternalLink, Settings2 } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface BlameViewerProps {
    blameResult: BlameResult;
    blameContext?: BlameContextResponse | null;
    onNodeClick?: (nodeId: string) => void;
    className?: string;
    maxHeight?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// COLOR PALETTE
// ═══════════════════════════════════════════════════════════════════════════

const nodeColorPalette = [
    { bg: 'bg-[hsl(var(--app-graph-agent)/0.08)]', border: 'border-[hsl(var(--app-graph-agent)/0.22)]', text: 'text-[hsl(var(--app-graph-agent))]', hover: 'hover:bg-[hsl(var(--app-graph-agent)/0.12)]' },
    { bg: 'bg-emerald-50 dark:bg-emerald-950/40', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-700 dark:text-emerald-300', hover: 'hover:bg-emerald-100 dark:hover:bg-emerald-900/50' },
    { bg: 'bg-violet-50 dark:bg-violet-950/40', border: 'border-violet-200 dark:border-violet-800', text: 'text-violet-700 dark:text-violet-300', hover: 'hover:bg-violet-100 dark:hover:bg-violet-900/50' },
    { bg: 'bg-amber-50 dark:bg-amber-950/40', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300', hover: 'hover:bg-amber-100 dark:hover:bg-amber-900/50' },
    { bg: 'bg-rose-50 dark:bg-rose-950/40', border: 'border-rose-200 dark:border-rose-800', text: 'text-rose-700 dark:text-rose-300', hover: 'hover:bg-rose-100 dark:hover:bg-rose-900/50' },
    { bg: 'bg-zinc-50 dark:bg-zinc-900/50', border: 'border-zinc-200 dark:border-zinc-700', text: 'text-zinc-700 dark:text-zinc-300', hover: 'hover:bg-zinc-100 dark:hover:bg-zinc-800/70' },
    { bg: 'bg-orange-50 dark:bg-orange-950/40', border: 'border-orange-200 dark:border-orange-800', text: 'text-orange-700 dark:text-orange-300', hover: 'hover:bg-orange-100 dark:hover:bg-orange-900/50' },
    { bg: 'bg-pink-50 dark:bg-pink-950/40', border: 'border-pink-200 dark:border-pink-800', text: 'text-pink-700 dark:text-pink-300', hover: 'hover:bg-pink-100 dark:hover:bg-pink-900/50' },
];

const baseColor = {
    bg: 'bg-slate-50 dark:bg-slate-950/40',
    border: 'border-slate-200 dark:border-slate-800',
    text: 'text-slate-600 dark:text-slate-400',
    hover: 'hover:bg-slate-100 dark:hover:bg-slate-900/50',
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function BlameViewer({
    blameResult,
    blameContext,
    onNodeClick,
    className,
    maxHeight = '600px'
}: BlameViewerProps) {
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Build color map for unique node IDs
    const nodeColorMap = useMemo(() => {
        const uniqueNodes = [...new Set(blameResult.entries.map(e => e.author_node_id))];
        const map = new Map<string, typeof nodeColorPalette[0]>();

        let colorIndex = 0;
        uniqueNodes.forEach(nodeId => {
            if (nodeId === 'base') {
                map.set(nodeId, baseColor);
            } else {
                map.set(nodeId, nodeColorPalette[colorIndex % nodeColorPalette.length]);
                colorIndex++;
            }
        });
        return map;
    }, [blameResult.entries]);

    // Calculate stats
    const stats = useMemo(() => {
        const contributors = new Set(blameResult.entries.map(e => e.author_node_id));
        const baseLines = blameResult.entries
            .filter(e => e.is_base)
            .reduce((sum, e) => sum + (e.line_end - e.line_start + 1), 0);
        const modifiedLines = blameResult.total_lines - baseLines;

        return {
            contributors: contributors.size,
            baseLines,
            modifiedLines,
            modifiedPercent: Math.round((modifiedLines / blameResult.total_lines) * 100) || 0
        };
    }, [blameResult]);

    const handleCopyId = useCallback(async (nodeId: string) => {
        try {
            await navigator.clipboard.writeText(nodeId);
            setCopiedId(nodeId);
            setTimeout(() => setCopiedId(null), 1500);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, []);

    // Empty/error states
    if (!blameResult.file_exists) {
        return (
            <div className={cn(
                "flex flex-col items-center justify-center p-6 text-muted-foreground",
                "rounded-lg border border-dashed border-[hsl(var(--app-border)/0.58)] bg-muted/20",
                className
            )}>
                <AlertTriangle className="mb-2 h-5 w-5 text-[hsl(var(--app-warning))]" />
                <span className="text-sm font-medium">File does not exist at this node</span>
                <span className="text-xs mt-1">The file may have been deleted or not yet created</span>
            </div>
        );
    }

    if (blameResult.is_binary) {
        return (
            <div className={cn(
                "flex flex-col items-center justify-center p-6 text-muted-foreground",
                "rounded-lg border border-dashed border-[hsl(var(--app-border)/0.58)] bg-muted/20",
                className
            )}>
                <span className="text-sm">Binary file - blame not available</span>
            </div>
        );
    }

    return (
        <div data-design-scope="panels" className={cn("flex flex-col", className)}>
            {/* Header with stats and legend */}
            <div className="flex flex-col gap-2 border-b border-border/50 bg-muted/25 px-3 py-2">
                {/* Stats row */}
                <div className="flex items-center gap-4 text-xs">
                    <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">Lines:</span>
                        <span className="font-mono font-medium tabular-nums">{blameResult.total_lines}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">Contributors:</span>
                        <span className="font-mono font-medium tabular-nums">{stats.contributors}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">Modified:</span>
                        <span className="font-mono font-medium tabular-nums">{stats.modifiedPercent}%</span>
                        <span className="text-muted-foreground/60">({stats.modifiedLines} lines)</span>
                    </div>
                </div>

                {/* Legend */}
                <div className="flex flex-wrap gap-1.5">
                    {[...nodeColorMap.entries()].map(([nodeId, colors]) => (
                        <Badge
                            key={nodeId}
                            variant="outline"
                            className={cn(
                                "min-h-10 cursor-pointer rounded-full px-2.5 py-0.5 text-[10px] transition-[background-color,border-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.96]",
                                colors.bg,
                                colors.border,
                                colors.text,
                                colors.hover,
                                hoveredNode === nodeId && "ring-2 ring-primary/50"
                            )}
                            onClick={() => onNodeClick?.(nodeId)}
                            onMouseEnter={() => setHoveredNode(nodeId)}
                            onMouseLeave={() => setHoveredNode(null)}
                        >
                            {nodeId === 'base' ? (
                                <>
                                    <GitBranch className="h-3 w-3 mr-1" />
                                    Base
                                </>
                            ) : (
                                <>
                                    <User className="h-3 w-3 mr-1" />
                                    {nodeId.slice(0, 8)}
                                </>
                            )}
                        </Badge>
                    ))}
                </div>

                {/* Warnings */}
                {blameResult.warnings.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {blameResult.warnings.map((warning, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-2 text-[10px] text-amber-600 dark:text-amber-400"
                            >
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                <span>{warning}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Blame content */}
            <ScrollArea className="flex-1" style={{ maxHeight }}>
                <div className="font-mono text-sm">
                    {blameResult.entries.map((entry, idx) => (
                        <BlameLineGroup
                            key={idx}
                            entry={entry}
                            colors={nodeColorMap.get(entry.author_node_id) || baseColor}
                            isHovered={hoveredNode === entry.author_node_id}
                            toolCall={blameContext?.tool_call}
                            toolCallMatchType={blameContext?.tool_call_match_type}
                            contextWarnings={blameContext?.warnings}
                            copiedId={copiedId}
                            onHover={() => setHoveredNode(entry.author_node_id)}
                            onLeave={() => setHoveredNode(null)}
                            onNodeClick={onNodeClick}
                            onCopyId={handleCopyId}
                        />
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL CALL INFO
// ═══════════════════════════════════════════════════════════════════════════

interface ToolCallInfoProps {
    toolCall?: ToolCallMatch | null;
    matchType?: string;
    warnings?: string[];
}

function ToolCallInfo({ toolCall, matchType, warnings }: ToolCallInfoProps) {
    // Style variations based on match type
    const getMatchStyles = () => {
        switch (matchType) {
            case 'exact':
                return {
                    bg: 'bg-green-50 dark:bg-green-900/20',
                    border: 'border-green-200/50 dark:border-green-800/50',
                    header: 'text-green-700 dark:text-green-300',
                    body: 'text-green-800 dark:text-green-200',
                    label: 'Exact Match',
                };
            case 'heuristic':
                return {
                    bg: 'bg-amber-50 dark:bg-amber-900/20',
                    border: 'border-amber-200/50 dark:border-amber-800/50',
                    header: 'text-amber-700 dark:text-amber-300',
                    body: 'text-amber-800 dark:text-amber-200',
                    label: 'Heuristic Match',
                };
            case 'fallback':
                return {
                    bg: 'bg-orange-50 dark:bg-orange-900/20',
                    border: 'border-orange-200/50 dark:border-orange-800/50',
                    header: 'text-orange-700 dark:text-orange-300',
                    body: 'text-orange-800 dark:text-orange-200',
                    label: 'Fallback (may not match)',
                };
            case 'none':
            default:
                return {
                    bg: 'bg-slate-50 dark:bg-slate-800/30',
                    border: 'border-slate-200/50 dark:border-slate-700/50',
                    header: 'text-slate-500 dark:text-slate-400',
                    body: 'text-slate-600 dark:text-slate-300',
                    label: 'No tool call found',
                };
        }
    };

    const styles = getMatchStyles();

    if (!toolCall) {
        return (
            <div className={cn("rounded-lg border p-2", styles.bg, styles.border)}>
                <div className={cn("flex items-center gap-1.5 text-[10px] font-medium", styles.header)}>
                    <AlertTriangle className="h-3 w-3" />
                    {styles.label}
                </div>
                <div className={cn("text-xs mt-1", styles.body)}>
                    Could not identify which tool call modified this file.
                    The change may have been made via Bash or an untracked operation.
                </div>
                {warnings && warnings.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-200/50 dark:border-slate-700/50">
                        {warnings.map((warning, i) => (
                            <div key={i} className="text-[10px] text-slate-500 dark:text-slate-400">
                                {warning}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    const filePath = (() => {
        if (!toolCall?.toolInput || typeof toolCall.toolInput !== 'object') return undefined;
        const input = toolCall.toolInput as { file_path?: unknown };
        return typeof input.file_path === 'string' ? input.file_path : undefined;
    })();

    return (
        <div className={cn("rounded-lg border p-2", styles.bg, styles.border)}>
            <div className={cn("flex items-center gap-1.5 text-[10px] font-medium mb-1", styles.header)}>
                <Settings2 className="h-3 w-3" />
                Tool Call ({styles.label})
            </div>
            <div className={cn("text-xs font-mono", styles.body)}>
                {toolCall.toolName}
            </div>
            {filePath && (
                <div className={cn("text-[10px] mt-1 truncate", styles.body, "opacity-70")}>
                    {filePath}
                </div>
            )}
            {warnings && warnings.length > 0 && (
                <div className={cn("mt-2 pt-2 border-t", styles.border)}>
                    {warnings.map((warning, i) => (
                        <div key={i} className={cn("text-[10px]", styles.header)}>
                            {warning}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// BLAME LINE GROUP
// ═══════════════════════════════════════════════════════════════════════════

interface BlameLineGroupProps {
    entry: BlameEntry;
    colors: typeof nodeColorPalette[0];
    isHovered: boolean;
    toolCall?: ToolCallMatch | null;
    toolCallMatchType?: string;
    contextWarnings?: string[];
    copiedId: string | null;
    onHover: () => void;
    onLeave: () => void;
    onNodeClick?: (nodeId: string) => void;
    onCopyId: (nodeId: string) => void;
}

function BlameLineGroup({
    entry,
    colors,
    isHovered,
    toolCall,
    toolCallMatchType,
    contextWarnings,
    copiedId,
    onHover,
    onLeave,
    onNodeClick,
    onCopyId
}: BlameLineGroupProps) {
    const lines = entry.content.split('\n');
    const lineCount = entry.line_end - entry.line_start + 1;

    return (
        <HoverCard openDelay={500} closeDelay={100}>
            <HoverCardTrigger asChild>
                <div
                    className={cn(
                        "group flex border-b border-border/20 transition-colors duration-150 ease-out",
                        isHovered && "bg-accent/30"
                    )}
                    onMouseEnter={onHover}
                    onMouseLeave={onLeave}
                >
                    {/* Blame gutter */}
                    <div
                        className={cn(
                            "w-28 shrink-0 cursor-pointer border-r px-2 py-0.5 text-[10px] transition-colors duration-150 ease-out",
                            colors.bg,
                            colors.border,
                            colors.text,
                            colors.hover
                        )}
                        onClick={() => onNodeClick?.(entry.author_node_id)}
                    >
                        <div className="flex items-center gap-1.5">
                            {entry.is_base ? (
                                <GitBranch className="h-3 w-3 shrink-0" />
                            ) : (
                                <User className="h-3 w-3 shrink-0" />
                            )}
                            <span className="truncate font-medium">
                                {entry.is_base ? 'base' : entry.author_node_id.slice(0, 8)}
                            </span>
                        </div>
                    </div>

                    {/* Line numbers */}
                    <div className="w-12 shrink-0 text-right pr-2 text-muted-foreground/60 select-none border-r border-border/30 bg-muted/20">
                        {lines.map((_, i) => (
                            <div key={i} className="leading-5 text-[11px]">
                                {entry.line_start + i}
                            </div>
                        ))}
                    </div>

                    {/* Code content */}
                    <div className="flex-1 overflow-x-auto">
                        <pre className="px-3">
                            {lines.map((line, i) => (
                                <div key={i} className="leading-5 whitespace-pre">
                                    {line || ' '}
                                </div>
                            ))}
                        </pre>
                    </div>
                </div>
            </HoverCardTrigger>

            <HoverCardContent
                className="w-80 p-0 overflow-hidden"
                side="right"
                align="start"
            >
                <div className="p-3 space-y-3">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                            {entry.is_base ? (
                                <div className={cn("rounded-lg p-1.5", baseColor.bg)}>
                                    <GitBranch className={cn("h-4 w-4", baseColor.text)} />
                                </div>
                            ) : (
                                <div className={cn("rounded-lg p-1.5", colors.bg)}>
                                    <User className={cn("h-4 w-4", colors.text)} />
                                </div>
                            )}
                            <div>
                                <div className="font-medium text-sm">
                                    {entry.is_base ? 'Base Commit' : 'Node'}
                                </div>
                                {!entry.is_base && (
                                    <div className="text-[10px] text-muted-foreground font-mono">
                                        {entry.author_node_id.slice(0, 16)}...
                                    </div>
                                )}
                            </div>
                        </div>
                        {!entry.is_base && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 rounded-lg"
                                onClick={() => onCopyId(entry.author_node_id)}
                            >
                                {copiedId === entry.author_node_id ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                ) : (
                                    <Copy className="h-3 w-3" />
                                )}
                            </Button>
                        )}
                    </div>

                    {/* Line info */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>Lines {entry.line_start}-{entry.line_end}</span>
                        <span className="text-muted-foreground/50">|</span>
                        <span>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
                    </div>

                    {/* Tool call info */}
                    {!entry.is_base && (
                        <ToolCallInfo
                            toolCall={toolCall}
                            matchType={toolCallMatchType}
                            warnings={contextWarnings}
                        />
                    )}

                    {/* Actions */}
                    {!entry.is_base && (
                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-10 flex-1 rounded-lg text-xs"
                                onClick={() => onNodeClick?.(entry.author_node_id)}
                            >
                                <Eye className="h-3 w-3 mr-1.5" />
                                View in Graph
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-10 w-10 rounded-lg px-0 text-xs"
                                onClick={() => onCopyId(entry.author_node_id)}
                            >
                                <ExternalLink className="h-3 w-3" />
                            </Button>
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}

export default BlameViewer;
