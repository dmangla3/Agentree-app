import type { QueryClient } from '@tanstack/react-query';
import { agentClient } from '../../lib/agentClient';
import type { Message } from '../../stores/workspaceStore';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from '../../hooks/useLocalNodes';

interface PersistMergeResultNodeInput {
  queryClient: QueryClient;
  workspaceId: string;
  resultNodeId: string;
  parentId: string | null;
  content: string;
  commitSha: string;
  aiLabel: string;
  executionData: unknown;
}

export const persistMergeResultNodeLocally = async ({
  queryClient,
  workspaceId,
  resultNodeId,
  parentId,
  content,
  commitSha,
  aiLabel,
  executionData,
}: PersistMergeResultNodeInput): Promise<Message> => {
  const now = new Date().toISOString();
  const message: Message = {
    id: resultNodeId,
    role: 'assistant',
    content,
    parentId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
    status: 'completed',
    aiLabel,
    output_commit_sha: commitSha,
    git_branch_name: null,
    execution_data: executionData,
  };

  if (agentClient.hasRuntime()) {
    await agentClient.upsertLocalNode(workspaceId, resultNodeId, message);
    queryClient.setQueryData<LocalNodeMessage[]>(
      localNodeKeys.workspace(workspaceId),
      (current) => upsertMessagesIntoLocalNodeCache(current, workspaceId, [message], {
        syncStatus: 'local_only',
      }),
    );
  }

  queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
    const existing = current ?? [];
    return [
      ...existing.filter((item) => item.id !== resultNodeId),
      message,
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  });

  return message;
};
