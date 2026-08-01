import React from 'react';
import { 
  X, 
  GitMerge, 
  ChevronRight, 
  Check, 
  AlertTriangle, 
  Loader2,
  Settings2,
  Sparkles,
  Flag,
  ArrowRight
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useIntegrationStore, IntegrationStage } from '../../stores/integrationStore';
import { Separator } from '../../../@/components/ui/separator';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../../../@/components/ui/hover-card';

// Stage Components
import { SetupStage } from './SetupStage';
import { SmartResolutionStage } from './SmartResolutionStage';
import { ResultStage } from './ResultStage';

// ═══════════════════════════════════════════════════════════════════════════
// STAGE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const STAGES: { 
  id: IntegrationStage; 
  label: string; 
  description: string;
  tooltip: string;
  icon: React.ElementType;
  color: string;
}[] = [
  { 
    id: 'setup', 
    label: 'Setup', 
    description: 'Select target and sources',
    tooltip: 'Choose the target commit (base) and one or more source commits to merge into it. The target remains as the base, while sources bring their changes.',
    icon: Settings2,
    color: 'text-blue-600 bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800'
  },
  { 
    id: 'smart-resolution', 
    label: 'AI Resolve', 
    description: 'Review and apply merge',
    tooltip: 'Generate the merge preview, run an AI agent review for semantic conflicts, choose resolution options, and apply the final merge from the same page.',
    icon: Sparkles,
    color: 'text-violet-600 bg-violet-50 border-violet-200 dark:bg-violet-950/30 dark:border-violet-800'
  },
  { 
    id: 'result', 
    label: 'Result', 
    description: 'Finalize and summarize',
    tooltip: 'View the completed merge commit, see AI summary of changes, review resolved decisions, and optionally promote a branch pointer to reference the new commit.',
    icon: Flag,
    color: 'text-rose-600 bg-rose-50 border-rose-200 dark:bg-rose-950/30 dark:border-rose-800'
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// STAGE INDICATOR COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

function StageIndicator({ 
  currentStage, 
  onStageClick 
}: { 
  currentStage: IntegrationStage;
  onStageClick?: (stage: IntegrationStage) => void;
}) {
  const currentIndex = STAGES.findIndex((s) => s.id === currentStage);
  
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      {STAGES.map((stage, index) => {
        const isActive = stage.id === currentStage;
        const isCompleted = index < currentIndex;
        const isPending = index > currentIndex;
        
        return (
          <React.Fragment key={stage.id}>
            <HoverCard openDelay={500} closeDelay={100}>
              <HoverCardTrigger asChild>
                <button
                  onClick={() => onStageClick?.(stage.id)}
                  disabled={isPending}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                    isActive && 'bg-primary text-primary-foreground',
                    isCompleted && 'text-primary hover:bg-primary/10',
                    isPending && 'cursor-not-allowed text-muted-foreground opacity-50'
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full border text-[10px]">
                      {index + 1}
                    </span>
                  )}
                  <span className="hidden sm:inline">{stage.label}</span>
                </button>
              </HoverCardTrigger>
              <HoverCardContent 
                side="bottom" 
                align="center"
                className="w-80 p-0 overflow-hidden border-border/50 shadow-xl"
              >
                <div className="bg-gradient-to-br from-muted/50 to-background p-4">
                  {/* Header with icon */}
                  <div className="flex items-start gap-3 mb-3">
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-sm",
                      stage.color
                    )}>
                      <stage.icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground">
                          {stage.label}
                        </span>
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                          {index + 1}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Step {index + 1} of {STAGES.length}
                      </p>
                    </div>
                  </div>
                  
                  {/* Divider */}
                  <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent my-3" />
                  
                  {/* Description */}
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {stage.tooltip}
                  </p>
                  
                  {/* Next step hint */}
                  {index < STAGES.length - 1 && (
                    <>
                      <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent my-3" />
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
                        <ArrowRight className="h-3 w-3" />
                        <span>Next: {STAGES[index + 1].label}</span>
                      </div>
                    </>
                  )}
                </div>
              </HoverCardContent>
            </HoverCard>
            {index < STAGES.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

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
        return <SmartResolutionStage />;
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
  const { session, renderStage, moveToStage } = useStageRenderer();
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
      
      <StageIndicator 
        currentStage={session.stage} 
        onStageClick={(stage) => {
          // Only allow navigating to previous stages or current stage
          const currentIndex = STAGES.findIndex((s) => s.id === session.stage);
          const targetIndex = STAGES.findIndex((s) => s.id === stage);
          if (targetIndex <= currentIndex) {
            moveToStage(stage);
          }
        }}
      />
      
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
  const { renderStage, moveToStage } = useStageRenderer();
  
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
        
        <StageIndicator 
          currentStage={session.stage} 
          onStageClick={(stage) => {
            // Only allow navigating to previous stages or current stage
            const currentIndex = STAGES.findIndex((s) => s.id === session.stage);
            const targetIndex = STAGES.findIndex((s) => s.id === stage);
            if (targetIndex <= currentIndex) {
              moveToStage(stage);
            }
          }}
        />
        
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
