import type { LocalNodeMessage } from '../hooks/useLocalNodes';
import type { Message } from '../stores/workspaceStore';

export type FinalizeCachePatch = {
  nodeId: string;
  status: string;
  outputCommitSha?: string | null;
  gitBranchName?: string | null;
  commitCreated?: boolean | null;
  updatedAt?: string;
};

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const patchFinalizedMessage = <T extends Partial<Message> & { id: string }>(
  message: T,
  patch: FinalizeCachePatch,
): T => {
  const outputCommitSha = cleanString(patch.outputCommitSha) ?? cleanString(message.output_commit_sha);
  const executionData = ((message.execution_data ?? {}) as Record<string, any>);
  const meta = ((executionData.meta ?? {}) as Record<string, any>);
  const nextExecutionData: Record<string, any> = {
    ...executionData,
    last_terminal_status: patch.status,
    meta: {
      ...meta,
      ...(outputCommitSha ? { output_commit_sha: outputCommitSha } : {}),
      ...(patch.commitCreated !== undefined && patch.commitCreated !== null
        ? { commit_created: patch.commitCreated }
        : {}),
    },
  };

  if (outputCommitSha) {
    nextExecutionData.output_commit_sha = outputCommitSha;
  }

  return {
    ...message,
    status: patch.status as any,
    updatedAt: patch.updatedAt ?? message.updatedAt,
    execution_data: nextExecutionData as any,
    output_commit_sha: outputCommitSha ?? message.output_commit_sha ?? null,
    git_branch_name: patch.gitBranchName ?? message.git_branch_name ?? null,
  };
};

export const patchFinalizedMessages = (
  current: Message[] | undefined,
  patch: FinalizeCachePatch,
): Message[] | undefined => {
  if (!current) return current;
  let changed = false;
  const next = current.map((message) => {
    if (message.id !== patch.nodeId) return message;
    changed = true;
    return patchFinalizedMessage(message, patch);
  });
  return changed ? next : current;
};

export const patchFinalizedLocalNodes = (
  current: LocalNodeMessage[] | undefined,
  patch: FinalizeCachePatch,
): LocalNodeMessage[] | undefined => {
  if (!current) return current;
  let changed = false;
  const next = current.map((local) => {
    if (local.nodeId !== patch.nodeId || local.message.id !== patch.nodeId) return local;
    changed = true;
    return {
      ...local,
      message: patchFinalizedMessage(local.message, patch),
    };
  });
  return changed ? next : current;
};
