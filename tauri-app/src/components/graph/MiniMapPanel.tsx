import { type Node, type Viewport, useReactFlow, useStore } from '@xyflow/react';
import { useCallback, useMemo, useRef } from 'react';
import { Eye, EyeOff, LocateFixed, Maximize2, Minimize2 } from 'lucide-react';
import { shallow } from 'zustand/shallow';
import { cn } from '../../lib/utils';
import { type MinimapPosition, useMinimapStore } from '../../stores/minimapStore';
import { LlmNodeData, extractColorFromClasses } from '../../lib/graphUtils';
import { buildThreadBands, getThreadDividerRectsFromNodes } from '../../lib/graphThreadDividers';
import { buildGraphNodeBounds, clampPointToGraphBounds } from '../../lib/graphViewportBounds';

type MinimapNodeShape = {
    id: string;
    threadRootId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    strokeColor: string;
    strokeWidth: number;
};

type MinimapBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};

type MinimapModel = {
    shapes: MinimapNodeShape[];
    dividerRects: ReturnType<typeof getThreadDividerRectsFromNodes>;
    selectedCount: number;
    focusedCount: number;
};

type MiniMapPanelProps = {
    graphNodes?: Node<any>[];
    threadRootIdByMessageId?: Map<string, string>;
};

type BuildMinimapModelOptions = {
    graphNodes?: Node<any>[];
    mountedNodes?: Node<any>[];
    threadRootIdByMessageId?: Map<string, string>;
};

const MINIMAP_COLLAPSED_SIZE = { width: 240, height: 160 };
const MINIMAP_EXPANDED_SIZE = { width: 560, height: 380 };
const MINIMAP_CONTENT_PADDING = 96;
const MINIMAP_PAN_CLICK_DURATION = 180;
const MINIMAP_PAN_DRAG_DURATION = 0;
const MINIMAP_DRAG_THRESHOLD = 4;
const minimapLayerClass = "z-[30]";
const MINIMAP_POSITIONS: Array<{ value: MinimapPosition; label: string; className: string }> = [
    { value: 'top-left', label: 'Top left', className: 'left-0 top-0' },
    { value: 'top-right', label: 'Top right', className: 'right-0 top-0' },
    { value: 'bottom-left', label: 'Bottom left', className: 'bottom-0 left-0' },
    { value: 'bottom-right', label: 'Bottom right', className: 'bottom-0 right-0' },
];

const getNodeDimensions = (node: Node<any>) => ({
    width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
    height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0,
});

const readNumericPosition = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
};

const buildAbsolutePositionReader = (nodes: Node<any>[]) => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const cache = new Map<string, { x: number; y: number }>();

    const readPosition = (node: Node<any>, visitedNodeIds = new Set<string>()): { x: number; y: number } => {
        const cached = cache.get(node.id);
        if (cached) return cached;
        if (visitedNodeIds.has(node.id)) return {
            x: readNumericPosition(node.position?.x),
            y: readNumericPosition(node.position?.y),
        };
        visitedNodeIds.add(node.id);

        const ownPosition = {
            x: readNumericPosition(node.position?.x),
            y: readNumericPosition(node.position?.y),
        };
        const parent = node.parentId ? nodeById.get(node.parentId) : null;
        const position = parent
            ? {
                x: readPosition(parent, new Set(visitedNodeIds)).x + ownPosition.x,
                y: readPosition(parent, new Set(visitedNodeIds)).y + ownPosition.y,
            }
            : ownPosition;

        cache.set(node.id, position);
        return position;
    };

    return readPosition;
};

const shouldRenderNodeInMinimap = (node: Node<any>): boolean => {
    if (node.hidden) return false;
    return node.type !== 'summary_block' && node.type !== 'turn_group_hull';
};

const getNodeColor = (node: Node<any>): string => {
    const data = node.data as (LlmNodeData & { entity?: { kind?: string | null } }) | undefined;
    const entityKind = data?.entity?.kind || node.type;

    if (data?.isGhostBranch) return '#8b7cc7';
    if (data?.llmColor) {
        const extracted = extractColorFromClasses(data.llmColor);
        if (extracted) return extracted;
    }

    if (entityKind === 'user_message' || data?.message?.role === 'user') {
        return '#6f99d5';
    }

    if (node.type === 'commit') return '#5fa985';
    if (node.type === 'summary') return '#a887c7';

    return '#4f9bae';
};

const getNodeStrokeColor = (node: Node<any>): string => {
    if (node.selected) return '#f8fafc';

    const data = node.data as LlmNodeData | undefined;
    if (data?.isFocused) return '#f59e0b';
    if (data?.isInContextPath) return '#8fbf62';

    return 'transparent';
};

