export interface OrchestrationMiniLayoutChild {
  id: string;
}

export interface OrchestrationMiniLayoutEdge {
  sourceId: string;
  targetId: string;
}

export interface OrchestrationMiniLayoutPosition {
  x: number;
  y: number;
}

export const getOrchestrationMiniGridPosition = (
  index: number,
  count: number,
): OrchestrationMiniLayoutPosition => {
  if (count <= 1) return { x: 50, y: 50 };
  const columns = Math.min(4, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const col = index % columns;
  const row = Math.floor(index / columns);
  const x = columns === 1 ? 50 : 18 + (col * 64) / Math.max(1, columns - 1);
  const y = rows === 1 ? 50 : 24 + (row * 52) / Math.max(1, rows - 1);
  return { x, y };
};

const buildGridPositions = (
  children: readonly OrchestrationMiniLayoutChild[],
): Map<string, OrchestrationMiniLayoutPosition> => (
  new Map(children.map((child, index) => [
    child.id,
    getOrchestrationMiniGridPosition(index, children.length),
  ]))
);

export const getOrchestrationMiniLayoutPositions = (
  children: readonly OrchestrationMiniLayoutChild[],
  edges: readonly OrchestrationMiniLayoutEdge[] = [],
): Map<string, OrchestrationMiniLayoutPosition> => {
  if (children.length <= 1) return buildGridPositions(children);

  const indexById = new Map(children.map((child, index) => [child.id, index]));
  const childIds = new Set(indexById.keys());
  const validEdges = edges.filter((edge) => (
    edge.sourceId !== edge.targetId &&
    childIds.has(edge.sourceId) &&
    childIds.has(edge.targetId)
  ));
  if (validEdges.length === 0) return buildGridPositions(children);

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  children.forEach((child) => {
    incoming.set(child.id, new Set());
    outgoing.set(child.id, new Set());
  });
  validEdges.forEach((edge) => {
    outgoing.get(edge.sourceId)?.add(edge.targetId);
    incoming.get(edge.targetId)?.add(edge.sourceId);
  });

  const sortByInputOrder = (left: string, right: string): number => (
    (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0) ||
    left.localeCompare(right)
  );

  const remainingIncoming = new Map(
    children.map((child) => [child.id, incoming.get(child.id)?.size ?? 0]),
  );
  const queue = children
    .map((child) => child.id)
    .filter((id) => (remainingIncoming.get(id) ?? 0) === 0)
    .sort(sortByInputOrder);
  const depthById = new Map<string, number>();
  let processedCount = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    processedCount += 1;
    const parentDepths = Array.from(incoming.get(id) ?? [])
      .map((parentId) => depthById.get(parentId))
      .filter((depth): depth is number => depth !== undefined);
    depthById.set(id, parentDepths.length > 0 ? Math.max(...parentDepths) + 1 : 0);

    const childrenForId = Array.from(outgoing.get(id) ?? []).sort(sortByInputOrder);
    childrenForId.forEach((childId) => {
      const nextIncoming = (remainingIncoming.get(childId) ?? 0) - 1;
      remainingIncoming.set(childId, nextIncoming);
      if (nextIncoming === 0) {
        queue.push(childId);
        queue.sort(sortByInputOrder);
      }
    });
  }

  if (processedCount < children.length) return buildGridPositions(children);

  const layers = new Map<number, string[]>();
  children.forEach((child) => {
    const depth = depthById.get(child.id) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), child.id]);
  });
  layers.forEach((ids) => ids.sort(sortByInputOrder));

  const layerNumbers = Array.from(layers.keys()).sort((left, right) => left - right);
  const order = new Map<string, number>();
  const refreshOrder = () => {
    layers.forEach((ids) => {
      ids.forEach((id, index) => order.set(id, index));
    });
  };
  refreshOrder();

  const sortByNeighborCenter = (ids: string[], neighborsById: Map<string, Set<string>>): string[] => (
    ids
      .map((id) => {
        const neighbors = Array.from(neighborsById.get(id) ?? []);
        if (neighbors.length === 0) return { id, center: Number.POSITIVE_INFINITY };
        const center = neighbors.reduce((sum, neighborId) => sum + (order.get(neighborId) ?? 0), 0) / neighbors.length;
        return { id, center };
      })
      .sort((left, right) => left.center - right.center || sortByInputOrder(left.id, right.id))
      .map((item) => item.id)
  );

  for (let sweep = 0; sweep < 3; sweep += 1) {
    for (let layerIndex = 1; layerIndex < layerNumbers.length; layerIndex += 1) {
      const layer = layerNumbers[layerIndex];
      layers.set(layer, sortByNeighborCenter(layers.get(layer) ?? [], incoming));
      refreshOrder();
    }
    for (let layerIndex = layerNumbers.length - 2; layerIndex >= 0; layerIndex -= 1) {
      const layer = layerNumbers[layerIndex];
      layers.set(layer, sortByNeighborCenter(layers.get(layer) ?? [], outgoing));
      refreshOrder();
    }
  }

  const positions = new Map<string, OrchestrationMiniLayoutPosition>();
  const minY = 22;
  const maxY = 78;
  const minX = 16;
  const maxX = 84;
  const maxNodesPerVisualRow = 5;
  const compactXStep = (maxX - minX) / Math.max(1, maxNodesPerVisualRow - 1);
  const visualRows = layerNumbers.flatMap((layer) => {
    const ids = layers.get(layer) ?? [];
    const rows: string[][] = [];
    for (let index = 0; index < ids.length; index += maxNodesPerVisualRow) {
      rows.push(ids.slice(index, index + maxNodesPerVisualRow));
    }
    return rows;
  });
  const rowCount = visualRows.length;

  visualRows.forEach((ids, rowIndex) => {
    const y = rowCount <= 1
      ? 50
      : minY + ((maxY - minY) * rowIndex) / (rowCount - 1);
    const parentXs = ids.flatMap((id) => (
      Array.from(incoming.get(id) ?? [])
        .map((parentId) => positions.get(parentId)?.x)
        .filter((x): x is number => x !== undefined)
    ));
    const compactCenterX = parentXs.length > 0
      ? parentXs.reduce((sum, x) => sum + x, 0) / parentXs.length
      : null;
    const compactWidth = compactXStep * Math.max(0, ids.length - 1);
    const compactStartX = compactCenterX === null
      ? null
      : Math.min(maxX - compactWidth, Math.max(minX, compactCenterX - compactWidth / 2));
    ids.forEach((id, index) => {
      const x = compactStartX !== null
        ? compactStartX + compactXStep * index
        : ids.length <= 1
          ? 50
          : minX + ((maxX - minX) * index) / (ids.length - 1);
      positions.set(id, { x, y });
    });
  });

  return positions;
};
