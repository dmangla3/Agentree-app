import { useCallback } from 'react';
import { shouldShowWorkspaceFeatures } from './useTauriWorkspace';
import { useToast } from '../components/Toast';
import type { Message } from '../stores/workspaceStore';
import { getGitWorktreePath } from '../lib/gitNodeUtils';

export interface OpenNodeArgs {
  nodeId: string;
  nodeStatus?: string | null;
  workspaceId?: string | null;
  repoPath?: string | null;
  message?: Message | null;
}

export function useNodeTerminalAction() {
  const { addToast } = useToast();
  const showWorkspaceFeatures = shouldShowWorkspaceFeatures();

  const openTerminal = useCallback(async (targetPath: string) => {
    const { Command } = await import('@tauri-apps/plugin-shell');
    await Command.create('open', ['-a', 'Terminal', targetPath]).execute();
  }, []);

  /**
   * Resolves the best local path for a node, preferring an active git worktree.
   * Does NOT open any app — caller decides what to do with the path.
   */
  const resolveNodeMountPath = useCallback(async ({
    repoPath,
    message,
  }: OpenNodeArgs): Promise<string | null> => {
    if (!showWorkspaceFeatures) return null;

    const worktreePath = getGitWorktreePath(message);
    if (worktreePath) {
      return worktreePath;
    }

    if (repoPath) {
      return repoPath;
    }

    if (!repoPath) {
      addToast({
        title: 'Repository missing',
        description: 'No repository is attached to this workspace.',
        variant: 'error',
      });
    }
    return null;
  }, [showWorkspaceFeatures, addToast]);

  /** Resolve the best local path and open it in Terminal. */
  const openNodeTerminal = useCallback(async (args: OpenNodeArgs) => {
    const targetPath = await resolveNodeMountPath(args);
    if (targetPath) await openTerminal(targetPath);
  }, [openTerminal, resolveNodeMountPath]);

  const handleTerminalError = useCallback((error: unknown) => {
    addToast({
      title: 'Failed to open workspace',
      description: error instanceof Error ? error.message : 'Unable to open workspace for this node.',
      variant: 'error',
      duration: 8000,
    });
  }, [addToast]);

  return {
    openNodeTerminal,
    resolveNodeMountPath,
    handleTerminalError,
    showWorkspaceFeatures,
  };
}
