import type { CoordinateExtent, Node, Viewport } from '@xyflow/react';

export const GRAPH_VIEWPORT_FALLBACK_NODE_WIDTH = 120;
export const GRAPH_VIEWPORT_FALLBACK_NODE_HEIGHT = 120;
export const GRAPH_VIEWPORT_NODE_BOUNDS_PADDING = 320;

export type GraphNodeBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type FullGraphViewportBoundsModel = {
  nodeBounds: GraphNodeBounds;
  translateExtent: CoordinateExtent;
};

const getNodeDimension = (primary: unknown, fallback: unknown, defaultValue: number): number => {
  if (typeof primary === 'number' && Number.isFinite(primary) && primary > 0) return primary;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) return fallback;
  return defaultValue;
};

export const buildGraphNodeBounds = (nodes: Node<any>[]): GraphNodeBounds | null => {
  if (nodes.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const width = getNodeDimension(node.width, node.style?.width, GRAPH_VIEWPORT_FALLBACK_NODE_WIDTH);
    const height = getNodeDimension(node.height, node.style?.height, GRAPH_VIEWPORT_FALLBACK_NODE_HEIGHT);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
};

const padGraphNodeBounds = (
  bounds: GraphNodeBounds,
  padding = GRAPH_VIEWPORT_NODE_BOUNDS_PADDING,
): GraphNodeBounds => {
  const safePadding = Math.max(0, padding);
  return {
    minX: bounds.minX - safePadding,
    minY: bounds.minY - safePadding,
    maxX: bounds.maxX + safePadding,
    maxY: bounds.maxY + safePadding,
  };
};

export const buildFullGraphViewportBoundsModel = (nodes: Node<any>[]): FullGraphViewportBoundsModel | null => {
  const nodeBounds = buildGraphNodeBounds(nodes);
  if (!nodeBounds) return null;
  const paddedBounds = padGraphNodeBounds(nodeBounds);

  return {
    nodeBounds,
    translateExtent: [
      [paddedBounds.minX, paddedBounds.minY],
      [paddedBounds.maxX, paddedBounds.maxY],
    ],
  };
};

export const clampPointToGraphBounds = (
  point: { x: number; y: number },
  bounds: GraphNodeBounds | null,
  padding = 0,
) => {
  if (!bounds) return point;
  const paddedBounds = padding > 0 ? padGraphNodeBounds(bounds, padding) : bounds;

  return {
    x: Math.min(Math.max(point.x, paddedBounds.minX), paddedBounds.maxX),
    y: Math.min(Math.max(point.y, paddedBounds.minY), paddedBounds.maxY),
  };
};

export const clampGraphViewportToBounds = (
  viewport: Viewport,
  bounds: GraphNodeBounds | null,
  flowSize: { width: number; height: number },
): Viewport => {
  const zoom = Math.max(viewport.zoom || 1, 0.0001);
  const width = flowSize.width / zoom;
  const height = flowSize.height / zoom;
  if (!bounds || width <= 0 || height <= 0) return viewport;

  const center = clampPointToGraphBounds({
    x: -viewport.x / zoom + width / 2,
    y: -viewport.y / zoom + height / 2,
  }, bounds, GRAPH_VIEWPORT_NODE_BOUNDS_PADDING);

  return {
    x: flowSize.width / 2 - center.x * zoom,
    y: flowSize.height / 2 - center.y * zoom,
    zoom: viewport.zoom,
  };
};

export const clampGraphViewportToFullGraphBoundsModel = (
  viewport: Viewport,
  model: FullGraphViewportBoundsModel | null,
  flowSize: { width: number; height: number },
): Viewport => clampGraphViewportToBounds(viewport, model?.nodeBounds ?? null, flowSize);
