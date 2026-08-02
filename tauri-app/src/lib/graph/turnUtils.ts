import { Message } from '../../stores/workspaceStore';
import { getGraphParentId } from './lineage';
import { getMessageOutputCommitSha } from './commitAccessors';

interface CommitDetectionOptions {
  messageMap?: Map<string, Message>;
}

const getExecutionData = (msg: Message): Record<string, unknown> | undefined => {
  return msg.execution_data as Record<string, unknown> | undefined;
};

const getNodeKind = (msg: Message): string | null => {
  const raw = (msg as any)?.node_kind ?? (msg as any)?.nodeKind;
  return typeof raw === 'string' ? raw : null;
};

export const getCommitSha = (msg: Message): string | null => {
  return getMessageOutputCommitSha(msg);
};

export const getGitParentShas = (msg: Message): string[] => {
  const fromCommitEntity = Array.isArray(msg.commit?.parents)
    ? msg.commit.parents
        .map((parent) => parent.parent_sha)
        .filter((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0)
        .map((sha) => sha.trim())
    : [];
  if (fromCommitEntity.length > 0) {
    return Array.from(new Set(fromCommitEntity));
  }

  const executionData = getExecutionData(msg);
  const mergeMetadata = executionData?.merge_metadata as Record<string, unknown> | undefined;
  const targetCommit = typeof (mergeMetadata?.target as any)?.commitSha === 'string'
    ? ((mergeMetadata?.target as any).commitSha as string).trim()
    : '';
  const sourceCommits = Array.isArray((mergeMetadata?.sources as any[] | undefined))
    ? (mergeMetadata?.sources as any[])
        .map((source) => (typeof source?.commitSha === 'string' ? source.commitSha.trim() : ''))
        .filter((sha) => sha.length > 0)
    : [];
  return Array.from(new Set([targetCommit, ...sourceCommits].filter((sha) => sha.length > 0)));
};

export const getNearestAncestorCommitSha = (
  msg: Message,
  messageMap?: Map<string, Message>
): string | null => {
  if (!messageMap) return null;

  let currentId = getGraphParentId(msg, messageMap);
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = messageMap.get(currentId);
    if (!current) return null;
    const currentCommitSha = getCommitSha(current);
    if (currentCommitSha) return currentCommitSha;
    currentId = getGraphParentId(current, messageMap);
  }

  return null;
};

export const isRedundantCommitNode = (
  msg: Message,
  options: CommitDetectionOptions = {}
): boolean => {
  if (!isFirstClassCommitMessage(msg, options)) return false;
  const commitSha = getCommitSha(msg);
  if (!commitSha) return false;
  const ancestorCommitSha = getNearestAncestorCommitSha(msg, options.messageMap);
  return ancestorCommitSha === commitSha;
};

export function isFirstClassCommitMessage(msg: Message, options: CommitDetectionOptions = {}): boolean {
  void options;
  if (msg.role !== 'assistant') return false;
  const nodeKind = getNodeKind(msg);
  if (nodeKind === 'commit') return true;
  if (isExternalCommit(msg)) return true;
  return Boolean(msg.commit?.sha);
}

export function isExternalCommit(msg: Message): boolean {
  if (msg.role !== 'assistant') return false;
  if (msg.commit?.source_kind === 'external') return true;
  const executionData = getExecutionData(msg);
  return (executionData?.meta as Record<string, unknown>)?.sync_source === 'external_git';
}
