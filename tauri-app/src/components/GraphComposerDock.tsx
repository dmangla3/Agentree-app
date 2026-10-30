import { ChevronUp, Minimize2, MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GraphDockComposer } from '../composer/GraphDockComposer';
import { cn } from '../lib/utils';
import { GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, GRAPH_COMPOSER_DOCK_EXPAND_EVENT, setGraphComposerDockState } from '../lib/graphComposerDockEvents';

interface GraphComposerDockProps {
  isVisible: boolean;
}

export function GraphComposerDock({ isVisible }: GraphComposerDockProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    if (!isVisible) {
      setIsCollapsed(false);
    }
  }, [isVisible]);

  useEffect(() => {
    setGraphComposerDockState({ isVisible, isCollapsed });
  }, [isCollapsed, isVisible]);

  useEffect(() => {
    const collapse = () => setIsCollapsed(true);
    const expand = () => setIsCollapsed(false);

    window.addEventListener(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, collapse);
    window.addEventListener(GRAPH_COMPOSER_DOCK_EXPAND_EVENT, expand);
    return () => {
      window.removeEventListener(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, collapse);
      window.removeEventListener(GRAPH_COMPOSER_DOCK_EXPAND_EVENT, expand);
    };
  }, []);

  if (!isVisible) return null;

  return (
    <>
      {isCollapsed ? (
        <div
          data-testid="graph-composer-dock-pill-container"
          className="pointer-events-none absolute inset-x-0 bottom-4 z-[45] flex justify-center px-3 sm:px-6"
        >
          <button
            type="button"
            data-testid="graph-composer-dock-pill"
            className={cn(
              'pointer-events-auto group flex h-10 items-center gap-2 rounded-xl border border-[hsl(var(--app-border)/0.76)]',
              'bg-[hsl(var(--app-panel)/0.96)] px-3 text-xs font-semibold text-foreground',
              'shadow-[0_16px_38px_-28px_hsl(var(--foreground)/0.42)] backdrop-blur-xl',
              'transition-[background-color,border-color,box-shadow,transform] duration-normal ease-out-cubic motion-reduce:transition-none',
              'hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel-strong)/0.98)]',
              'active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]'
            )}
            onClick={() => setIsCollapsed(false)}
            aria-label="Expand graph composer"
            title="Expand graph composer"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.78)] text-[hsl(var(--app-accent))]">
              <MessageSquareText className="h-3.5 w-3.5" />
            </span>
            <span>Compose</span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-normal ease-out-cubic motion-reduce:transition-none group-hover:-translate-y-0.5" />
          </button>
        </div>
      ) : null}
      <div
        data-testid="graph-composer-dock"
        className="pointer-events-none absolute inset-x-0 bottom-4 z-[45] px-3 sm:px-6"
        hidden={isCollapsed}
        aria-hidden={isCollapsed}
      >
        <div className="pointer-events-auto relative mx-auto w-[min(50rem,calc(100vw-1rem))] max-w-4xl sm:w-[min(50rem,calc(100vw-7rem))]">
          <button
            type="button"
            className="absolute -top-11 right-0 flex h-10 w-10 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.96)] text-muted-foreground shadow-[0_10px_24px_-22px_hsl(var(--foreground)/0.34)] transition-[background-color,color,transform] duration-normal ease-out-cubic motion-reduce:transition-none hover:bg-[hsl(var(--app-bg-muted))] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]"
            onClick={() => setIsCollapsed(true)}
            aria-label="Collapse graph composer"
            title="Collapse graph composer"
          >
            <Minimize2 className="h-3.5 w-3.5" />
          </button>
          <GraphDockComposer />
        </div>
      </div>
    </>
  );
}
