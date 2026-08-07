import { BaseEdge, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { ContextResetCut, getContextResetCutPosition } from './ContextResetCut';

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
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
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
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
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
