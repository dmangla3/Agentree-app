import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut } from './ContextResetCut';

export const VerticalThenHorizontalEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  data,
}: EdgeProps) => {
  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${targetY} L ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
      />
      {(data as any)?.contextBoundary?.type === 'fresh' && (
        <ContextResetCut x={sourceX} y={(sourceY + targetY) / 2} />
      )}
    </>
  );
};
