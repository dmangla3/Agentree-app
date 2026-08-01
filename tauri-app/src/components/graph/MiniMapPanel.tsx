import { MiniMap, type MiniMapNodeProps, type Node, useReactFlow } from '@xyflow/react';
import { useCallback, useState } from 'react';
import { Eye, EyeOff, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useMinimapStore } from '../../stores/minimapStore';
import { LlmNodeData, extractColorFromClasses } from '../../lib/graphUtils';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// Get node color based on type and LLM
const getNodeColor = (node: Node<any>): string => {
    if (node.type === 'summary_block') {
        return '#fb923c'; // Orange for summaries
    }

    const data = node.data as (LlmNodeData & { scopeColor?: string | null; entity?: { scopeColor?: string | null } }) | undefined;
    const entityKind = data?.entity?.kind || node.type;

    // Ghost/insight nodes
    if (data?.isGhostBranch) {
        return '#a855f7'; // Purple for ghost branches
    }

    if (node.type === 'turn_group_hull') {
        return data?.scopeColor || data?.entity?.scopeColor || '#94a3b8';
    }

    if (node.type === 'external_commit_batch') {
        return '#f59e0b';
    }

    // Use LLM color if available
    if (data?.llmColor) {
        const extracted = extractColorFromClasses(data.llmColor);
        if (extracted) return extracted;
    }

    // Default colors by role
    if (entityKind === 'user_message' || data?.message?.role === 'user') {
        return '#93c5fd'; // Sky-300 for user messages
    }

    return '#3b82f6'; // Blue default for assistant
};

// Get node stroke color based on focus state
const getNodeStrokeColor = (node: Node<any>): string => {
    if (node.selected) return '#fff'; // White stroke for selected

    const data = node.data as (LlmNodeData & { scopeColor?: string | null; entity?: { scopeColor?: string | null } }) | undefined;
    if (data?.isFocused) return '#f59e0b'; // Amber for focused
    if (data?.isInFocusPath) return '#a3e635'; // Lime for focus path
    if (node.type === 'turn_group_hull') return data?.scopeColor || data?.entity?.scopeColor || '#94a3b8';

    return 'transparent';
};

// Custom minimap node component - renders rectangles
const MiniMapNode = ({ x, y, width, height, color, selected, strokeColor, strokeWidth }: MiniMapNodeProps) => {
    return (
        <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill={color}
            rx={2}
            ry={2}
            stroke={selected ? '#ffffff' : (strokeColor ?? 'none')}
            strokeWidth={selected ? 2 : (strokeWidth ?? 1)}
            className="transition-all duration-300"
        />
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

const MINIMAP_COLLAPSED_SIZE = { width: 240, height: 160 };
const MINIMAP_EXPANDED_SIZE = { width: 560, height: 380 };

export function MiniMapPanel() {
    const { isVisible, position, setVisible } = useMinimapStore();
    const [isExpanded, setIsExpanded] = useState(false);
    const { setCenter, getZoom } = useReactFlow();
    const minimapSize = isExpanded ? MINIMAP_EXPANDED_SIZE : MINIMAP_COLLAPSED_SIZE;
    const handleMinimapClick = useCallback(
        (_event: React.MouseEvent, viewportPosition: { x: number; y: number }) => {
            setCenter(viewportPosition.x, viewportPosition.y, {
                zoom: getZoom(),
                duration: 200,
            });
        },
        [getZoom, setCenter]
    );

    const positionClass = {
        'bottom-right': 'bottom-3 right-3',
        'bottom-left': 'bottom-3 left-3',
        'top-right': 'top-3 right-3',
        'top-left': 'top-3 left-3',
    }[position];

    const iconButtonBase = "group relative flex items-center justify-center rounded-lg transition-all duration-200 ease-out";
    const iconButtonGhost = "hover:bg-gradient-to-br hover:from-muted/80 hover:to-muted/40 hover:shadow-sm hover:shadow-black/5 active:scale-95";
    const iconContainer = "flex items-center justify-center transition-transform duration-200 group-hover:scale-110 group-active:scale-95";

    if (!isVisible) {
        return (
            <div className={cn("absolute z-40", positionClass)}>
                <button
                    type="button"
                    onClick={() => setVisible(true)}
                    className={cn(
                        iconButtonBase,
                        iconButtonGhost,
                        "h-8 w-8 rounded-md border border-border/50 bg-background/95 text-muted-foreground dark:border-slate-700/50 dark:bg-slate-900/95 dark:text-slate-400 hover:text-foreground dark:hover:text-slate-200"
                    )}
                    aria-label="Show minimap"
                    title="Show minimap"
                >
                    <span className={iconContainer}>
                        <Eye className="h-3.5 w-3.5" />
                    </span>
                </button>
            </div>
        );
    }

    return (
        <div className={cn("absolute z-40", positionClass)}>
            <div
                className={cn(
                    "transition-all duration-200 ease-out group",
                    "bg-card/95 border border-border/50 overflow-hidden",
                    "rounded-lg shadow-sm"
                )}
                style={{
                    width: minimapSize.width,
                    height: minimapSize.height,
                }}
                role="region"
                aria-label="Graph minimap"
            >
                <div className="absolute left-1 right-1 top-1 z-10 flex items-center justify-between gap-2">
                    <div className="pointer-events-none text-[10px] uppercase tracking-wide text-muted-foreground/80 bg-background/70 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                        Minimap
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onPointerDown={(event) => {
                                event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setIsExpanded((expanded) => !expanded);
                            }}
                            className={cn(
                                iconButtonBase,
                                iconButtonGhost,
                                "pointer-events-auto h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground bg-background/90 hover:text-foreground dark:text-slate-400 dark:hover:text-slate-200 transition-opacity"
                            )}
                            aria-label={isExpanded ? "Collapse minimap" : "Expand minimap"}
                            title={isExpanded ? "Collapse minimap" : "Expand minimap"}
                        >
                            <span className={iconContainer}>
                                {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                            </span>
                        </button>
                        <button
                            type="button"
                            onPointerDown={(event) => {
                                event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setVisible(false);
                            }}
                            className={cn(
                                iconButtonBase,
                                iconButtonGhost,
                                "pointer-events-auto h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground bg-background/90 hover:text-foreground dark:text-slate-400 dark:hover:text-slate-200 transition-opacity"
                            )}
                            aria-label="Hide minimap"
                            title="Hide minimap"
                        >
                            <span className={iconContainer}>
                                <EyeOff className="h-3 w-3" />
                            </span>
                        </button>
                    </div>
                </div>
                <div className="w-full h-full relative p-0 m-0">
                    <MiniMap
                        key={isExpanded ? 'expanded' : 'collapsed'}
                        nodeColor={getNodeColor}
                        nodeStrokeColor={getNodeStrokeColor}
                        nodeStrokeWidth={1.5}
                        nodeBorderRadius={3}
                        nodeComponent={MiniMapNode}
                        maskColor="rgba(0, 0, 0, 0.08)"
                        maskStrokeColor="rgba(59, 130, 246, 0.45)"
                        pannable={true}
                        zoomable={false}
                        onClick={handleMinimapClick}
                        ariaLabel="Graph minimap"
                        style={{
                            width: minimapSize.width,
                            height: minimapSize.height,
                        }}
                        className="!absolute !inset-0 !w-full !h-full !bg-transparent [&_.react-flow__minimap-edge]:hidden"
                    />
                </div>
            </div>
        </div>
    );
}
