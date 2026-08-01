import type { BranchPointer, Message } from '../../stores/workspaceStore';

const normalizedString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getExecutionData = (message: Message): Record<string, unknown> | null => {
  const executionData = message.execution_data;
  return executionData && typeof executionData === 'object'
    ? executionData as Record<string, unknown>
    : null;
};

const getExecutionMeta = (message: Message): Record<string, unknown> | null => {
  const meta = getExecutionData(message)?.meta;
  return meta && typeof meta === 'object' ? meta as Record<string, unknown> : null;
};

export const getMessageBaseCommitSha = (message: Message | null | undefined): string | null => {
  if (!message) return null;
  return normalizedString(message.base_commit_sha)
    ?? normalizedString(message.commit?.first_parent_sha);
};

export const getMessageOutputCommitSha = (message: Message | null | undefined): string | null => {
  if (!message) return null;
  return normalizedString(message.output_commit_sha)
    ?? normalizedString(message.commit?.sha);
};

export const getMessageBaseSelectedFromNodeId = (message: Message | null | undefined): string | null => {
  if (!message) return null;
  return normalizedString(message.base_selected_from_node_id)
    ?? normalizedString(getExecutionMeta(message)?.base_selected_from_node_id);
};

export const getBranchPointerCommitSha = (pointer: BranchPointer | null | undefined): string | null => {
  if (!pointer) return null;
  return normalizedString(pointer.commit_sha)
    ?? normalizedString(pointer.commit?.sha);
};

export const hasMessageCommitOutput = (message: Message | null | undefined): boolean => (
  getMessageOutputCommitSha(message) !== null
);
