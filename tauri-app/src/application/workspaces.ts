import type { Workspace } from '../stores/workspaceStore';
import { agentClient, type LocalWorkspaceRecord } from '../lib/agentClient';
import { AGENTREE_DATA_PLANE_ENABLED, api } from '../lib/api';
import { isTauriEnvironment } from '../hooks/useTauriWorkspace';

export interface CreateWorkspaceInput {
  workspaceId: string;
  name: string;
  folderPath: string;
  repoPath: string;
  baseCommitSha: string | null;
}

export interface ReconnectWorkspaceInput {
  workspaceId: string;
  folderPath: string;
  repoPath: string;
  baseCommitSha: string | null;
}

export function workspaceFromLocalRecord(record: LocalWorkspaceRecord): Workspace {
  const localRepoPath = record.localRepoPath ?? null;
  return {
    id: record.id,
    name: record.name,
    userId: record.userId,
    folderPath: localRepoPath,
    repo_path: localRepoPath,
    git_repo_path: localRepoPath,
    local_repo_path: localRepoPath,
    localRepoPath,
    connection_status: record.connectionStatus,
    connectionStatus: record.connectionStatus,
    sync_status: record.syncStatus,
    syncStatus: record.syncStatus,
    cloud_backup_enabled: record.cloudBackupEnabled,
    cloudBackupEnabled: record.cloudBackupEnabled,
    cloudAccountId: record.cloudAccountId ?? null,
    base_commit_sha: record.baseCommitSha ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const list = async ({
  cloudAccountId,
  cloudConnected,
}: {
  cloudAccountId: string | null;
  cloudConnected: boolean;
}): Promise<Workspace[]> => {
  if (isTauriEnvironment()) {
    const localWorkspaces = await agentClient.listLocalWorkspaces(cloudAccountId);
    if (!AGENTREE_DATA_PLANE_ENABLED || !cloudConnected || !cloudAccountId) {
      return localWorkspaces.map(workspaceFromLocalRecord);
    }
    try {
      const response = await api.get('/workspaces');
      if (!Array.isArray(response.data)) return localWorkspaces.map(workspaceFromLocalRecord);
      const merged = await agentClient.mergeServerWorkspaces(response.data, cloudAccountId);
      return merged.map(workspaceFromLocalRecord);
    } catch (error) {
      console.warn('[workspaceApplication] Cloud workspace merge failed; using local workspaces.', error);
      return localWorkspaces.map(workspaceFromLocalRecord);
    }
  }

  const [response, deletedWorkspaceIds] = await Promise.all([
    api.get('/workspaces'),
    agentClient.listLocalDeletedWorkspaceIds(),
  ]);
  if (!Array.isArray(response.data) || deletedWorkspaceIds.length === 0) {
    return Array.isArray(response.data) ? response.data : [];
  }
  const deleted = new Set(deletedWorkspaceIds);
  return response.data.filter((workspace: Workspace) => !deleted.has(workspace.id));
};

const create = async (input: CreateWorkspaceInput): Promise<Workspace> => {
  if (!isTauriEnvironment()) {
    throw new Error('Workspace creation requires the Agentree desktop app.');
  }
  return workspaceFromLocalRecord(await agentClient.localFirstCreateWorkspace({
    workspaceId: input.workspaceId,
    name: input.name,
    localRepoPath: input.repoPath,
    baseCommitSha: input.baseCommitSha,
    repoFingerprint: input.baseCommitSha ? `base:${input.baseCommitSha}` : null,
    mutationId: `workspace.create:${input.workspaceId}`,
  }));
};

const rename = async (workspaceId: string, name: string): Promise<Workspace> => {
  if (isTauriEnvironment()) {
    return workspaceFromLocalRecord(
      await agentClient.localFirstRenameWorkspace(workspaceId, name),
    );
  }
  const response = await api.patch(`/workspaces/${workspaceId}`, { name });
  return response.data;
};

const reconnect = async (input: ReconnectWorkspaceInput): Promise<Workspace> => {
  if (isTauriEnvironment()) {
    return workspaceFromLocalRecord(await agentClient.localFirstReconnectWorkspace({
      workspaceId: input.workspaceId,
      localRepoPath: input.repoPath,
      baseCommitSha: input.baseCommitSha,
      repoFingerprint: input.baseCommitSha ? `base:${input.baseCommitSha}` : null,
      mutationId: `workspace.reconnect:${input.workspaceId}:${Date.now()}`,
    }));
  }
  const response = await api.patch(`/workspaces/${input.workspaceId}`, {
    folderPath: input.folderPath,
    repoPath: input.repoPath,
    baseCommitSha: input.baseCommitSha,
  });
  return response.data;
};

const remove = async (workspaceId: string): Promise<void> => {
  if (isTauriEnvironment()) {
    await agentClient.localFirstDeleteWorkspace(workspaceId);
    return;
  }
  await api.delete(`/workspaces/${workspaceId}`);
};

const enableCloudBackup = async (
  workspaceId: string,
  cloudAccountId: string,
): Promise<Workspace> => {
  if (!isTauriEnvironment()) {
    throw new Error('Workspace cloud sync is available in the Agentree desktop app.');
  }
  return workspaceFromLocalRecord(
    await agentClient.enableWorkspaceCloudBackup(workspaceId, cloudAccountId),
  );
};

export const workspaceApplication = {
  isDesktop: isTauriEnvironment,
  list,
  create,
  rename,
  reconnect,
  remove,
  enableCloudBackup,
};
