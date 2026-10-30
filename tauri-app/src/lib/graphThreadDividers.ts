import type { Node } from '@xyflow/react';

export type ThreadDividerRect = {
  id: string;
  threadRootId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ThreadBand = {
  id: string;
  threadRootId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  count: number;
};

type NodeLike = Pick<Node<any>, 'id' | 'type' | 'parentId' | 'position' | 'width' | 'height' | 'measured' | 'initialWidth' | 'initialHeight' | 'style' | 'data' | 'hidden'>;

type BuildThreadBandOptions = {
  padding?: number;
  horizontalPadding?: number;
  trimOverlaps?: boolean;
  equalVerticalExtent?: boolean;
};

const DEFAULT_BAND_PADDING = 220;
const DEFAULT_BAND_HORIZONTAL_PADDING = 72;

const readNumericDimension = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const getNodeDimensions = (node: NodeLike): { width: number; height: number } => ({
  width:
    readNumericDimension(node.measured?.width) ??
    readNumericDimension(node.width) ??
    readNumericDimension(node.initialWidth) ??
    readNumericDimension((node.style as any)?.width) ??
    0,
  height:
    readNumericDimension(node.measured?.height) ??
    readNumericDimension(node.height) ??
    readNumericDimension(node.initialHeight) ??
    readNumericDimension((node.style as any)?.height) ??
    0,
});

const getNodeThreadRootId = (
  node: NodeLike,
  threadRootIdByMessageId: Map<string, string>,
  nodeById: Map<string, NodeLike>,
  visitedNodeIds = new Set<string>(),
): string | null => {
  if (visitedNodeIds.has(node.id)) return null;
  visitedNodeIds.add(node.id);

  const data = node.data as any;
  if (typeof data?.entity?.threadRootId === 'string') return data.entity.threadRootId;

  if (node.type === 'turn_group_hull') {
    if (data?.slotKind === 'commit-only') return null;
    const memberIds = data?.memberIds;
    if (!Array.isArray(memberIds)) return null;

    let resolvedThreadRootId: string | null = null;
    for (const memberId of memberIds) {
      if (typeof memberId !== 'string') continue;
      const memberNode = nodeById.get(memberId);
      if (!memberNode) continue;
      const threadRootId = getNodeThreadRootId(
        memberNode,
        threadRootIdByMessageId,
        nodeById,
        new Set(visitedNodeIds),
      );
      if (!threadRootId) continue;
      if (resolvedThreadRootId && resolvedThreadRootId !== threadRootId) return null;
      resolvedThreadRootId = threadRootId;
    }
    return resolvedThreadRootId;
  }

  const candidateIds = [
    data?.entity?.focusMessageId,
    data?.entity?.messageId,
    data?.message?.id,
    node.id,
  ];

  for (const candidateId of candidateIds) {
    if (typeof candidateId !== 'string') continue;
    const threadRootId = threadRootIdByMessageId.get(candidateId);
    if (threadRootId) return threadRootId;
  }

  const batchMessageIds = data?.batch?.messageIds;
  if (Array.isArray(batchMessageIds)) {
    let resolvedThreadRootId: string | null = null;
    for (const messageId of batchMessageIds) {
      if (typeof messageId !== 'string') continue;
      const threadRootId = threadRootIdByMessageId.get(messageId);
      if (!threadRootId) continue;
      if (resolvedThreadRootId && resolvedThreadRootId !== threadRootId) return null;
      resolvedThreadRootId = threadRootId;
    }
    return resolvedThreadRootId;
  }

  return null;
};

const shouldUseNodeForThreadDividers = (node: NodeLike): boolean => {
  if (node.hidden) return false;
  return node.type !== 'summary_block';
};

const buildAbsolutePositionReader = (nodes: NodeLike[]) => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const cache = new Map<string, { x: number; y: number }>();

  const readPosition = (node: NodeLike): { x: number; y: number } => {
    const cached = cache.get(node.id);
    if (cached) return cached;

    const ownPosition = {
      x: readNumericDimension(node.position?.x) ?? 0,
      y: readNumericDimension(node.position?.y) ?? 0,
    };
    const parent = node.parentId ? nodeById.get(node.parentId) : null;
    const position = parent
      ? {
        x: readPosition(parent).x + ownPosition.x,
        y: readPosition(parent).y + ownPosition.y,
      }
      : ownPosition;

    cache.set(node.id, position);
    return position;
  };

  return readPosition;
};

