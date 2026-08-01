import { cn } from '../../lib/utils';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface LegendItem {
    name: string;
    color: string;
}

export interface GraphLegendProps {
    legendData: LegendItem[];
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function GraphLegend({ legendData }: GraphLegendProps) {
    if (legendData.length === 0) return null;

    return (
        <div className="absolute bottom-44 right-2 z-10 bg-white/95 dark:bg-gray-900/95 p-3 rounded-lg shadow-sm text-xs text-foreground border border-border/50 dark:border-border/30 max-h-[150px] overflow-y-auto custom-scrollbar">
            <p className="font-semibold mb-2 text-muted-foreground dark:text-muted-foreground/90">LLM Legend:</p>
            <div className="flex flex-col space-y-1.5">
                {legendData.map((item, index) => (
                    <div key={index} className="flex items-center gap-2">
                        <span
                            className={cn(
                                "w-3 h-3 rounded-sm inline-block flex-shrink-0 shadow-sm",
                                item.color
                            )}
                        />
                        <span className="truncate max-w-[150px] text-foreground/90 dark:text-foreground/95">
                            {item.name}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
