import type { QueryClient } from '@tanstack/react-query';
import type { Workspace } from '../stores/workspaceStore';
import { bootstrapWorkspaceInitialGitImport } from './workspaceInitialImport';

interface FinalizeCreatedWorkspaceParams {
  created: Workspace;
  fallbackFolderPath: string;
  queryClient: QueryClient;
  selectWorkspace: (workspaceId: string) => void;
  dispatchFocus: (input: {
    messageId: string | null;
    source: 'system';
    metadata?: Record<string, unknown>;
  }) => void;
  onImportFailed?: (error: unknown) => void;
}

export async function finalizeCreatedWorkspace({
  created,
  fallbackFolderPath,
  queryClient,
  selectWorkspace,
  dispatchFocus,
  onImportFailed,
}: FinalizeCreatedWorkspaceParams): Promise<{ focusedMessageId: string | null; importedCount: number }> {
  selectWorkspace(created.id);

  const repoPath = created.git_repo_path || created.repo_path || created.folderPath || fallbackFolderPath;
  if (!repoPath) {
    return { focusedMessageId: null, importedCount: 0 };
  }

  try {
    const result = await bootstrapWorkspaceInitialGitImport({
      workspaceId: created.id,
      repoPath,
      queryClient,
    });

    if (result.focusedMessageId) {
      dispatchFocus({
        messageId: result.focusedMessageId,
        source: 'system',
        metadata: { reason: 'workspace-initial-import' },
      });
    }

    return result;
  } catch (error) {
    onImportFailed?.(error);
    return { focusedMessageId: null, importedCount: 0 };
  }
}
