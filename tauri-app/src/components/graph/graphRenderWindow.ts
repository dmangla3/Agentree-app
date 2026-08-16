import type { Node } from '@xyflow/react';

export const resolveAnchoredGraphWindowNodeIds = (
  nodeIds: Set<string>,
  nodes: Node<any>[],
): Set<string> => {
  const resolved = new Set(nodeIds);
  let changed = true;

  while (changed) {
    changed = false;

    for (const node of nodes) {
      const anchorId = (node.data as any)?.layoutAnchorNodeId;
      if (typeof anchorId !== 'string' || !anchorId) continue;

      if (resolved.has(node.id) && !resolved.has(anchorId)) {
        resolved.add(anchorId);
        changed = true;
      }

      if (resolved.has(anchorId) && !resolved.has(node.id)) {
        resolved.add(node.id);
        changed = true;
      }
    }
  }

  return resolved;
};

export const hasLayoutAnchoredGraphNodes = (nodes: Node<any>[]): boolean => (
  nodes.some((node) => {
    const anchorId = (node.data as any)?.layoutAnchorNodeId;
    return typeof anchorId === 'string' && anchorId.length > 0;
  })
);
