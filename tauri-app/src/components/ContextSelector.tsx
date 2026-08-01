import { CheckCircle2, Circle, Minus } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../@/components/ui/popover';
import { cn } from '../lib/utils';

export type ContextMode = 'active' | 'none';

const formatTokens = (tokens: number) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return '~0';
    if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
    return `~${tokens}`;
};

interface ContextSelectorProps {
    contextMode: ContextMode;
    setContextMode: (mode: ContextMode) => void;
    disabled?: boolean;
    activeAncestorCount: number;
    totalAncestorCount: number;
    tokenEstimate: number;
    contextNodes?: Array<{
        id: string;
        role: 'user' | 'assistant' | 'system';
        label: string;
        active: boolean;
    }>;
    onToggleContextNode?: (nodeId: string, nextActive: boolean) => void;
    isUpdatingNodes?: boolean;
}

export function ContextSelector({
    contextMode,
    setContextMode,
    disabled,
    activeAncestorCount,
    totalAncestorCount,
    tokenEstimate,
    contextNodes = [],
    onToggleContextNode,
    isUpdatingNodes = false,
}: ContextSelectorProps) {
    const label = contextMode === 'active'
        ? `Active (${activeAncestorCount} of ${totalAncestorCount}, ${formatTokens(tokenEstimate)} tokens)`
        : 'None';

    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    className="text-xs"
                    title={contextMode === 'active'
                        ? `${activeAncestorCount} ancestor nodes will be included in context`
                        : 'No workspace context will be sent'}
                >
                    Context: {label}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-2">
                <Button
                    variant={contextMode === 'active' ? 'secondary' : 'ghost'}
                    className={cn('w-full justify-start gap-2')}
                    onClick={() => setContextMode('active')}
                >
                    <CheckCircle2 className="w-3 h-3 text-green-500" />
                    <span>Active</span>
                </Button>
                <Button
                    variant={contextMode === 'none' ? 'secondary' : 'ghost'}
                    className={cn('w-full justify-start gap-2')}
                    onClick={() => setContextMode('none')}
                >
                    <Minus className="w-3 h-3 text-amber-500" />
                    <span>None</span>
                </Button>
                {contextMode === 'active' && contextNodes.length > 0 && (
                    <div className="mt-2 border-t pt-2">
                        <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Branch ∩ Scope nodes
                        </div>
                        <div className="max-h-52 overflow-y-auto pr-1">
                            {contextNodes.map((node) => (
                                <button
                                    key={node.id}
                                    type="button"
                                    disabled={!onToggleContextNode || isUpdatingNodes}
                                    className={cn(
                                        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                                        'hover:bg-muted/60 disabled:opacity-60 disabled:cursor-not-allowed'
                                    )}
                                    onClick={() => onToggleContextNode?.(node.id, !node.active)}
                                >
                                    {node.active ? (
                                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                    ) : (
                                        <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                            {node.role}
                                        </div>
                                        <div className="truncate text-foreground">{node.label}</div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}