const getNodeThreadRootId = (node: Node<any>): string | null => {
    const data = node.data as any;
    return typeof data?.entity?.threadRootId === 'string' ? data.entity.threadRootId : null;
};

const toMinimapNodeShape = (node: Node<any>, absolutePosition: { x: number; y: number }): MinimapNodeShape | null => {
    const dimensions = getNodeDimensions(node);
    if (dimensions.width <= 0 || dimensions.height <= 0) return null;

    return {
        id: node.id,
        threadRootId: getNodeThreadRootId(node),
        x: absolutePosition.x,
        y: absolutePosition.y,
        width: dimensions.width,
        height: dimensions.height,
        color: getNodeColor(node),
        strokeColor: getNodeStrokeColor(node),
        strokeWidth: node.selected ? 2 : 1.5,
    };
};

export const buildMinimapModelFromGraphNodes = ({
    graphNodes,
    mountedNodes = [],
    threadRootIdByMessageId = new Map(),
}: BuildMinimapModelOptions): MinimapModel => {
    const sourceNodes = graphNodes ?? mountedNodes;
    const readAbsolutePosition = buildAbsolutePositionReader(sourceNodes);
    const nextShapes: MinimapNodeShape[] = [];
    const dividerNodes: Node<any>[] = [];
    let nextSelectedCount = 0;
    let nextFocusedCount = 0;

    sourceNodes.forEach((node) => {
        if (node.hidden) return;
        const data = node.data as (LlmNodeData & { isFocused?: boolean; isInContextPath?: boolean }) | undefined;
        if (node.selected) nextSelectedCount += 1;
        if (data?.isFocused || data?.isInContextPath) nextFocusedCount += 1;

        dividerNodes.push(node);
        if (!shouldRenderNodeInMinimap(node)) return;
        const shape = toMinimapNodeShape(node, readAbsolutePosition(node));
        if (shape) nextShapes.push(shape);
    });

    return {
        shapes: nextShapes,
        dividerRects: getThreadDividerRectsFromNodes(dividerNodes, threadRootIdByMessageId),
        selectedCount: nextSelectedCount,
        focusedCount: nextFocusedCount,
    };
};

const calculateNodeBounds = (shapes: MinimapNodeShape[]): MinimapBounds | null => {
    if (shapes.length === 0) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    shapes.forEach((shape) => {
        minX = Math.min(minX, shape.x);
        minY = Math.min(minY, shape.y);
        maxX = Math.max(maxX, shape.x + shape.width);
        maxY = Math.max(maxY, shape.y + shape.height);
    });

    return {
        x: minX - MINIMAP_CONTENT_PADDING,
        y: minY - MINIMAP_CONTENT_PADDING,
        width: Math.max(1, maxX - minX + MINIMAP_CONTENT_PADDING * 2),
        height: Math.max(1, maxY - minY + MINIMAP_CONTENT_PADDING * 2),
    };
};

const viewportToBounds = (viewport: Viewport, width: number, height: number): MinimapBounds => ({
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: width / viewport.zoom,
    height: height / viewport.zoom,
});

const fitBoundsToAspectRatio = (bounds: MinimapBounds, width: number, height: number): MinimapBounds => {
    const targetRatio = width / height;
    const currentRatio = bounds.width / bounds.height;

    if (currentRatio > targetRatio) {
        const nextHeight = bounds.width / targetRatio;
        return {
            ...bounds,
            y: bounds.y - (nextHeight - bounds.height) / 2,
            height: nextHeight,
        };
    }

    const nextWidth = bounds.height * targetRatio;
    return {
        ...bounds,
        x: bounds.x - (nextWidth - bounds.width) / 2,
        width: nextWidth,
    };
};

const mapToMinimap = (
    x: number,
    y: number,
    viewBox: MinimapBounds,
    minimapWidth: number,
    minimapHeight: number
) => ({
    x: ((x - viewBox.x) / viewBox.width) * minimapWidth,
    y: ((y - viewBox.y) / viewBox.height) * minimapHeight,
});

const mapFromMinimap = (
    x: number,
    y: number,
    viewBox: MinimapBounds,
    minimapWidth: number,
    minimapHeight: number
) => ({
    x: viewBox.x + (x / minimapWidth) * viewBox.width,
    y: viewBox.y + (y / minimapHeight) * viewBox.height,
});