export const getThreadDividerRectsFromNodes = (
  nodes: NodeLike[],
  threadRootIdByMessageId: Map<string, string>,
): ThreadDividerRect[] => {
  const readAbsolutePosition = buildAbsolutePositionReader(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const turnRects: ThreadDividerRect[] = [];
  const fallbackRects: ThreadDividerRect[] = [];

  for (const node of nodes) {
    if (!shouldUseNodeForThreadDividers(node)) continue;
    const threadRootId = getNodeThreadRootId(node, threadRootIdByMessageId, nodeById);
    if (!threadRootId) continue;
    const dimensions = getNodeDimensions(node);
    if (dimensions.width <= 0 || dimensions.height <= 0) continue;
    const position = readAbsolutePosition(node);
    const rect = {
      id: node.id,
      threadRootId,
      x: position.x,
      y: position.y,
      width: dimensions.width,
      height: dimensions.height,
    };

    if (node.type === 'turn_group_hull') {
      turnRects.push(rect);
    } else {
      fallbackRects.push(rect);
    }
  }

  return turnRects.length > 0 ? turnRects : fallbackRects;
};

export const buildThreadBands = (
  rects: ThreadDividerRect[],
  options: BuildThreadBandOptions = {},
): ThreadBand[] => {
  const padding = options.padding ?? DEFAULT_BAND_PADDING;
  const horizontalPadding = options.horizontalPadding ?? DEFAULT_BAND_HORIZONTAL_PADDING;
  const trimOverlaps = options.trimOverlaps ?? true;
  const equalVerticalExtent = options.equalVerticalExtent ?? false;
  const bandByThreadRootId = new Map<string, {
    threadRootId: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    count: number;
  }>();

  for (const rect of rects) {
    const existing = bandByThreadRootId.get(rect.threadRootId);
    const next = {
      threadRootId: rect.threadRootId,
      left: Math.min(existing?.left ?? Number.POSITIVE_INFINITY, rect.x),
      right: Math.max(existing?.right ?? Number.NEGATIVE_INFINITY, rect.x + rect.width),
      top: Math.min(existing?.top ?? Number.POSITIVE_INFINITY, rect.y),
      bottom: Math.max(existing?.bottom ?? Number.NEGATIVE_INFINITY, rect.y + rect.height),
      count: (existing?.count ?? 0) + 1,
    };
    bandByThreadRootId.set(rect.threadRootId, next);
  }

  const bands = Array.from(bandByThreadRootId.values())
    .filter((band) => band.count > 0)
    .map((band) => ({
      id: band.threadRootId,
      threadRootId: band.threadRootId,
      left: band.left - horizontalPadding,
      right: band.right + horizontalPadding,
      top: band.top - padding,
      bottom: band.bottom + padding,
      count: band.count,
    }))
    .sort((left, right) => {
      const leftCenter = (left.left + left.right) / 2;
      const rightCenter = (right.left + right.right) / 2;
      return leftCenter - rightCenter || left.left - right.left || left.threadRootId.localeCompare(right.threadRootId);
    });

  if (trimOverlaps) {
    for (let index = 1; index < bands.length; index += 1) {
      const previous = bands[index - 1];
      const current = bands[index];
      if (previous.right <= current.left) continue;

      const boundary = previous.right + (current.left - previous.right) / 2;
      previous.right = boundary;
      current.left = boundary;
    }
  }

  if (equalVerticalExtent && bands.length > 1) {
    const top = Math.min(...bands.map((band) => band.top));
    const bottom = Math.max(...bands.map((band) => band.bottom));
    for (const band of bands) {
      band.top = top;
      band.bottom = bottom;
    }
  }

  return bands;
};
