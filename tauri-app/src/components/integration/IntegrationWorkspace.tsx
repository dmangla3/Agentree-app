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

// Stage Components
import { SetupStage } from './SetupStage';
import { ResultStage } from './ResultStage';

// ═══════════════════════════════════════════════════════════════════════════
// SESSION HEADER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface SessionHeaderProps {
  onClose?: () => void;
}

function SessionHeader({ onClose }: SessionHeaderProps) {
  const { session, closeMergeSession, isApplying } = useIntegrationStore();
  
  if (!session) return null;
  
  const sourceCount = session.sources.length;
  const sourceLabel = sourceCount === 1 
    ? session.sources[0]?.label || 'Source'
    : `${sourceCount} sources`;
  const targetLabel = session.target?.label || 'Target';
  
  const handleClose = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    console.log('[IntegrationWorkspace] Close button clicked, onClose exists:', !!onClose);
    closeMergeSession();
    if (onClose) {
      console.log('[IntegrationWorkspace] Calling onClose callback');
      onClose();
    } else {
      console.log('[IntegrationWorkspace] No onClose callback provided');
    }
  };
  
  return (
    <div className="flex items-center justify-between border-b bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <GitMerge className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">
            {sourceLabel} <span className="text-muted-foreground">→</span> {targetLabel}
          </h2>
          <p className="text-xs text-muted-foreground">
            {session.resolutionMode === 'manual' && 'Manual resolution'}
            {session.resolutionMode === 'smart' && 'Smart AI resolution'}
          </p>
        </div>
      </div>
      
      <div className="flex items-center gap-2">
        {isApplying && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Applying...</span>
          </div>
        )}
        <button
          type="button"
          onClick={(e) => handleClose(e)}
          disabled={isApplying}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
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
    <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
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
  
  // Handle escape key to close
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isApplying) {
        closeMergeSession();
        onClose?.();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isApplying, closeMergeSession, onClose]);
  
  if (!session) return null;
  
  return (
    <div className="flex h-full flex-col bg-background">
      <SessionHeader onClose={onClose} />

      <Separator />
      
      <ErrorBanner />
      
      <div className="flex-1 overflow-hidden relative flex flex-col px-4 pt-4">
        {renderStage()}
      </div>
      
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
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WORKSPACE COMPONENT (full-screen overlay for legacy/multi-select)
// ═══════════════════════════════════════════════════════════════════════════

export function IntegrationWorkspace() {
  const { isMergeOpen, session, closeMergeSession, isApplying } = useIntegrationStore();
  const { renderStage } = useStageRenderer();
  
  // Handle escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isApplying) {
        closeMergeSession();
      }
    };
    
    if (isMergeOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isMergeOpen, isApplying, closeMergeSession]);
  
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
