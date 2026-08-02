import { Message, Summary } from '../stores/workspaceStore';
import { getGraphParentId } from '../lib/graph/lineage';
import { getCommitSha, getGitParentShas, isFirstClassCommitMessage, isRedundantCommitNode } from '../lib/graph/turnUtils';

export { getCommitSha };

export type CanonicalNodeKind =
  | 'user_message'
  | 'assistant_message'
  | 'commit_message'
  | 'summary_block';

export interface CanonicalNodeEntity {
  entityId: string;
  kind: CanonicalNodeKind;
  messageId: string | null;
  focusMessageId: string | null;
  turnGroupId?: string;
  parentEntityId?: string;
  sortTs: number;
}

export const getSummaryEntityId = (summary: Summary): string => `summary:${summary.id}`;

export const getMessageEntityId = (
  message: Message,
  messageMap?: Map<string, Message>
): string => `${classifyMessageNodeKind(message, messageMap)}:${message.id}`;

export function classifyMessageNodeKind(
  message: Message,
  messageMap?: Map<string, Message>
): Exclude<CanonicalNodeKind, 'summary_block'> {
  if (message.role === 'user') return 'user_message';
  return isFirstClassCommitMessage(message, { messageMap }) ? 'commit_message' : 'assistant_message';
}

export function getTurnGroupIdForMessage(
  message: Message,
  messageMap: Map<string, Message>
): string {
  if (message.role === 'user') {
    return `turn:${message.id}`;
  }

  let currentId: string | null = message.id;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = messageMap.get(currentId);
    if (!current) break;
    if (current.role === 'user') {
      return `turn:${current.id}`;
    }
    currentId = getGraphParentId(current, messageMap);
  }

  return `turn:${message.id}`;
}

export function getTurnFocusMessageId(
  userMessage: Message,
  messages: Message[],
  messageMap: Map<string, Message>
): string {
  const assistants = messages.filter((candidate) => {
    if (candidate.role !== 'assistant') return false;
    const parentId = getGraphParentId(candidate, messageMap);
    return parentId === userMessage.id && !isFirstClassCommitMessage(candidate, { messageMap });
  });

  assistants.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return assistants[0]?.id ?? userMessage.id;
}

export function getToolCallCount(message: Message): number | undefined {
  const executionData = message.execution_data as Record<string, unknown> | undefined;
  const directCount = executionData?.tool_call_count;
  if (typeof directCount === 'number' && directCount > 0) return directCount;

  const timeline = Array.isArray(executionData?.timeline) ? executionData.timeline : [];
  const inferredCount = timeline.filter((entry: any) => entry?.type === 'tool_use').length;
  return inferredCount > 0 ? inferredCount : undefined;
}

export function getAssistantCommitCount(
  message: Message,
  messages: Message[],
  messageMap: Map<string, Message>
): number | undefined {
  if (message.role !== 'assistant' || isFirstClassCommitMessage(message, { messageMap })) {
    return undefined;
  }

  const commitKeys = new Set<string>();
  const outputCommitSha = getCommitSha(message);
  if (outputCommitSha) {
    commitKeys.add(`sha:${outputCommitSha}`);
  }
  messages.forEach((candidate) => {
    if (candidate.role !== 'assistant') return;
    if (!isFirstClassCommitMessage(candidate, { messageMap })) return;
    if (isRedundantCommitNode(candidate, { messageMap })) return;
    if (getGraphParentId(candidate, messageMap) !== message.id) return;

    const commitSha = getCommitSha(candidate);
    commitKeys.add(commitSha ? `sha:${commitSha}` : `node:${candidate.id}`);
  });

  return commitKeys.size > 0 ? commitKeys.size : undefined;
}

export function getNodePreview(message: Message): string {
  const source = message.aiLabel?.trim() || message.content?.trim() || '';
  if (!source) return message.role === 'user' ? 'User message' : 'Assistant message';

  return source
    .replace(/\s+/g, ' ')
    .replace(/```[\s\S]*?```/g, '[Code]')
    .trim();
}

export function getCommitParentShas(message: Message): string[] {
  return getGitParentShas(message);
}
