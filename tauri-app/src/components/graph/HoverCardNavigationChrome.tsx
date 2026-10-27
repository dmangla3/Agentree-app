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
      className="flex h-8 w-fit max-w-full items-center gap-1 rounded-full border border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-panel)/0.96)] p-0.5 shadow-[0_10px_24px_-18px_hsl(var(--foreground)/0.54),inset_0_1px_0_hsl(var(--background)/0.18)] backdrop-blur-md"
      onPointerDown={stopNavigationPropagation}
      onMouseDown={stopNavigationPropagation}
      onClick={stopNavigationPropagation}
    >
      {accessory || announcement ? (
        <div className="flex min-w-0 items-center gap-1">
          {accessory}
          {announcement ? (
            <span className="sr-only" aria-live="polite">{announcement}</span>
          ) : null}
        </div>
      ) : null}
      {showControls ? (
        <div className="flex h-7 shrink-0 items-center">
          <button
            type="button"
            aria-label={previousLabel}
            title={previousLabel}
            disabled={!canGoPrevious}
            onClick={(event) => handleNavigationClick(event, onPrevious)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <div className="min-w-10 px-0.5 text-center font-mono text-[9px] font-semibold leading-none text-muted-foreground tabular-nums">
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
              "flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,box-shadow,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35",
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
