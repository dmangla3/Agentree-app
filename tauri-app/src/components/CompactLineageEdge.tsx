import { BaseEdge, type EdgeProps } from '@xyflow/react';
import { ContextResetCut, getContextResetCutPosition } from './ContextResetCut';

const SHORT_EDGE_THRESHOLD = 140;
const NEAR_VERTICAL_THRESHOLD = 28;

export const CompactLineageEdge = ({
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
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.hypot(dx, dy);
  const shouldUseLine = distance <= SHORT_EDGE_THRESHOLD || Math.abs(dx) <= NEAR_VERTICAL_THRESHOLD;
  const curveLift = Math.max(-32, Math.min(32, dy * 0.12));
  const controlX = sourceX + dx / 2;
  const controlY = sourceY + dy / 2 - curveLift;
  const path = shouldUseLine
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}`;
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
