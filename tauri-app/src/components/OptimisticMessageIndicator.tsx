import { Loader2, AlertCircle, Clock } from 'lucide-react';
import { cn } from '../lib/utils';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';

interface OptimisticMessageIndicatorProps {
  message: AgentRunProjectedMessage;
  className?: string;
}

/**
 * Indicator for optimistic message states
 * Shows loading spinner, progress text, or error state
 */
export function OptimisticMessageIndicator({ message, className }: OptimisticMessageIndicatorProps) {
  const status = message._optimisticStatus;
  const progress = message._setupProgress;
  const error = message._optimisticError;

  // Error state
  if (status === 'failed' || error) {
    return (
      <div className={cn(
        "flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive",
        className
      )}>
        <AlertCircle size={14} aria-hidden="true" />
        <span className="font-medium">Failed</span>
        {error && (
          <span className="text-destructive/80 text-xs ml-1 truncate max-w-[200px]">
            {error}
          </span>
        )}
      </div>
    );
  }

  // Pending/Initializing state
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-sm text-primary/80",
      className
    )}>
      {status === 'running' ? (
        <Clock size={14} className="animate-pulse motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      <span className="font-medium">
        {progress || 'Processing...'}
      </span>
    </div>
  );
}

/**
 * Badge variant for compact display
 */
export function OptimisticBadge({ message }: { message: AgentRunProjectedMessage }) {
  const status = message._optimisticStatus;
  
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
        <AlertCircle size={10} aria-hidden="true" />
        Failed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
      <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {status === 'pending' && 'Sending'}
      {status === 'creating' && 'Creating'}
      {status === 'initializing' && 'Initializing'}
      {status === 'running' && 'Running'}
    </span>
  );
}

/**
 * Check if a message is in an optimistic state
 */
export function isOptimisticMessage(message: unknown): message is AgentRunProjectedMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    '_optimistic' in message &&
    (message as AgentRunProjectedMessage)._optimistic === true
  );
}

/**
 * Get display state for optimistic message
 */
export function getOptimisticDisplayState(message: AgentRunProjectedMessage): {
  isOptimistic: boolean;
  showIndicator: boolean;
  indicatorPosition: 'header' | 'footer' | 'overlay';
} {
  if (!message._optimistic) {
    return { isOptimistic: false, showIndicator: false, indicatorPosition: 'footer' };
  }

  const status = message._optimisticStatus;
  
  // Show indicator for all non-completed optimistic states
  const showIndicator = status !== 'completed';
  
  // Position based on role and status
  const indicatorPosition = message.role === 'assistant' ? 'header' : 'footer';

  return { isOptimistic: true, showIndicator, indicatorPosition };
}
