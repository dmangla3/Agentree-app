import type { Node } from '@xyflow/react';

const numericDimension = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.endsWith('px')) {
      const parsed = Number.parseFloat(trimmed);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
  }

  return undefined;
};

export const withExplicitReactFlowNodeDimensions = <NodeType extends Node<any>>(node: NodeType): NodeType => {
  const width = numericDimension(node.width)
    ?? numericDimension(node.initialWidth)
    ?? numericDimension(node.measured?.width)
    ?? numericDimension(node.style?.width);
  const height = numericDimension(node.height)
    ?? numericDimension(node.initialHeight)
    ?? numericDimension(node.measured?.height)
    ?? numericDimension(node.style?.height);

  if (width === undefined || height === undefined) {
    return node;
  }

  if (node.width === width && node.height === height) {
    return node;
  }

  return {
    ...node,
    width,
    height,
  };
};

export const withExplicitReactFlowNodesDimensions = <NodeType extends Node<any>>(nodes: NodeType[]): NodeType[] => (
  nodes.map(withExplicitReactFlowNodeDimensions)
);
