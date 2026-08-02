import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut } from './ContextResetCut';

const hashToOffset = (id: string, bucketCount: number) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % bucketCount;
  const mid = Math.floor(bucketCount / 2);
  return idx - mid;
};

export const getVerticalHorizontalVerticalEdgePath = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}): { path: string; midpointY: number } => {
  const dy = targetY - sourceY;
  const offsetStep = 5;
  const offsetBuckets = 5;
  const offset = hashToOffset(id, offsetBuckets) * offsetStep;
  const midpointY = Math.abs(dy) <= 2
    ? sourceY
    : sourceY + dy / 2 + offset;
  const isNearlyVertical = Math.abs(targetX - sourceX) <= 1;
  const path = isNearlyVertical
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceX} ${midpointY} L ${targetX} ${midpointY} L ${targetX} ${targetY}`;
  return { path, midpointY };
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
  const { path, midpointY } = getVerticalHorizontalVerticalEdgePath({
    id,
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
        <ContextResetCut x={(sourceX + targetX) / 2} y={midpointY} />
      )}
    </>
  );
};
