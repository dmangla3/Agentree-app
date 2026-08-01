import { BaseEdge, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { ContextResetCut } from './ContextResetCut';

export const ContextSmoothStepEdge = ({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) => {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {(data as any)?.contextBoundary?.type === 'fresh' && (
        <ContextResetCut x={labelX} y={labelY} />
      )}
    </>
  );
};
