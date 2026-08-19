import type { Message } from '../stores/workspaceStore';

export type ThreadSessionStatus = 'active' | 'done' | 'archived';
export type ThreadSessionSource = 'workspace_default' | 'user' | 'flow' | 'legacy';

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
  const source = input.source === 'workspace_default' || input.source === 'flow' || input.source === 'legacy'
    ? input.source
    : 'user';
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
  };
};

export const getMessageThreadSessionId = (message: Message | null | undefined): string | null => (
  trimOrNull(message?.threadId) ?? trimOrNull(message?.thread_id)
);

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
  updatedAtMs: Number.isFinite(Date.parse(thread.updatedAt)) ? Date.parse(thread.updatedAt) : 0,
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
  if (leftKey.updatedAtMs !== rightKey.updatedAtMs) return rightKey.updatedAtMs - leftKey.updatedAtMs;
  return leftKey.id.localeCompare(rightKey.id);
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
    const existing = byThreadId.get(threadId);
    if (!existing) {
      byThreadId.set(threadId, {
        id: threadId,
        workspaceId: resolvedWorkspaceId,
        title: message.role === 'user' ? trimOrNull(message.content) : null,
        status: 'active',
        createdAt,
        updatedAt,
        baseCommitSha: trimOrNull(message.base_commit_sha),
        firstMessageId: message.role === 'user' ? message.id : null,
        source: 'legacy',
      });
      continue;
    }
    const nextUpdatedAt = messageTimeMs(updatedAt) > messageTimeMs(existing.updatedAt)
      ? updatedAt
      : existing.updatedAt;
    byThreadId.set(threadId, {
      ...existing,
      title: existing.title ?? (message.role === 'user' ? trimOrNull(message.content) : null),
      createdAt: messageTimeMs(createdAt) < messageTimeMs(existing.createdAt) ? createdAt : existing.createdAt,
      updatedAt: nextUpdatedAt,
      baseCommitSha: existing.baseCommitSha ?? trimOrNull(message.base_commit_sha),
      firstMessageId: existing.firstMessageId ?? (message.role === 'user' ? message.id : null),
    });
  }

  return Array.from(byThreadId.values()).sort(compareThreadSessions);
};
