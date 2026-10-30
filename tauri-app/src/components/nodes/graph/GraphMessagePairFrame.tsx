import { memo } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '../../../lib/utils';

interface GraphMessagePairFrameProps {
  data: {
    isFocused?: boolean;
    isSelected?: boolean;
  };
  style?: CSSProperties;
}

export const GraphMessagePairFrame = memo(({
  data,
  style,
}: GraphMessagePairFrameProps) => {
  const isFocused = Boolean(data.isFocused);
  const isSelected = Boolean(data.isSelected);

  return (
    <div
      style={style}
      className={cn(
        'pointer-events-none h-full w-full rounded-[8px] border transition-[background-color,border-color,box-shadow] duration-200',
        isFocused
          ? 'border-[hsl(var(--app-selection)/0.92)] bg-[hsl(var(--app-accent-soft)/0.14)] shadow-md ring-2 ring-[hsl(var(--app-selection)/0.9)]'
          : 'border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.14)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]',
        isSelected && !isFocused && 'border-[hsl(var(--app-selection)/0.68)] bg-[hsl(var(--app-bg-muted)/0.5)] ring-2 ring-[hsl(var(--app-selection)/0.58)]'
      )}
    />
  );
});

GraphMessagePairFrame.displayName = 'GraphMessagePairFrame';
