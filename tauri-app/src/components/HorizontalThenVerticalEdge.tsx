import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut } from './ContextResetCut';

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
  style,
  markerEnd,
  data,
}: EdgeProps) => {
  const { path, labelX, labelY } = getVerticalThenHorizontalEdgePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
      />
      {(data as any)?.contextBoundary?.type === 'fresh' && (
        <ContextResetCut x={labelX} y={labelY} />
      )}
    </>
  );
};
