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
              'pointer-events-auto group flex h-10 items-center gap-2 rounded-full border border-[hsl(var(--app-border)/0.82)]',
              'bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-panel)/0.92))] px-3 text-xs font-semibold text-foreground',
              'shadow-[0_18px_50px_-28px_hsl(34_28%_18%/0.52),inset_0_1px_0_hsl(44_80%_99%/0.74)] backdrop-blur-xl',
              'transition-[background-color,box-shadow,transform] duration-200 ease-out',
              'hover:-translate-y-0.5 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel-strong)/0.98)]',
              'active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]'
            )}
            onClick={() => setIsCollapsed(false)}
            aria-label="Expand graph composer"
            title="Expand graph composer"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[hsl(var(--app-accent-soft)/0.78)] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.12)]">
              <MessageSquareText className="h-3.5 w-3.5" />
            </span>
            <span>Compose</span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5" />
          </button>
        </div>
      ) : null}
      <div
        data-testid="graph-composer-dock"
        className="pointer-events-none absolute inset-x-0 bottom-4 z-[45] px-3 sm:px-6"
        hidden={isCollapsed}
        aria-hidden={isCollapsed}
      >
        <div className="pointer-events-auto mx-auto mb-1 flex w-[min(50rem,calc(100vw-1rem))] max-w-4xl justify-end sm:w-[min(50rem,calc(100vw-7rem))]">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.92)] text-muted-foreground shadow-[0_10px_28px_-24px_hsl(34_28%_18%/0.58),inset_0_1px_0_hsl(44_80%_99%/0.58)] backdrop-blur-xl transition-[background-color,color,transform] duration-150 hover:-translate-y-0.5 hover:bg-[hsl(var(--app-panel-strong))] hover:text-foreground active:translate-y-0 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]"
            onClick={() => setIsCollapsed(true)}
            aria-label="Collapse graph composer"
            title="Collapse graph composer"
          >
            <Minimize2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <GraphDockComposer />
      </div>
    </>
  );
}
