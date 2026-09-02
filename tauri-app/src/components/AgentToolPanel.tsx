import { useState } from 'react';
import { cn } from '../lib/utils';
import {
    Sparkles,
    ChevronDown,
    ChevronRight,
    Search,
    Globe,
    GitBranch,
    FileText,
    MessageSquare,
    CheckCircle2,
    XCircle,
    Zap
} from 'lucide-react';
import { Badge } from '../../@/components/ui/badge';
import { Annotation } from '../stores/workspaceStore';

interface ToolCall {
    type: 'tool_call';
    name: string;
    args?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    result?: string;
    success?: boolean;
}

interface AgentToolPanelProps {
    annotations: Annotation[] | null | undefined;
    reasoning?: string | null;
    className?: string;
}

// Tool icons mapping
const toolIcons: Record<string, React.ElementType> = {
    search_kb: Search,
    web_search: Globe,
    get_graph: GitBranch,
    fetch_node: MessageSquare,
    read_file: FileText,
    python: FileText,
    file_search: Search,
    'container.exec': FileText,
};

// Tool display names
const toolDisplayNames: Record<string, string> = {
    search_kb: 'Knowledge Base Search',
    web_search: 'Web Search',
    get_graph: 'Graph Analysis',
    fetch_node: 'Fetch Message',
    read_file: 'Read File',
    python: 'Python Execution',
    file_search: 'File Search',
    'container.exec': 'Container Command',
};

function ToolCallCard({ toolCall, index }: { toolCall: ToolCall; index: number }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const Icon = toolIcons[toolCall.name] || Zap;
    const displayName = toolDisplayNames[toolCall.name] || toolCall.name;
    const isSuccess = toolCall.success !== false;

    // Format arguments nicely - support both 'args' and 'arguments'
    const argsObj = toolCall.args || toolCall.arguments || {};
    const formattedArgs = Object.entries(argsObj)
        .map(([key, value]) => ({
            key,
            value: typeof value === 'string' ? value : JSON.stringify(value)
        }));

    return (
        <div
            className={cn(
                "rounded-lg border transition-all duration-200",
                isSuccess
                    ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/50"
                    : "border-red-500/30 bg-red-500/5 hover:border-red-500/50"
            )}
        >
            {/* Header - Always visible */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center gap-2 p-2 text-left hover:bg-accent/30 rounded-lg transition-colors"
            >
                <div className={cn(
                    "flex-shrink-0 p-1.5 rounded-md",
                    isSuccess ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : "bg-red-500/20 text-red-600 dark:text-red-400"
                )}>
                    <Icon size={14} />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground truncate">
                            {displayName}
                        </span>
                        <Badge
                            variant="outline"
                            className={cn(
                                "text-[10px] px-1 py-0 h-4",
                                isSuccess ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-red-500/50 text-red-600 dark:text-red-400"
                            )}
                        >
                            {isSuccess ? <CheckCircle2 size={10} className="mr-0.5" /> : <XCircle size={10} className="mr-0.5" />}
                            {isSuccess ? 'Success' : 'Failed'}
                        </Badge>
                    </div>
                    {formattedArgs.length > 0 && (
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {formattedArgs.map(a => `${a.key}: "${a.value}"`).join(', ')}
                        </div>
                    )}
                </div>

                <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                    #{index + 1}
                </span>

                {isExpanded ? (
                    <ChevronDown size={14} className="text-muted-foreground flex-shrink-0" />
                ) : (
                    <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                )}
            </button>

            {/* Expanded Details */}
            {isExpanded && (
                <div className="px-3 pb-3 space-y-2 border-t border-border/30 mt-1">
                    {/* Arguments */}
                    {formattedArgs.length > 0 && (
                        <div className="mt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                                Arguments
                            </p>
                            <div className="bg-muted/40 rounded-md p-2 space-y-1">
                                {formattedArgs.map(({ key, value }) => (
                                    <div key={key} className="flex gap-2 text-xs">
                                        <span className="text-amber-600 dark:text-amber-400 font-medium flex-shrink-0">{key}:</span>
                                        <span className="text-foreground/80 break-all font-mono">{value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Result */}
                    {toolCall.result && (
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                                Result
                            </p>
                            <div className="max-h-60 overflow-y-auto rounded-md bg-muted/40 p-2">
                                <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed break-all">
                                    {toolCall.result}
                                </pre>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function AgentToolPanel({ annotations, reasoning, className }: AgentToolPanelProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    // Extract tool calls from annotations
    const toolCalls: ToolCall[] = ((annotations || []).filter(
        (ann) =>
            ann !== null &&
            typeof ann === 'object' &&
            'type' in ann &&
            ann.type === 'tool_call' &&
            'name' in ann
    ) as unknown) as ToolCall[];

    // Don't render if no tool activity
    if (toolCalls.length === 0 && !reasoning) {
        return null;
    }

    return (
        <div className={cn("mb-3", className)}>
            {/* Panel Header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                    "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-full transition-all duration-200",
                    "bg-background/80 backdrop-blur-xl border border-border/40 shadow-[0_1px_3px_rgba(0,0,0,0.04)]",
                    "hover:shadow-md hover:bg-background/90 ring-1 ring-white/10 dark:ring-white/5",
                    "group"
                )}
            >
                <div className="p-1 rounded-full bg-amber-500/15 shadow-sm border border-amber-500/20">
                    <Sparkles size={12} className="text-amber-600 dark:text-amber-500" />
                </div>

                <div className="flex-1 text-left flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-foreground/90 tracking-tight">
                        Agent Activity
                    </span>
                    {toolCalls.length > 0 && (
                        <Badge
                            variant="secondary"
                            className="text-[9px] px-1.5 py-0 h-4 bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 rounded-full font-mono"
                        >
                            {toolCalls.length}
                        </Badge>
                    )}
                    {!isExpanded && toolCalls.length > 0 && (
                        <div className="text-[10px] flex items-center gap-1 ml-1 opacity-70">
                            {toolCalls.slice(0, 3).map((tc, i) => {
                                const Icon = toolIcons[tc.name] || Zap;
                                return (
                                    <span key={i} className="flex items-center gap-0.5" title={toolDisplayNames[tc.name] || tc.name}>
                                        <Icon size={10} className="text-muted-foreground" />
                                    </span>
                                );
                            })}
                            {toolCalls.length > 3 && <span className="font-mono text-[9px] text-muted-foreground ml-0.5">+{toolCalls.length - 3}</span>}
                        </div>
                    )}
                </div>

                {isExpanded ? (
                    <ChevronDown size={14} className="text-amber-500/70" />
                ) : (
                    <ChevronRight size={14} className="text-amber-500/70" />
                )}
            </button>

            {/* Expanded Content */}
            {isExpanded && (
                <div className="mt-2 pl-2 border-l-2 border-amber-500/30 space-y-2 pr-2 max-h-[400px] overflow-y-auto">
                    {/* Tool calls only; reasoning is rendered by the surrounding assistant card. */}
                    {toolCalls.length > 0 && (
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                                <div className="p-1 rounded-md bg-emerald-500/20">
                                    <Zap size={12} className="text-emerald-500" />
                                </div>
                                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                    Tool Calls
                                </span>
                            </div>
                            <div className="space-y-1.5">
                                {toolCalls.map((tc, index) => (
                                    <ToolCallCard key={index} toolCall={tc} index={index} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
