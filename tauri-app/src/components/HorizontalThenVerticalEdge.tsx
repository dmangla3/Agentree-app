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
  const direction = targetX >= sourceX ? -1 : 1;
  const gutterBase = 24;
  const offsetStep = 6;
  const offsetBuckets = 7;
  const offset = hashToOffset(id, offsetBuckets) * offsetStep;
  const gutterX = targetX + direction * (gutterBase + offset);
  const path = `M ${sourceX} ${sourceY} L ${gutterX} ${sourceY} L ${gutterX} ${targetY} L ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
      />
      {(data as any)?.contextBoundary?.type === 'fresh' && (
        <ContextResetCut x={gutterX} y={(sourceY + targetY) / 2} />
      )}
    </>
  );
};
