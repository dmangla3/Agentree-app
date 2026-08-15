export type EdgeEndpointDotVariant = 'commit-parent' | 'convergence';

type EdgeLegendLike = 'context-path' | 'conversation' | 'context-break' | 'git-parent' | 'base-used' | string;

type GraphNodeLike = {
  type?: string | null;
  data?: {
    entity?: {
      turnGroupId?: string | null;
    } | null;
    turnGroupId?: string | null;
  } | null;
} | null | undefined;

export const getEdgeEndpointDotVariant = (data: unknown): EdgeEndpointDotVariant | null => {
  const variant = (data as any)?.endpointDotVariant;
  return variant === 'commit-parent' || variant === 'convergence' ? variant : null;
};

export const getEdgeEndpointDotVisuals = (variant: EdgeEndpointDotVariant) => ({
  color: variant === 'commit-parent' ? '#10b981' : '#6366f1',
  haloColor: variant === 'commit-parent' ? 'rgba(16,185,129,0.22)' : 'rgba(99,102,241,0.24)',
  sourceRadius: 6,
  targetRadius: 7,
  haloRadius: 11,
});

const getTurnGroupId = (node: GraphNodeLike): string | null => (
  node?.data?.entity?.turnGroupId ?? node?.data?.turnGroupId ?? null
);

export const isInterTurnEndpointEdge = (sourceNode: GraphNodeLike, targetNode: GraphNodeLike): boolean => {
  const sourceTurnGroupId = getTurnGroupId(sourceNode);
  const targetTurnGroupId = getTurnGroupId(targetNode);

  if (sourceTurnGroupId && targetTurnGroupId && sourceTurnGroupId === targetTurnGroupId) {
    return false;
  }

  if (sourceNode?.type === 'user_message' && targetNode?.type === 'assistant_message') {
    return false;
  }

  return true;
};

export const getGraphEdgeEndpointDotVariant = ({
  edgeLegendType,
  matchedContextPathPreview,
  isInterTurnEdge,
}: {
  edgeLegendType: EdgeLegendLike | null | undefined;
  matchedContextPathPreview: boolean;
  isInterTurnEdge: boolean;
}): EdgeEndpointDotVariant | null => {
  if (!isInterTurnEdge) return null;
  if (edgeLegendType === 'git-parent') return 'commit-parent';
  if (matchedContextPathPreview) return 'convergence';
  return null;
};
