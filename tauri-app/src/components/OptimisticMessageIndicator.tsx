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
        "flex items-center gap-2 px-3 py-1.5 rounded-md",
        "bg-destructive/10 text-destructive text-sm",
        className
      )}>
        <AlertCircle size={14} />
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
      "flex items-center gap-2 px-3 py-1.5 rounded-md",
      "bg-primary/5 text-primary/80 text-sm",
      className
    )}>
      {status === 'running' ? (
        <Clock size={14} className="animate-pulse" />
      ) : (
        <Loader2 size={14} className="animate-spin" />
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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-destructive/10 text-destructive">
        <AlertCircle size={10} />
        Failed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary animate-pulse">
      <Loader2 size={10} className="animate-spin" />
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
