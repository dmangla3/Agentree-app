import { describe, expect, it } from 'vitest';
import {
  mergeThreadSessionIntoGraphSnapshotCache,
  mergeThreadSessionIntoCache,
  removeThreadSessionFromCache,
  removeThreadSessionFromGraphSnapshotCache,
} from './useThreadSessions';

describe('mergeThreadSessionIntoCache', () => {
  it('upserts and sorts active sessions by newest creation time first', () => {
    const merged = mergeThreadSessionIntoCache([
      {
        id: 'old-thread',
        workspaceId: 'workspace-1',
        title: null,
        status: 'active',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        baseCommitSha: null,
        firstMessageId: null,
        source: 'user',
      },
    ], {
      id: 'new-thread',
      workspaceId: 'workspace-1',
      title: null,
      status: 'active',
      createdAt: '2026-05-28T00:01:00.000Z',
      updatedAt: '2026-05-28T00:01:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    });

    expect(merged.map((thread) => thread.id)).toEqual(['new-thread', 'old-thread']);
  });

  it('replaces an existing session without duplicating it', () => {
    const merged = mergeThreadSessionIntoCache([
      {
        id: 'thread-1',
        workspaceId: 'workspace-1',
        title: null,
        status: 'active',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        baseCommitSha: null,
        firstMessageId: null,
        source: 'user',
      },
    ], {
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Renamed',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:02:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Renamed');
  });
});

describe('removeThreadSessionFromCache', () => {
  it('removes a deleted thread session without touching other sessions', () => {
    const current = [
      {
        id: 'thread-1',
        workspaceId: 'workspace-1',
        title: null,
        status: 'active' as const,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        baseCommitSha: null,
        firstMessageId: null,
        source: 'user' as const,
      },
      {
        id: 'thread-2',
        workspaceId: 'workspace-1',
        title: null,
        status: 'active' as const,
        createdAt: '2026-05-28T00:01:00.000Z',
        updatedAt: '2026-05-28T00:01:00.000Z',
        baseCommitSha: null,
        firstMessageId: null,
        source: 'user' as const,
      },
    ];

    expect(removeThreadSessionFromCache(current, 'thread-1').map((thread) => thread.id)).toEqual(['thread-2']);
  });
});

describe('mergeThreadSessionIntoGraphSnapshotCache', () => {
  it('updates a renamed thread session in a cached graph snapshot', () => {
    const snapshot = {
      version: 2,
      threadSessions: [
        {
          id: 'thread-1',
          workspaceId: 'workspace-1',
          title: 'Original',
          status: 'active' as const,
          createdAt: '2026-05-28T00:00:00.000Z',
          updatedAt: '2026-05-28T00:00:00.000Z',
          baseCommitSha: null,
          firstMessageId: null,
          source: 'user' as const,
        },
      ],
      messages: [{ id: 'message-1' }],
    };

    expect(mergeThreadSessionIntoGraphSnapshotCache(snapshot, {
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Renamed thread',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:02:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    })?.threadSessions).toEqual([{
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Renamed thread',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:02:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    }]);
  });

  it('adds a newly persisted renamed session to a cached graph snapshot', () => {
    const snapshot = {
      version: 2,
      threadSessions: [],
      messages: [{ id: 'message-1' }],
    };

    expect(mergeThreadSessionIntoGraphSnapshotCache(snapshot, {
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Persisted thread name',
      status: 'active',
      createdAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:01:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    })?.threadSessions).toHaveLength(1);
  });
});

describe('removeThreadSessionFromGraphSnapshotCache', () => {
  it('removes a deleted thread session from a cached graph snapshot', () => {
    const snapshot = {
      version: 2,
      threadSessions: [
        {
          id: 'thread-1',
          workspaceId: 'workspace-1',
        },
        {
          id: 'thread-2',
          workspaceId: 'workspace-1',
        },
      ],
      messages: [{ id: 'message-1' }],
    };

    expect(removeThreadSessionFromGraphSnapshotCache(snapshot, 'thread-1')).toEqual({
      version: 2,
      threadSessions: [{
        id: 'thread-2',
        workspaceId: 'workspace-1',
      }],
      messages: [{ id: 'message-1' }],
    });
  });
});
