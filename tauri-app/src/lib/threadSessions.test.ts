import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  deriveBackfilledThreadSessions,
  getLegacyThreadIdForMessage,
  getMessageThreadSessionId,
  mergeThreadSessionsWithBackfills,
  normalizeThreadSession,
  threadSessionSortKey,
  type ThreadSession,
} from './threadSessions';

const message = (overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>): Message => ({
  id: overrides.id,
  role: overrides.role,
  parentId: overrides.parentId,
  content: overrides.content ?? overrides.id,
  workspaceId: overrides.workspaceId ?? 'workspace-1',
  createdAt: overrides.createdAt ?? '2026-05-28T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? overrides.createdAt ?? '2026-05-28T00:00:00.000Z',
  execution_data: overrides.execution_data,
  threadId: overrides.threadId,
  thread_id: overrides.thread_id,
} as Message);

describe('threadSessions', () => {
  it('normalizes persisted thread sessions', () => {
    expect(normalizeThreadSession({
      id: ' thread-1 ',
      workspaceId: ' workspace-1 ',
      title: '  Build feature  ',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:01:00.000Z',
      baseCommitSha: ' abc123 ',
      firstMessageId: ' user-1 ',
      source: 'user',
    })).toEqual({
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Build feature',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:01:00.000Z',
      baseCommitSha: 'abc123',
      firstMessageId: 'user-1',
      source: 'user',
    });
  });

  it('accepts snake_case server payloads', () => {
    expect(normalizeThreadSession({
      id: 'thread-1',
      workspace_id: 'workspace-1',
      base_commit_sha: 'base-sha',
      first_message_id: 'user-1',
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T00:01:00.000Z',
    })).toEqual(expect.objectContaining({
      workspaceId: 'workspace-1',
      baseCommitSha: 'base-sha',
      firstMessageId: 'user-1',
      source: 'user',
      status: 'active',
    }));
  });

  it('reads direct persisted thread ids from messages before legacy metadata', () => {
    expect(getMessageThreadSessionId(message({
      id: 'user-1',
      role: 'user',
      parentId: null,
      thread_id: ' persisted-thread ',
      execution_data: { meta: { thread_origin_id: 'legacy-thread' } },
    }))).toBe('persisted-thread');
  });

  it('keeps legacy fallback compatible with existing thread_origin_id messages', () => {
    const user = message({
      id: 'user-1',
      role: 'user',
      parentId: null,
      execution_data: { meta: { thread_origin_id: 'legacy-thread' } },
    });
    expect(getLegacyThreadIdForMessage(user, new Map([[user.id, user]]))).toBe('legacy-thread');
  });

  it('derives backfill sessions from legacy message metadata', () => {
    const messages = [
      message({
        id: 'user-1',
        role: 'user',
        parentId: null,
        content: 'Build feature',
        execution_data: { meta: { thread_origin_id: 'thread-1' } },
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        createdAt: '2026-05-28T00:00:01.000Z',
        updatedAt: '2026-05-28T00:00:02.000Z',
      }),
    ];
    expect(deriveBackfilledThreadSessions(messages, 'workspace-1')).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        workspaceId: 'workspace-1',
        title: 'Build feature',
        firstMessageId: 'user-1',
        source: 'legacy',
        updatedAt: '2026-05-28T00:00:02.000Z',
      }),
    ]);
  });

  it('derives backfill sessions from direct message thread ids', () => {
    expect(deriveBackfilledThreadSessions([
      message({
        id: 'user-1',
        role: 'user',
        parentId: null,
        threadId: 'thread-1',
      }),
    ])).toEqual([
      expect.objectContaining({ id: 'thread-1', firstMessageId: 'user-1' }),
    ]);
  });

  it('uses generated assistant thread titles when deriving backfilled sessions', () => {
    expect(deriveBackfilledThreadSessions([
      message({
        id: 'user-1',
        role: 'user',
        parentId: null,
        threadId: 'thread-1',
        content: 'hi',
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        threadId: 'thread-1',
        execution_data: { meta: { thread_title: 'Greeting' } },
        createdAt: '2026-05-28T00:00:01.000Z',
        updatedAt: '2026-05-28T00:00:02.000Z',
      }),
    ])).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        title: 'Greeting',
        firstMessageId: 'user-1',
      }),
    ]);
  });

  it('keeps generated backfilled titles when persisted sessions have no title', () => {
    const backfilled: ThreadSession = {
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Greeting',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:00:02.000Z',
      baseCommitSha: null,
      firstMessageId: 'user-1',
      source: 'legacy',
    };
    const persisted: ThreadSession = {
      ...backfilled,
      title: null,
      source: 'user',
      updatedAt: '2026-05-28T00:00:03.000Z',
    };

    expect(mergeThreadSessionsWithBackfills([backfilled], [persisted])).toEqual([
      expect.objectContaining({
        id: 'thread-1',
        title: 'Greeting',
        source: 'user',
        updatedAt: '2026-05-28T00:00:03.000Z',
      }),
    ]);
  });

  it('sorts thread sessions by creation time for stable tab position', () => {
    const empty: ThreadSession = {
      id: 'empty-thread',
      workspaceId: 'workspace-1',
      title: null,
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:00:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    };
    expect(threadSessionSortKey(empty)).toEqual({
      statusRank: 0,
      createdAtMs: Date.parse('2026-05-28T00:00:00.000Z'),
      id: 'empty-thread',
    });
  });
});
