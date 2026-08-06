import { memo } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '../../../lib/utils';
import { withHexAlpha } from '../../../lib/visualTokens';

interface GraphTurnGroupHullProps {
  id: string;
  data: {
    label?: string;
    scopeColor?: string | null;
    slotKind?: 'turn' | 'commit-only';
  };
  style?: CSSProperties;
}

export const GraphTurnGroupHull = memo(({
  data,
  style
}: GraphTurnGroupHullProps) => {
  const scopeColor = data.scopeColor || '#94a3b8';
  const isCommitOnly = data.slotKind === 'commit-only';
  
  return (
    <div
      style={{
        ...style,
        backgroundColor: isCommitOnly ? 'rgba(16, 185, 129, 0.085)' : withHexAlpha(scopeColor, '12'),
        borderColor: isCommitOnly ? 'rgba(16, 185, 129, 0.26)' : withHexAlpha(scopeColor, '34'),
      }}
      className={cn(
        'relative h-full w-full rounded-lg border border-solid pointer-events-none z-[-1]',
        'transition-[background-color,border-color,box-shadow] duration-300',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_10px_24px_-24px_rgba(24,24,27,0.42)]',
        'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      )}
    >
      {data.label && (
        <div 
          className="absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.1em] text-white/95 shadow-sm"
          style={{ backgroundColor: withHexAlpha(scopeColor, '8C') }}
        >
          {data.label}
        </div>
      )}
    </div>
  );
});

GraphTurnGroupHull.displayName = 'GraphTurnGroupHull';
