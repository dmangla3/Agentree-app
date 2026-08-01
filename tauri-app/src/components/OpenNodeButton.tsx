import { useState, useCallback } from 'react';
import { useNodeTerminalAction } from '../hooks/useNodeTerminalAction';
import { OpenInAppButton } from './OpenInAppButton';
import { cn } from '../lib/utils';
import { Button } from '../../@/components/ui/button';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Message } from '../stores/workspaceStore';

interface OpenNodeButtonProps {
  nodeId: string;
  nodeStatus?: string | null;
  workspaceId?: string | null;
  repoPath?: string | null;
  message?: Message | null;
  className?: string;
  compact?: boolean;
}

/**
 * Button that resolves the best repository/worktree path for a node, then shows
 * the OpenInAppButton dropdown to pick an editor or terminal.
 */
export function OpenNodeButton({
  nodeId,
  nodeStatus,
  workspaceId,
  repoPath,
  message,
  className,
  compact = false,
}: OpenNodeButtonProps) {
  const { resolveNodeMountPath, handleTerminalError, showWorkspaceFeatures } = useNodeTerminalAction();
  const [mountPath, setMountPath] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const handleResolve = useCallback(async () => {
    setResolving(true);
    try {
      const path = await resolveNodeMountPath({
        nodeId,
        nodeStatus,
        workspaceId,
        repoPath,
        message,
      });
      if (path) setMountPath(path);
    } catch (e) {
      handleTerminalError(e);
    } finally {
      setResolving(false);
    }
  }, [nodeId, nodeStatus, workspaceId, repoPath, message, resolveNodeMountPath, handleTerminalError]);

  if (!showWorkspaceFeatures) return null;

  // Once a path is resolved, show the app picker.
  if (mountPath) {
    return <OpenInAppButton path={mountPath} compact={compact} className={className} />;
  }

  // Before resolution, show a simple "Open" button.
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleResolve}
      disabled={resolving || !repoPath}
      className={cn(
        compact
          ? 'h-6 text-[10px] px-2 gap-1'
          : 'h-7 text-xs px-2.5 gap-1.5',
        'hover:bg-primary/5 hover:text-primary hover:border-primary/30 transition-colors',
        className
      )}
      title={!repoPath ? 'No repository attached' : 'Open repository or worktree'}
    >
      {resolving ? (
        <Loader2 size={compact ? 10 : 12} className="animate-spin" />
      ) : (
        <ExternalLink size={compact ? 10 : 12} />
      )}
      {resolving ? 'Opening...' : 'Open'}
    </Button>
  );
}
