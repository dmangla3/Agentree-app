import { EdgeLabelRenderer, Position } from '@xyflow/react';

interface ContextResetCutProps {
  x: number;
  y: number;
  orientation?: 'horizontal' | 'vertical';
}

export const getContextResetCutPosition = ({
  targetX,
  targetY,
  targetPosition = Position.Top,
  anchor,
}: {
  targetX: number;
  targetY: number;
  targetPosition?: Position;
  anchor?: { x?: unknown; y?: unknown } | null;
}): { x: number; y: number; orientation: 'horizontal' | 'vertical' } => {
  if (targetPosition === Position.Left || targetPosition === Position.Right) {
    return {
      x: targetX,
      y: targetY,
      orientation: 'vertical',
    };
  }

  return {
    x: typeof anchor?.x === 'number' ? anchor.x : targetX,
    y: typeof anchor?.y === 'number' ? anchor.y : targetY,
    orientation: 'horizontal',
  };
};

export const ContextResetCut = ({ x, y, orientation = 'horizontal' }: ContextResetCutProps) => (
  <EdgeLabelRenderer>
    <div
      title="Context reset"
      className={[
        'nodrag nopan flex items-center justify-center rounded-sm bg-background/95 shadow-sm ring-1 ring-border/80',
        orientation === 'vertical' ? 'h-28 w-6' : 'h-6 w-28',
      ].join(' ')}
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: 'all',
      }}
    >
      <div
        className={
          orientation === 'vertical'
            ? 'h-24 border-l-[4px] border-dashed border-foreground/85 dark:border-foreground/90'
            : 'w-24 border-t-[4px] border-dashed border-foreground/85 dark:border-foreground/90'
        }
      />
    </div>
  </EdgeLabelRenderer>
);
