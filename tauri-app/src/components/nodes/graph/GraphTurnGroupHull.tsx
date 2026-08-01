import { memo } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '../../../lib/utils';
import { withHexAlpha } from '../../../lib/visualTokens';

interface GraphTurnGroupHullProps {
  id: string;
  data: {
    label?: string;
    scopeColor?: string | null;
  };
  style?: CSSProperties;
}

export const GraphTurnGroupHull = memo(({
  data,
  style
}: GraphTurnGroupHullProps) => {
  const scopeColor = data.scopeColor || '#94a3b8';
  
  return (
    <div
      style={{
        ...style,
        backgroundColor: withHexAlpha(scopeColor, '08'),
        borderColor: withHexAlpha(scopeColor, '15'),
      }}
      className={cn(
        "rounded-[32px] border-2 border-dashed transition-all duration-500 pointer-events-none z-[-1]",
      )}
    >
      {data.label && (
        <div 
          className="absolute -top-3 left-6 px-3 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest text-white shadow-sm"
          style={{ backgroundColor: withHexAlpha(scopeColor, '80') }}
        >
          {data.label}
        </div>
      )}
    </div>
  );
});

GraphTurnGroupHull.displayName = 'GraphTurnGroupHull';
