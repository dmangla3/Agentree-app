import type { Workspace } from '../stores/workspaceStore';

export function resolveLocalWorkspaceRepoPath(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  const connectionStatus = workspace.connection_status ?? workspace.connectionStatus ?? 'connected';
  if (connectionStatus !== 'connected') return null;
  return workspace.local_repo_path?.trim() || workspace.localRepoPath?.trim() || null;
}

