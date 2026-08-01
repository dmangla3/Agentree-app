import { EdgeLabelRenderer } from '@xyflow/react';

interface ContextResetCutProps {
  x: number;
  y: number;
}

export const ContextResetCut = ({ x, y }: ContextResetCutProps) => (
  <EdgeLabelRenderer>
    <div
      title="Context reset"
      className="nodrag nopan flex h-6 w-28 items-center justify-center rounded-sm bg-background/95 shadow-sm ring-1 ring-border/80"
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: 'all',
      }}
    >
      <div className="w-24 border-t-[4px] border-dashed border-foreground/85 dark:border-foreground/90" />
    </div>
  </EdgeLabelRenderer>
);
