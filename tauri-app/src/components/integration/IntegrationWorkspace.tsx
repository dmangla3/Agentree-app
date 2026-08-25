import React from 'react';
import { 
  X, 
  GitMerge, 
  AlertTriangle, 
  Loader2
} from 'lucide-react';
import { useIntegrationStore } from '../../stores/integrationStore';
import { Separator } from '../../../@/components/ui/separator';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { useEmbeddedIntegrationHotkeys, useIntegrationWorkspaceHotkeys } from '../../hotkeys/integrationHotkeys';

// Stage Components
import { SetupStage } from './SetupStage';
import { ResultStage } from './ResultStage';

// ═══════════════════════════════════════════════════════════════════════════
// SESSION HEADER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface SessionHeaderProps {
  onClose?: () => void;
  closeSessionOnClose?: boolean;
}

function SessionHeader({ onClose, closeSessionOnClose = true }: SessionHeaderProps) {
  const { session, closeMergeSession, isApplying } = useIntegrationStore();
  
  if (!session) return null;
  
  const sourceCount = session.sources.length;
  const sourceLabel = sourceCount === 1 
    ? session.sources[0]?.label || 'Source'
    : `${sourceCount} sources`;
  const targetLabel = session.target?.label || 'Target';
  const targetSha = session.target?.commitSha ? session.target.commitSha.slice(0, 7) : null;
  
  const handleClose = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (closeSessionOnClose) {
      closeMergeSession();
    }
    if (onClose) {
      onClose();
    }
  };
  
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.78)] px-3 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-graph-commit)/0.22)] bg-[hsl(var(--app-graph-commit)/0.1)] text-[hsl(var(--app-graph-commit))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
          <GitMerge className="h-4 w-4" strokeWidth={1.9} />
        </div>
        <div className="min-w-0">
          <h2 className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold leading-5 text-foreground">
            <span className="max-w-[18rem] truncate">{sourceLabel}</span>
            <span className="text-muted-foreground">into</span>
            <span className="max-w-[18rem] truncate">{targetLabel}</span>
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="rounded-full border border-[hsl(var(--app-border)/0.56)] bg-[hsl(var(--app-bg-muted)/0.48)] px-1.5 py-0.5 font-medium leading-none">
              {session.resolutionMode === 'manual' && 'Manual resolution'}
              {session.resolutionMode === 'smart' && 'Smart AI resolution'}
            </span>
            {targetSha ? <span className="font-mono tabular-nums">{targetSha}</span> : null}
          </div>
        </div>
      </div>
      
      <div className="flex shrink-0 items-center gap-2">
        {isApplying && (
          <div className="flex items-center gap-2 rounded-full border border-[hsl(var(--app-warning)/0.24)] bg-[hsl(var(--app-warning)/0.1)] px-2.5 py-1 text-xs font-medium text-[hsl(var(--app-warning))]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Applying</span>
          </div>
        )}
        <button
          type="button"
          onClick={(e) => handleClose(e)}
          disabled={isApplying}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium text-muted-foreground transition-[background-color,color,transform,opacity] duration-150 hover:bg-[hsl(var(--app-bg-muted)/0.78)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label="Close merge panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR BANNER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

function ErrorBanner() {
  const { applyError, isApplying } = useIntegrationStore();
  
  if (!applyError || isApplying) return null;
  
  return (
    <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>{applyError}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE RENDERER (shared between full-screen and embedded)
// ═══════════════════════════════════════════════════════════════════════════

function useStageRenderer() {
  const { session, moveToStage } = useIntegrationStore();
  
  const renderStage = () => {
    if (!session) return null;
    
    switch (session.stage) {
      case 'setup':
        return <SetupStage />;
      case 'smart-resolution':
        return <SetupStage />;
      case 'result':
        return <ResultStage />;
      default:
        return <SetupStage />;
    }
  };
  
  return { session, renderStage, moveToStage };
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBEDDED WORKSPACE (for use in right panel tab)
// ═══════════════════════════════════════════════════════════════════════════

interface EmbeddedIntegrationWorkspaceProps {
  onClose?: () => void;
}

export function EmbeddedIntegrationWorkspace({ onClose }: EmbeddedIntegrationWorkspaceProps) {
  const { session, renderStage } = useStageRenderer();
  const { closeMergeSession, isApplying } = useIntegrationStore();
  const handleEmbeddedClose = React.useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    closeMergeSession();
  }, [closeMergeSession, onClose]);
  
  useEmbeddedIntegrationHotkeys({
    isApplying,
    close: handleEmbeddedClose,
  });
  
  if (!session) return null;
  
  return (
    <div className="flex h-full flex-col bg-[hsl(var(--app-bg))]">
      <SessionHeader onClose={handleEmbeddedClose} closeSessionOnClose={false} />
      
      <ErrorBanner />
      
      <div className="relative flex flex-1 flex-col overflow-hidden px-3 pt-3">
        {renderStage()}
      </div>
      
      {/* Status Bar */}
      <div className="border-t border-[hsl(var(--app-border)/0.56)] bg-[hsl(var(--app-panel)/0.62)] px-3 py-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium">
            {session.sources.length} source{session.sources.length !== 1 ? 's' : ''} • 
            {' '}{session.fileDecisions.length} file{session.fileDecisions.length !== 1 ? 's' : ''}
        </span>
          <span className="font-mono tabular-nums">
            {new Date(session.updatedAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WORKSPACE COMPONENT (full-screen overlay for legacy/multi-select)
// ═══════════════════════════════════════════════════════════════════════════

export function IntegrationWorkspace() {
  const { isMergeOpen, session, closeMergeSession, isApplying } = useIntegrationStore();
  const { renderStage } = useStageRenderer();
  
  useIntegrationWorkspaceHotkeys({
    isOpen: isMergeOpen,
    isApplying,
    close: closeMergeSession,
  });
  
  if (!isMergeOpen || !session) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div 
        className="flex-1 bg-black/40 backdrop-blur-sm cursor-pointer"
        onClick={() => {
          // Only close if not applying
          if (!isApplying) closeMergeSession();
        }}
      />
      
      {/* Panel */}
      <div className="flex w-full max-w-5xl flex-col border-l bg-background shadow-2xl">
        <SessionHeader onClose={undefined} />

        <Separator />
        
        <ErrorBanner />
        
        <ScrollArea className="flex-1">
          <div className="p-6">
            {renderStage()}
          </div>
        </ScrollArea>
        
        {/* Status Bar */}
        <div className="border-t bg-muted/50 px-4 py-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {session.sources.length} source{session.sources.length !== 1 ? 's' : ''} • 
              {' '}{session.fileDecisions.length} file{session.fileDecisions.length !== 1 ? 's' : ''}
            </span>
            <span>
              {new Date(session.updatedAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IntegrationWorkspace;
