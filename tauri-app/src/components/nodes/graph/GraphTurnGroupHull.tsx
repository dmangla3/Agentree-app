import { memo } from 'react';
import type { CSSProperties } from 'react';
import { GitBranch } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { withHexAlpha } from '../../../lib/visualTokens';

interface GraphTurnGroupHullProps {
  id: string;
  data: {
    label?: string;
    slotKind?: 'turn' | 'commit-only';
    threadRootId?: string | null;
    isThreadRoot?: boolean;
  };
  style?: CSSProperties;
}

const THREAD_ACCENT_COLORS = ['#4f8dd8', '#4f9f75', '#8b6fd6', '#c47a32', '#ba6d92', '#3d9f97'];

const getThreadAccentColor = (threadRootId: string | null | undefined): string => {
  if (!threadRootId) return '#64748b';
  let hash = 0;
  for (let index = 0; index < threadRootId.length; index += 1) {
    hash = (hash * 31 + threadRootId.charCodeAt(index)) >>> 0;
  }
  return THREAD_ACCENT_COLORS[hash % THREAD_ACCENT_COLORS.length];
};

export const GraphTurnGroupHull = memo(({
  data,
  style
}: GraphTurnGroupHullProps) => {
  const hullColor = '#64748b';
  const isCommitOnly = data.slotKind === 'commit-only';
  const isThreadRoot = Boolean(data.isThreadRoot && !isCommitOnly);
  const threadAccentColor = getThreadAccentColor(data.threadRootId);
  
  return (
    <div
      style={{
        ...style,
        backgroundColor: isCommitOnly ? 'rgba(16, 185, 129, 0.085)' : withHexAlpha(hullColor, '10'),
        borderColor: isCommitOnly ? 'rgba(16, 185, 129, 0.26)' : withHexAlpha(hullColor, '28'),
      }}
      className={cn(
        'relative h-full w-full rounded-xl border border-solid pointer-events-none z-[-1]',
        'transition-[background-color,border-color,box-shadow] duration-normal ease-out-cubic motion-reduce:transition-none',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_10px_24px_-24px_rgba(24,24,27,0.42)]',
        'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      )}
    >
      {isThreadRoot && (
        <>
          <div
            className="absolute left-0 top-4 h-[calc(100%-2rem)] w-[3px] rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.34)]"
            style={{
              background: `${threadAccentColor}D8`,
            }}
          />
          <div
            data-design-typography="soft-label-bold"
            className="absolute left-3 top-2 flex items-center gap-1 rounded-md border bg-[hsl(var(--app-panel)/0.92)] px-2 py-1 text-[8px] font-medium uppercase leading-none tracking-[0.12em] shadow-sm backdrop-blur-sm"
            style={{
              borderColor: `${threadAccentColor}55`,
              color: threadAccentColor,
            }}
          >
            <GitBranch className="h-2.5 w-2.5" strokeWidth={2.4} />
            Thread
          </div>
        </>
      )}
      {data.label && (
        <div 
          data-design-typography="soft-on-color"
          className={cn(
            "absolute top-2 rounded-md px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.1em] text-[hsl(40_24%_96%)] shadow-sm",
            isThreadRoot ? "left-[5.75rem]" : "left-2"
          )}
          style={{ backgroundColor: withHexAlpha(hullColor, '8C') }}
        >
          {data.label}
        </div>
      )}
    </div>
  );
});

GraphTurnGroupHull.displayName = 'GraphTurnGroupHull';
