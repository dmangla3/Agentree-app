import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut, getContextResetCutPosition } from './ContextResetCut';

export const VerticalThenHorizontalEdge = ({
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
  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${targetY} L ${targetX} ${targetY}`;
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