export function MiniMapPanel({ graphNodes, threadRootIdByMessageId = new Map() }: MiniMapPanelProps) {
    const { isVisible, isExpanded, position, setExpanded, setPosition, setVisible } = useMinimapStore();
    const pointerStateRef = useRef<{ pointerId: number; x: number; y: number; dragged: boolean } | null>(null);
    const { setCenter, getZoom } = useReactFlow();
    const minimapSize = isExpanded ? MINIMAP_EXPANDED_SIZE : MINIMAP_COLLAPSED_SIZE;
    const { nodeLookup, nodes } = useStore((state) => ({
        nodeLookup: state.nodeLookup,
        nodes: state.nodes,
    }), shallow);
    const { viewport, flowWidth, flowHeight } = useStore((state) => ({
        viewport: {
            x: state.transform[0],
            y: state.transform[1],
            zoom: state.transform[2],
        } as Viewport,
        flowWidth: state.width,
        flowHeight: state.height,
    }), shallow);

    const mountedNodes = useMemo(() => {
        const nextNodes: Node<any>[] = [];
        nodeLookup.forEach((internalNode: any) => {
            const userNode = internalNode.internals?.userNode as Node<any> | undefined;
            if (!userNode || userNode.hidden) return;

            const positionAbsolute = internalNode.internals?.positionAbsolute ?? userNode.position;
            nextNodes.push({
                ...userNode,
                parentId: undefined,
                position: positionAbsolute,
            });
        });
        return nextNodes;
    }, [nodeLookup, nodes]);

    const { shapes, dividerRects, selectedCount, focusedCount } = useMemo(() => (
        buildMinimapModelFromGraphNodes({
            graphNodes,
            mountedNodes,
            threadRootIdByMessageId,
        })
    ), [graphNodes, mountedNodes, threadRootIdByMessageId]);
    const graphNodeBounds = useMemo(() => buildGraphNodeBounds(graphNodes ?? mountedNodes), [graphNodes, mountedNodes]);

    const zoomLabel = `${Math.round((viewport.zoom || 1) * 100)}%`;

    const viewBox = useMemo(() => {
        const nodeBounds = calculateNodeBounds(shapes);
        const viewportBounds = viewportToBounds(viewport, flowWidth || 1, flowHeight || 1);
        return fitBoundsToAspectRatio(nodeBounds ?? viewportBounds, minimapSize.width, minimapSize.height);
    }, [flowHeight, flowWidth, minimapSize.height, minimapSize.width, shapes, viewport]);

    const viewportRect = useMemo(() => {
        const bounds = viewportToBounds(viewport, flowWidth || 1, flowHeight || 1);
        const topLeft = mapToMinimap(bounds.x, bounds.y, viewBox, minimapSize.width, minimapSize.height);
        const bottomRight = mapToMinimap(bounds.x + bounds.width, bounds.y + bounds.height, viewBox, minimapSize.width, minimapSize.height);

        return {
            x: topLeft.x,
            y: topLeft.y,
            width: Math.max(1, bottomRight.x - topLeft.x),
            height: Math.max(1, bottomRight.y - topLeft.y),
        };
    }, [flowHeight, flowWidth, minimapSize.height, minimapSize.width, viewBox, viewport]);

    const threadBands = useMemo(() => {
        return buildThreadBands(dividerRects, { padding: 180, horizontalPadding: 56, equalVerticalExtent: true });
    }, [dividerRects]);

    const centerOnMinimapPoint = useCallback(
        (clientX: number, clientY: number, target: SVGSVGElement, duration: number) => {
            const rect = target.getBoundingClientRect();
            const point = mapFromMinimap(
                clientX - rect.left,
                clientY - rect.top,
                viewBox,
                minimapSize.width,
                minimapSize.height
            );

            const clampedPoint = clampPointToGraphBounds(point, graphNodeBounds);

            setCenter(clampedPoint.x, clampedPoint.y, {
                zoom: getZoom(),
                duration,
            });
        },
        [getZoom, graphNodeBounds, minimapSize.height, minimapSize.width, setCenter, viewBox]
    );

    const handleMinimapClick = useCallback(
        (event: React.MouseEvent<SVGSVGElement>) => {
            if (pointerStateRef.current?.dragged) {
                pointerStateRef.current = null;
                return;
            }

            centerOnMinimapPoint(event.clientX, event.clientY, event.currentTarget, MINIMAP_PAN_CLICK_DURATION);
            pointerStateRef.current = null;
        },
        [centerOnMinimapPoint]
    );

    const handleMinimapPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
        if (event.button !== 0) return;
        pointerStateRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            dragged: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }, []);

    const handleMinimapPointerMove = useCallback(
        (event: React.PointerEvent<SVGSVGElement>) => {
            const pointerState = pointerStateRef.current;
            if (!pointerState || pointerState.pointerId !== event.pointerId) return;

            const distance = Math.hypot(event.clientX - pointerState.x, event.clientY - pointerState.y);
            if (distance < MINIMAP_DRAG_THRESHOLD && !pointerState.dragged) return;

            pointerState.dragged = true;
            centerOnMinimapPoint(event.clientX, event.clientY, event.currentTarget, MINIMAP_PAN_DRAG_DURATION);
        },
        [centerOnMinimapPoint]
    );

    const handleMinimapPointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
        const pointerState = pointerStateRef.current;
        if (pointerState?.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (pointerState?.dragged) {
            window.setTimeout(() => {
                if (pointerStateRef.current === pointerState) {
                    pointerStateRef.current = null;
                }
            }, 0);
        }
    }, []);

    const handleRecentreCurrentViewport = useCallback(() => {
        const bounds = viewportToBounds(viewport, flowWidth || 1, flowHeight || 1);
        setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
            zoom: getZoom(),
            duration: MINIMAP_PAN_CLICK_DURATION,
        });
    }, [flowHeight, flowWidth, getZoom, setCenter, viewport]);

    const nodeSummary = useMemo(() => {
        const parts = [`${shapes.length} nodes`, zoomLabel];
        if (focusedCount > 0) parts.push(`${focusedCount} in context`);
        if (selectedCount > 0) parts.push(`${selectedCount} selected`);
        return parts.join(' · ');
    }, [focusedCount, selectedCount, shapes.length, zoomLabel]);

    const positionLabel = useMemo(
        () => MINIMAP_POSITIONS.find((item) => item.value === position)?.label ?? 'Bottom right',
        [position]
    );

    const positionClass = {
        'bottom-right': 'bottom-4 right-4',
        'bottom-left': 'bottom-4 left-4',
        'top-right': 'top-4 right-4',
        'top-left': 'top-4 left-4',
    }[position];

    const iconButtonBase = "app-focus-ring group relative flex items-center justify-center rounded-md transition-all duration-200 ease-out";
    const iconButtonGhost = "border border-transparent bg-background/65 text-muted-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.06)_inset] hover:border-border/75 hover:bg-muted/70 hover:text-foreground active:scale-95";
    const iconContainer = "flex items-center justify-center transition-transform duration-200 group-hover:scale-110 group-active:scale-95";

    if (!isVisible) {
        return (
            <div className={cn("absolute", minimapLayerClass, positionClass)}>
                <button
                    type="button"
                    onClick={() => setVisible(true)}
                    className={cn(
                        iconButtonBase,
                        iconButtonGhost,
                        "h-9 w-9 rounded-lg bg-background/90 shadow-[var(--app-shadow-soft)] backdrop-blur-xl"
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
        <div className={cn("absolute", minimapLayerClass, positionClass)}>
            <div
                className={cn(
                    "group isolate overflow-hidden rounded-xl border transition-all duration-300 ease-out",
                    "border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel)/0.82)] shadow-[var(--app-shadow-floating)] backdrop-blur-2xl",
                    "ring-1 ring-white/45 dark:ring-white/5"
                )}
                style={{
                    width: minimapSize.width,
                    height: minimapSize.height,
                }}
                role="region"
                aria-label={`Graph minimap, ${nodeSummary}, ${positionLabel}`}
            >
                <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_12%_18%,hsl(var(--app-accent)/0.16),transparent_36%),linear-gradient(145deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-panel)/0.74)_52%,hsl(var(--app-bg-muted)/0.88))]" />
                <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.38] [background-image:linear-gradient(hsl(var(--foreground)/0.055)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.055)_1px,transparent_1px)] [background-size:18px_18px]" />

                <div className="absolute left-2.5 right-2.5 top-2 z-10 flex items-start justify-between gap-3">
                    <div className="pointer-events-none min-w-0">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">
                            Graph map
                        </div>
                        <div className="mt-0.5 max-w-[11rem] truncate font-mono text-[10px] tabular-nums text-foreground/75">
                            {nodeSummary}
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                handleRecentreCurrentViewport();
                            }}
                            className={cn(
                                iconButtonBase,
                                iconButtonGhost,
                                "pointer-events-auto h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            )}
                            aria-label="Center minimap on current viewport"
                            title="Center minimap on current viewport"
                        >
                            <span className={iconContainer}>
                                <LocateFixed className="h-3.5 w-3.5" />
                            </span>
                        </button>
                        <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setExpanded(!isExpanded);
                            }}
                            className={cn(
                                iconButtonBase,
                                iconButtonGhost,
                                "pointer-events-auto h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setVisible(false);
                            }}
                            className={cn(
                                iconButtonBase,
                                iconButtonGhost,
                                "pointer-events-auto h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
                <svg
                    width={minimapSize.width}
                    height={minimapSize.height}
                    className="agentree-minimap relative z-[1] block h-full w-full cursor-crosshair touch-none"
                    role="img"
                    aria-label="Graph minimap. Click or drag to move the graph viewport."
                    onClick={handleMinimapClick}
                    onPointerDown={handleMinimapPointerDown}
                    onPointerMove={handleMinimapPointerMove}
                    onPointerUp={handleMinimapPointerUp}
                    onPointerCancel={handleMinimapPointerUp}
                >
                    <defs>
                        <filter id="agentree-minimap-node-shadow" x="-20%" y="-35%" width="140%" height="170%">
                            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="hsl(220 46% 14%)" floodOpacity="0.22" />
                        </filter>
                    </defs>
                    <rect width="100%" height="100%" fill="transparent" />
                    {threadBands.map((band) => {
                        const topLeft = mapToMinimap(band.left, band.top, viewBox, minimapSize.width, minimapSize.height);
                        const bottomRight = mapToMinimap(band.right, band.bottom, viewBox, minimapSize.width, minimapSize.height);
                        return (
                            <rect
                                key={band.id}
                                x={topLeft.x}
                                y={topLeft.y}
                                width={Math.max(1, bottomRight.x - topLeft.x)}
                                height={Math.max(1, bottomRight.y - topLeft.y)}
                                fill="hsl(var(--foreground) / 0.045)"
                                stroke="hsl(var(--foreground) / 0.12)"
                                strokeWidth={0.75}
                                rx={7}
                                ry={7}
                                pointerEvents="none"
                            />
                        );
                    })}
                    {shapes.map((shape) => {
                        const topLeft = mapToMinimap(shape.x, shape.y, viewBox, minimapSize.width, minimapSize.height);
                        const bottomRight = mapToMinimap(shape.x + shape.width, shape.y + shape.height, viewBox, minimapSize.width, minimapSize.height);
                        return (
                            <rect
                                key={shape.id}
                                x={topLeft.x}
                                y={topLeft.y}
                                width={Math.max(1, bottomRight.x - topLeft.x)}
                                height={Math.max(1, bottomRight.y - topLeft.y)}
                                fill={shape.color}
                                stroke={shape.strokeColor}
                                strokeWidth={shape.strokeWidth}
                                opacity={shape.strokeColor === 'transparent' ? 0.74 : 0.96}
                                filter={shape.strokeColor === 'transparent' ? undefined : 'url(#agentree-minimap-node-shadow)'}
                                rx={2.5}
                                ry={2.5}
                            />
                        );
                    })}
                    <rect
                        x={viewportRect.x}
                        y={viewportRect.y}
                        width={viewportRect.width}
                        height={viewportRect.height}
                        fill="hsl(var(--app-accent) / 0.12)"
                        stroke="hsl(var(--app-accent) / 0.78)"
                        strokeWidth={1.75}
                        rx={5}
                        ry={5}
                        pointerEvents="none"
                    />
                    <rect
                        x={viewportRect.x + 3}
                        y={viewportRect.y + 3}
                        width={Math.max(1, viewportRect.width - 6)}
                        height={Math.max(1, viewportRect.height - 6)}
                        fill="none"
                        stroke="hsl(var(--background) / 0.72)"
                        strokeWidth={0.75}
                        rx={3}
                        ry={3}
                        pointerEvents="none"
                    />
                </svg>
                <div className="absolute bottom-2.5 left-2.5 z-10 grid h-8 w-8 grid-cols-2 grid-rows-2 gap-0.5 rounded-md border border-[hsl(var(--app-border)/0.6)] bg-background/60 p-1 opacity-0 shadow-sm backdrop-blur-xl transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100" aria-label={`Minimap position: ${positionLabel}`}>
                    {MINIMAP_POSITIONS.map((item) => (
                        <button
                            key={item.value}
                            type="button"
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setPosition(item.value);
                            }}
                            className={cn(
                                "app-focus-ring relative rounded-[3px] transition-all duration-150 hover:bg-foreground/10",
                                position === item.value ? "bg-[hsl(var(--app-accent))] shadow-sm" : "bg-foreground/10"
                            )}
                            aria-label={`Move minimap to ${item.label}`}
                            title={`Move minimap to ${item.label}`}
                        >
                            <span className={cn("absolute h-1.5 w-1.5 rounded-[2px] bg-background/90", item.className)} />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
