import type { LocalNodeMessage } from '../hooks/useLocalNodes';
import type { GraphSnapshot } from '../hooks/useGraphSnapshot';
import type { Message } from '../stores/workspaceStore';

export type FinalizeCachePatch = {
  nodeId: string;
  status: string;
  outputCommitSha?: string | null;
  gitBranchName?: string | null;
  commitCreated?: boolean | null;
  persisted?: boolean | null;
  serverAckAt?: string | number | null;
  updatedAt?: string;
};

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const RECOVERY_DIAGNOSTIC_KEYS = [
  'failure_reason',
  'needs_user_action_reason',
  'provider_error_message',
  'native_recovery_status',
] as const;

const scrubSuccessfulRecoveryDiagnostics = <T extends Record<string, any>>(value: T): T => {
  const next = { ...value };
  for (const key of RECOVERY_DIAGNOSTIC_KEYS) {
    delete next[key];
  }
  return next;
};

const patchFinalizedMessage = <T extends Partial<Message> & { id: string }>(
  message: T,
  patch: FinalizeCachePatch,
): T => {
  const outputCommitSha = cleanString(patch.outputCommitSha) ?? cleanString(message.output_commit_sha);
  const executionData = ((message.execution_data ?? {}) as Record<string, any>);
  const meta = ((executionData.meta ?? {}) as Record<string, any>);
  const shouldScrubRecoveryDiagnostics = patch.status === 'completed';
  const baseExecutionData = shouldScrubRecoveryDiagnostics
    ? scrubSuccessfulRecoveryDiagnostics(executionData)
    : executionData;
  const baseMeta = shouldScrubRecoveryDiagnostics
    ? scrubSuccessfulRecoveryDiagnostics(meta)
    : meta;
  const nextExecutionData: Record<string, any> = {
    ...baseExecutionData,
    last_terminal_status: patch.status,
    meta: {
      ...baseMeta,
      ...(outputCommitSha ? { output_commit_sha: outputCommitSha } : {}),
      ...(patch.commitCreated !== undefined && patch.commitCreated !== null
        ? { commit_created: patch.commitCreated }
        : {}),
      ...(patch.gitBranchName ? { git_branch_name: patch.gitBranchName } : {}),
      ...(patch.persisted !== undefined && patch.persisted !== null
        ? { persisted: patch.persisted }
        : {}),
      ...(patch.serverAckAt !== undefined && patch.serverAckAt !== null
        ? { server_ack_at: patch.serverAckAt }
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

const normalizeServerAckAt = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
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
    const serverAckAt = normalizeServerAckAt(patch.serverAckAt);
    return {
      ...local,
      ...(patch.persisted === true ? { syncStatus: 'persisted' as const } : {}),
      ...(serverAckAt !== null ? { serverAckAt } : {}),
      message: patchFinalizedMessage(local.message, patch),
    };
  });
  return changed ? next : current;
};

export const patchFinalizedGraphSnapshot = (
  current: GraphSnapshot | undefined,
  patch: FinalizeCachePatch,
): GraphSnapshot | undefined => {
  if (!current) return current;
  let changed = false;
  const messages = current.messages.map((message) => {
    if (message.id !== patch.nodeId) return message;
    changed = true;
    return patchFinalizedMessage(message as typeof message & { id: string }, patch);
  });
  return changed ? { ...current, messages } : current;
};
