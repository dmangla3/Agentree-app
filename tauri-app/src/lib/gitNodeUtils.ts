import { DiffRelationship, BlameResult } from './agentClient';
import { Workspace, Message } from '../stores/workspaceStore';
import { getMessageOutputCommitSha } from './graph/commitAccessors';

type MessageMap = Map<string, Message>;

function getExecutionMeta(message: Message | null | undefined): Record<string, unknown> {
  const executionData = (message?.execution_data ?? null) as { meta?: Record<string, unknown> } | null;
  return executionData?.meta ?? {};
}

export function getRepoPathFromWorkspace(workspace: Workspace | null | undefined): string | null {
  return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
}

export function buildMessageMap(messages: Message[]): MessageMap {
  return new Map(messages.map((message) => [message.id, message]));
}

export function getMessageById(messages: Message[] | MessageMap, messageId: string | null | undefined): Message | null {
  if (!messageId) return null;
  if (messages instanceof Map) {
    return messages.get(messageId) ?? null;
  }
  return messages.find((message) => message.id === messageId) ?? null;
}

export function findNearestAncestorCommit(
  messages: Message[] | MessageMap,
  startNodeId: string | null | undefined,
  baseCommitSha: string | null | undefined
): string | null {
  let current = getMessageById(messages, startNodeId);
  while (current) {
    const outputCommitSha = getMessageOutputCommitSha(current);
    if (outputCommitSha) return outputCommitSha;
    current = getMessageById(messages, current.parentId);
  }
  return baseCommitSha ?? null;
}

export function resolveNodeCommit(
  message: Message | null | undefined,
  messages: Message[] | MessageMap,
  baseCommitSha: string | null | undefined
): string | null {
  if (!message) return null;
  const outputCommitSha = getMessageOutputCommitSha(message);
  if (outputCommitSha) return outputCommitSha;

  return findNearestAncestorCommit(messages, message.parentId, baseCommitSha);
}

export function resolveParentCommit(
  message: Message | null | undefined,
  messages: Message[] | MessageMap,
  baseCommitSha: string | null | undefined
): string | null {
  if (!message) return null;
  const primaryParent = message.commit?.parents?.find(
    (value) => typeof value.parent_sha === 'string' && value.parent_sha.trim().length > 0
  )?.parent_sha;
  if (primaryParent) {
    return primaryParent.trim();
  }

  return findNearestAncestorCommit(messages, message.parentId, baseCommitSha);
}

function isAncestor(messages: MessageMap, ancestorId: string, descendantId: string): boolean {
  let current = messages.get(descendantId) ?? null;
  while (current) {
    if (current.id === ancestorId) {
      return true;
    }
    current = current.parentId ? messages.get(current.parentId) ?? null : null;
  }
  return false;
}

export function findCommonAncestorMessageId(
  messages: Message[] | MessageMap,
  firstNodeId: string,
  secondNodeId: string
): string | null {
  const messageMap = messages instanceof Map ? messages : buildMessageMap(messages);
  const seen = new Set<string>();

  let current = messageMap.get(firstNodeId) ?? null;
  while (current) {
    seen.add(current.id);
    current = current.parentId ? messageMap.get(current.parentId) ?? null : null;
  }

  current = messageMap.get(secondNodeId) ?? null;
  while (current) {
    if (seen.has(current.id)) {
      return current.id;
    }
    current = current.parentId ? messageMap.get(current.parentId) ?? null : null;
  }

  return null;
}

export function inferDiffRelationship(
  messages: Message[] | MessageMap,
  fromNodeId: string,
  toNodeId: string
): DiffRelationship {
  const messageMap = messages instanceof Map ? messages : buildMessageMap(messages);

  if (toNodeId !== fromNodeId && isAncestor(messageMap, fromNodeId, toNodeId)) {
    return (messageMap.get(toNodeId)?.parentId === fromNodeId)
      ? 'parent-child'
      : 'ancestor-descendant';
  }

  if (fromNodeId !== toNodeId && isAncestor(messageMap, toNodeId, fromNodeId)) {
    return 'ancestor-descendant';
  }

  return findCommonAncestorMessageId(messageMap, fromNodeId, toNodeId)
    ? 'siblings'
    : 'unrelated';
}

export function getMessageIdForCommit(
  messages: Message[] | MessageMap,
  commitSha: string | null | undefined
): string | null {
  if (!commitSha) return null;

  const messageList = messages instanceof Map ? Array.from(messages.values()) : messages;
  const match = messageList.find((message) => getMessageOutputCommitSha(message) === commitSha);
  return match?.id ?? null;
}

export function mapBlameCommitsToMessages(
  blameResult: BlameResult,
  messages: Message[] | MessageMap,
  baseCommitSha: string | null | undefined
): BlameResult {
  const messageList = messages instanceof Map ? Array.from(messages.values()) : messages;

  return {
    ...blameResult,
    entries: blameResult.entries.map((entry) => {
      if (entry.is_base || entry.author_node_id === baseCommitSha) {
        return {
          ...entry,
          author_node_id: 'base',
          is_base: true,
        };
      }

      const messageId = getMessageIdForCommit(messageList, entry.author_node_id);
      return {
        ...entry,
        author_node_id: messageId ?? entry.author_node_id,
      };
    }),
  };
}

export function getGitWorktreePath(message: Message | null | undefined): string | null {
  const value = getExecutionMeta(message).git_worktree_path;
  return typeof value === 'string' && value.trim() ? value : null;
}
