import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut, getContextResetCutPosition } from './ContextResetCut';
import { getEdgeEndpointDotVariant, getEdgeEndpointDotVisuals, type EdgeEndpointDotVariant } from './graphEdgeEndpointDots';

const NEAR_VERTICAL_THRESHOLD = 1;

export const EdgeEndpointDots = ({
  edgeId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  variant,
}: {
  edgeId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  variant: EdgeEndpointDotVariant | null;
}) => {
  if (!variant) return null;

  const visuals = getEdgeEndpointDotVisuals(variant);

  return (
    <g pointerEvents="none" aria-hidden="true">
      <circle
        cx={sourceX}
        cy={sourceY}
        r={visuals.haloRadius}
        fill={visuals.haloColor}
      />
      <circle
        data-testid={`${edgeId}-source-endpoint-dot`}
        cx={sourceX}
        cy={sourceY}
        r={visuals.sourceRadius}
        fill="hsl(var(--background))"
        stroke={visuals.color}
        strokeWidth={3}
      />
      <circle
        cx={targetX}
        cy={targetY}
        r={visuals.haloRadius}
        fill={visuals.haloColor}
      />
      <circle
        data-testid={`${edgeId}-target-endpoint-dot`}
        cx={targetX}
        cy={targetY}
        r={visuals.targetRadius}
        fill={visuals.color}
        stroke="hsl(var(--background))"
        strokeWidth={2}
      />
    </g>
  );
};

export const getVerticalThenHorizontalEdgePath = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}): { path: string; labelX: number; labelY: number } => {
  const isNearlyVertical = Math.abs(targetX - sourceX) <= NEAR_VERTICAL_THRESHOLD;
  const path = isNearlyVertical
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceX} ${targetY} L ${targetX} ${targetY}`;
  return {
    path,
    labelX: isNearlyVertical ? (sourceX + targetX) / 2 : sourceX,
    labelY: isNearlyVertical ? (sourceY + targetY) / 2 : (sourceY + targetY) / 2,
  };
};

export const HorizontalThenVerticalEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) => {
  const { path } = getVerticalThenHorizontalEdgePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const contextBoundary = (data as any)?.contextBoundary;
  const endpointDotVariant = getEdgeEndpointDotVariant(data);
  const contextResetCutPosition = getContextResetCutPosition({
    targetX,
    targetY,
    targetPosition,
    anchor: contextBoundary?.anchor,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
      />
      <EdgeEndpointDots
        edgeId={id}
        sourceX={sourceX}
        sourceY={sourceY}
        targetX={targetX}
        targetY={targetY}
        variant={endpointDotVariant}
      />
      {contextBoundary?.type === 'fresh' && (
        <ContextResetCut
          x={contextResetCutPosition.x}
          y={contextResetCutPosition.y}
          orientation={contextResetCutPosition.orientation}
        />
      )}
    </>
  );
};
