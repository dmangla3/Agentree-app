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
            "overflow-hidden rounded-2xl border transition-all duration-200 shadow-[0_10px_30px_rgba(15,23,42,0.06)]",
            isActive
                ? "border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/15"
                : "border-border bg-muted/20 opacity-80 hover:opacity-100",
            className
        )}>
            <div className="border-b border-border/40 bg-gradient-to-r from-background via-background to-violet-50/60 px-4 py-3 dark:to-violet-950/20">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <div className={cn(
                                "rounded-xl border p-1.5 shadow-sm transition-colors",
                                isActive ? "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900 dark:bg-violet-900/50 dark:text-violet-300" : "border-border/60 bg-background text-muted-foreground"
                            )}>
                                <AlignLeft size={14} />
                            </div>
                            <span className="truncate text-sm font-semibold text-foreground">{summary.content.slice(0, 72) || 'Summary'}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="h-5 rounded-full border-violet-200/70 bg-violet-50/80 px-2 font-medium text-violet-700 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-300">
                                {ratio}% smaller
                            </Badge>
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 font-mono">
                                {tokenCountBefore} {'->'} {tokenCountAfter}
                            </span>
                            {bypassedNodeCount !== undefined && bypassedNodeCount > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 font-mono">
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
                            "h-8 shrink-0 rounded-full border border-border/60 bg-background px-3 text-xs shadow-sm transition-colors",
                            isActive ? "text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/30" : "text-muted-foreground hover:text-foreground"
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
