import type { Message } from '../stores/workspaceStore';

export type ThreadSessionStatus = 'active' | 'done' | 'archived';
export type ThreadSessionSource = 'workspace_default' | 'user' | 'flow' | 'legacy' | 'delegation' | 'converted_subgraph';

export interface ThreadSession {
  id: string;
  workspaceId: string;
  title: string | null;
  status: ThreadSessionStatus;
  createdAt: string;
  updatedAt: string;
  baseCommitSha: string | null;
  firstMessageId: string | null;
  source: ThreadSessionSource;
  parentThreadId?: string | null;
  anchorNodeId?: string | null;
}

const readString = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '';
};

const trimOrNull = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export const normalizeThreadSession = (input: Record<string, unknown> | null | undefined): ThreadSession | null => {
  if (!input || typeof input !== 'object') return null;
  const id = readString(input, 'id').trim();
  const workspaceId = readString(input, 'workspaceId', 'workspace_id').trim();
  const createdAt = readString(input, 'createdAt', 'created_at');
  const updatedAt = readString(input, 'updatedAt', 'updated_at') || createdAt;
  if (!id || !workspaceId || !createdAt) return null;
  const status = input.status === 'done' || input.status === 'archived' ? input.status : 'active';
  const source = input.source === 'workspace_default'
    || input.source === 'flow'
    || input.source === 'legacy'
    || input.source === 'delegation'
    || input.source === 'converted_subgraph'
    ? input.source
    : 'user';
  const parentThreadId = trimOrNull(input.parentThreadId) ?? trimOrNull(input.parent_thread_id);
  const anchorNodeId = trimOrNull(input.anchorNodeId) ?? trimOrNull(input.anchor_node_id);
  return {
    id,
    workspaceId,
    title: trimOrNull(input.title),
    status,
    createdAt,
    updatedAt,
    baseCommitSha: trimOrNull(input.baseCommitSha) ?? trimOrNull(input.base_commit_sha),
    firstMessageId: trimOrNull(input.firstMessageId) ?? trimOrNull(input.first_message_id),
    source,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(anchorNodeId ? { anchorNodeId } : {}),
  };
};

export const getMessageThreadSessionId = (message: Message | null | undefined): string | null => (
  trimOrNull(message?.threadId) ?? trimOrNull(message?.thread_id)
);

const getGeneratedThreadTitleFromMessage = (message: Message | null | undefined): string | null => {
  const meta = (message?.execution_data as any)?.meta;
  return trimOrNull(meta?.thread_title)
    ?? trimOrNull(meta?.threadTitle)
    ?? trimOrNull(meta?.agent_thread_title)
    ?? trimOrNull(meta?.runtime_thread_title);
};

export const getLegacyThreadIdForMessage = (
  messageIdOrMessage: string | Message | null | undefined,
  messageMap: Map<string, Message>,
): string | null => {
  let cursor = typeof messageIdOrMessage === 'string'
    ? messageMap.get(messageIdOrMessage) ?? null
    : messageIdOrMessage ?? null;
  const visited = new Set<string>();
  let earliestUserId: string | null = null;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.role === 'user') {
      const value = trimOrNull((cursor.execution_data as any)?.meta?.thread_origin_id);
      if (value) return value;
      earliestUserId = cursor.id;
    }
    if (!cursor.parentId) return earliestUserId;
    cursor = messageMap.get(cursor.parentId) ?? null;
  }

  return earliestUserId;
};

export const threadSessionSortKey = (thread: ThreadSession) => ({
  statusRank: thread.status === 'active' ? 0 : thread.status === 'done' ? 1 : 2,
  createdAtMs: Number.isFinite(Date.parse(thread.createdAt)) ? Date.parse(thread.createdAt) : 0,
  id: thread.id,
});

const messageTimeMs = (value: string | null | undefined): number => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareThreadSessions = (left: ThreadSession, right: ThreadSession): number => {
  const leftKey = threadSessionSortKey(left);
  const rightKey = threadSessionSortKey(right);
  if (leftKey.statusRank !== rightKey.statusRank) return leftKey.statusRank - rightKey.statusRank;
  if (leftKey.createdAtMs !== rightKey.createdAtMs) return rightKey.createdAtMs - leftKey.createdAtMs;
  return leftKey.id.localeCompare(rightKey.id);
};

export const mergeThreadSessionsWithBackfills = (
  backfilledThreadSessions: ThreadSession[],
  persistedThreadSessions: ThreadSession[],
): ThreadSession[] => {
  const byId = new Map(backfilledThreadSessions.map((thread) => [thread.id, thread]));
  for (const persisted of persistedThreadSessions) {
    const backfilled = byId.get(persisted.id);
    byId.set(persisted.id, {
      ...persisted,
      title: persisted.title ?? backfilled?.title ?? null,
      firstMessageId: persisted.firstMessageId ?? backfilled?.firstMessageId ?? null,
      baseCommitSha: persisted.baseCommitSha ?? backfilled?.baseCommitSha ?? null,
      parentThreadId: persisted.parentThreadId ?? backfilled?.parentThreadId ?? null,
    });
  }
  return Array.from(byId.values()).sort(compareThreadSessions);
};

export const deriveBackfilledThreadSessions = (
  messages: Message[],
  workspaceId?: string | null,
): ThreadSession[] => {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  const byThreadId = new Map<string, ThreadSession>();
  const orderedMessages = [...messages].sort((left, right) => (
    messageTimeMs(left.createdAt) - messageTimeMs(right.createdAt)
      || left.id.localeCompare(right.id)
  ));

  for (const message of orderedMessages) {
    const threadId = getMessageThreadSessionId(message) ?? getLegacyThreadIdForMessage(message, messageMap);
    if (!threadId) continue;
    const resolvedWorkspaceId = workspaceId || message.workspaceId;
    if (!resolvedWorkspaceId) continue;
    const createdAt = message.createdAt || message.updatedAt || new Date(0).toISOString();
    const updatedAt = message.updatedAt || createdAt;
    const generatedThreadTitle = getGeneratedThreadTitleFromMessage(message);
    const existing = byThreadId.get(threadId);
    if (!existing) {
      byThreadId.set(threadId, {
        id: threadId,
        workspaceId: resolvedWorkspaceId,
        title: generatedThreadTitle ?? (message.role === 'user' ? trimOrNull(message.content) : null),
        status: 'active',
        createdAt,
        updatedAt,
        baseCommitSha: trimOrNull(message.base_commit_sha),
        firstMessageId: message.role === 'user' ? message.id : (generatedThreadTitle ? trimOrNull(message.parentId) : null),
        source: 'legacy',
        parentThreadId: null,
        anchorNodeId: null,
      });
      continue;
    }
    const nextUpdatedAt = messageTimeMs(updatedAt) > messageTimeMs(existing.updatedAt)
      ? updatedAt
      : existing.updatedAt;
    byThreadId.set(threadId, {
      ...existing,
      title: generatedThreadTitle ?? existing.title ?? (message.role === 'user' ? trimOrNull(message.content) : null),
      createdAt: messageTimeMs(createdAt) < messageTimeMs(existing.createdAt) ? createdAt : existing.createdAt,
      updatedAt: nextUpdatedAt,
      baseCommitSha: existing.baseCommitSha ?? trimOrNull(message.base_commit_sha),
      firstMessageId: existing.firstMessageId ?? (message.role === 'user' ? message.id : null),
    });
  }

  return Array.from(byThreadId.values()).sort(compareThreadSessions);
};
