import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut, getContextResetCutPosition } from './ContextResetCut';

const NEAR_VERTICAL_THRESHOLD = 1;

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
