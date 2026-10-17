import type { ReactNode, SyntheticEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export function getAdjacentHoverNavigationIndex(
  currentIndex: number,
  itemCount: number,
  step: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  const clampedIndex = Math.min(Math.max(currentIndex, 0), itemCount - 1);
  return Math.min(Math.max(clampedIndex + step, 0), itemCount - 1);
}

const stopNavigationPropagation = (event: SyntheticEvent) => {
  event.stopPropagation();
};

const handleNavigationClick = (event: SyntheticEvent, action: () => void) => {
  event.preventDefault();
  event.stopPropagation();
  action();
};

interface HoverCardNavigationChromeProps {
  position: number;
  itemCount: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousLabel: string;
  nextLabel: string;
  accessory?: ReactNode;
  announcement?: string | null;
  nextAttention?: boolean;
  showControls?: boolean;
}

export function HoverCardNavigationChrome({
  position,
  itemCount,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
  accessory,
  announcement = null,
  nextAttention = false,
  showControls = true,
}: HoverCardNavigationChromeProps) {
  if (!showControls && !accessory && !announcement) return null;

  return (
    <div
      data-agentree-hover-navigation-chrome="true"
      className="mb-2 flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.46)] pb-2"
      onPointerDown={stopNavigationPropagation}
      onMouseDown={stopNavigationPropagation}
      onClick={stopNavigationPropagation}
    >
      {accessory || announcement ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {accessory}
          {announcement ? (
            <span className="sr-only" aria-live="polite">{announcement}</span>
          ) : null}
        </div>
      ) : <span />}
      {showControls ? (
        <div className="ml-auto flex h-11 shrink-0 items-center rounded-full border border-[hsl(var(--app-border)/0.56)] bg-[hsl(var(--background)/0.78)] p-0.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04),0_8px_20px_-18px_hsl(var(--foreground)/0.5)] backdrop-blur-md">
          <button
            type="button"
            aria-label={previousLabel}
            title={previousLabel}
            disabled={!canGoPrevious}
            onClick={(event) => handleNavigationClick(event, onPrevious)}
            className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <div className="min-w-14 px-1 text-center font-mono text-[10px] font-semibold leading-none text-muted-foreground tabular-nums">
            {position} / {itemCount}
          </div>
          <button
            type="button"
            aria-label={nextLabel}
            title={nextLabel}
            data-navigation-attention={nextAttention ? 'true' : undefined}
            disabled={!canGoNext}
            onClick={(event) => handleNavigationClick(event, onNext)}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,box-shadow,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35",
              nextAttention && "bg-[hsl(var(--app-accent-soft)/0.72)] text-[hsl(var(--app-accent))] shadow-[0_0_0_3px_hsl(var(--app-accent)/0.12)] motion-safe:animate-pulse",
            )}
          >
            <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
