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
    ?? normalizedString(getExecutionData(message)?.output_commit_sha)
    ?? normalizedString(getExecutionMeta(message)?.output_commit_sha)
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

export const getBranchPointerDisplayName = (pointer: BranchPointer | null | undefined): string | null => {
  if (!pointer) return null;
  const rawName = normalizedString(pointer.name) ?? normalizedString(pointer.git_ref);
  if (!rawName || rawName === 'HEAD') return null;

  return rawName
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '');
};

export const getBranchPointerNamesForCommit = (
  commitSha: string | null | undefined,
  pointers: BranchPointer[] | null | undefined
): string[] => {
  const normalizedCommitSha = normalizedString(commitSha);
  if (!normalizedCommitSha) return [];

  const names: string[] = [];
  const seen = new Set<string>();

  for (const pointer of pointers ?? []) {
    if (getBranchPointerCommitSha(pointer) !== normalizedCommitSha) continue;

    const name = getBranchPointerDisplayName(pointer);
    if (!name || seen.has(name)) continue;

    seen.add(name);
    names.push(name);
  }

  return names;
};

export const hasMessageCommitOutput = (message: Message | null | undefined): boolean => (
  getMessageOutputCommitSha(message) !== null
);
