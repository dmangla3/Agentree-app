import { cn } from '../lib/utils';
import { Summary } from '../stores/workspaceStore';
import { AlignLeft, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Badge } from '../../@/components/ui/badge';

interface SummaryCardProps {
    summary: Summary;
    isActive: boolean;
    onToggle: (summaryId: string) => void;
    className?: string;
    bypassedNodeCount?: number; // Added prop
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
    summary,
    isActive,
    onToggle,
    className,
    bypassedNodeCount
}) => {
    const tokenCountBefore = summary.tokenCountBefore || 0;
    const tokenCountAfter = summary.tokenCountAfter || 0;
    const ratio = tokenCountBefore > 0 ? Math.round((1 - tokenCountAfter / tokenCountBefore) * 100) : 0;

    return (
        <div className={cn(
            "overflow-hidden rounded-xl border shadow-[0_14px_32px_-28px_hsl(var(--foreground)/0.34)] transition-[background-color,border-color,box-shadow,opacity] duration-normal ease-out-cubic motion-reduce:transition-none",
            isActive
                ? "border-[hsl(var(--app-accent)/0.28)] bg-[hsl(var(--app-panel)/0.96)]"
                : "border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-bg-muted)/0.36)] opacity-75 hover:opacity-100",
            className
        )}>
            <div className="border-b border-[hsl(var(--app-border)/0.48)] bg-[hsl(var(--app-bg-muted)/0.28)] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <div className={cn(
                                "rounded-lg p-1.5 transition-colors",
                                isActive ? "bg-[hsl(var(--app-accent-soft)/0.72)] text-[hsl(var(--app-accent))]" : "bg-[hsl(var(--app-panel-strong)/0.62)] text-muted-foreground"
                            )}>
                                <AlignLeft size={14} />
                            </div>
                            <span className="truncate text-sm font-semibold text-foreground">{summary.content.slice(0, 72) || 'Summary'}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="h-5 rounded-full border-[hsl(var(--app-accent)/0.24)] bg-[hsl(var(--app-accent-soft)/0.62)] px-2 font-medium text-[hsl(var(--app-accent))]">
                                {ratio}% smaller
                            </Badge>
                            <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--app-panel-strong)/0.58)] px-2 py-0.5 font-mono tabular-nums">
                                {tokenCountBefore} {'->'} {tokenCountAfter}
                            </span>
                            {bypassedNodeCount !== undefined && bypassedNodeCount > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--app-panel-strong)/0.58)] px-2 py-0.5 font-mono tabular-nums">
                                    <Layers size={9} />
                                    {bypassedNodeCount}
                                </span>
                            )}
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onToggle(summary.id)}
                        className={cn(
                            "h-10 shrink-0 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.8)] px-3 text-xs transition-[background-color,color,transform] duration-normal ease-out-cubic active:scale-[0.96] motion-reduce:transition-none",
                            isActive ? "text-[hsl(var(--app-accent))] hover:bg-[hsl(var(--app-accent-soft)/0.46)]" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {isActive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>{isActive ? 'Expand' : 'Collapse'}</span>
                    </Button>
                </div>
            </div>

            <div className="px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                {summary.content}
            </div>
        </div>
    );
};
