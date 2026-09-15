import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import type { LocalNodeMessage } from './useLocalNodes';
import { isRetryableLocalOnlySync, parseLocalNode, upsertMessagesIntoLocalNodeCache } from './useLocalNodes';

const message = (overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message => {
  const { id, role, ...rest } = overrides;
  return {
    ...rest,
    id,
    role,
    content: rest.content ?? '',
    parentId: rest.parentId ?? null,
    workspaceId: rest.workspaceId ?? 'workspace-1',
    createdAt: rest.createdAt ?? '2026-05-19T00:00:00.000Z',
    updatedAt: rest.updatedAt ?? '2026-05-19T00:00:00.000Z',
    status: rest.status ?? null,
    execution_data: rest.execution_data ?? null,
  };
};

const localNode = (
  overrides: Partial<LocalNodeMessage> & { message?: Partial<Message> & { id: string } } = {},
): LocalNodeMessage => ({
  nodeId: overrides.nodeId ?? overrides.message?.id ?? 'node-1',
  workspaceId: overrides.workspaceId ?? 'workspace-1',
  syncStatus: overrides.syncStatus ?? 'local_only',
  finalizedAt: overrides.finalizedAt ?? 1779198900,
  serverAckAt: overrides.serverAckAt,
  retryAttempt: overrides.retryAttempt ?? 2,
  nextRetryAt: overrides.nextRetryAt,
  lastUploadError: overrides.lastUploadError,
  message: {
    id: overrides.message?.id ?? overrides.nodeId ?? 'node-1',
    role: overrides.message?.role ?? 'assistant',
    status: overrides.message?.status ?? 'running',
    workspaceId: overrides.message?.workspaceId ?? overrides.workspaceId ?? 'workspace-1',
    createdAt: overrides.message?.createdAt ?? '2026-05-19T00:00:00.000Z',
    updatedAt: overrides.message?.updatedAt ?? '2026-05-19T00:00:00.000Z',
    ...overrides.message,
  },
});

describe('parseLocalNode', () => {
  it('mirrors the durable controlled_by row field into the message payload', () => {
    const parsed = parseLocalNode({
      nodeId: 'assistant-child',
      workspaceId: 'workspace-1',
      controlledByNodeId: 'assistant-orchestrator',
      payload: JSON.stringify({
        id: 'assistant-child',
        workspaceId: 'workspace-1',
        role: 'assistant',
      }),
      syncStatus: 'local_only',
      finalizedAt: 1779199000,
      retryAttempt: 0,
    });

    expect(parsed?.message.controlled_by_node_id).toBe('assistant-orchestrator');
    expect(parsed?.message.controlledByNodeId).toBe('assistant-orchestrator');
  });
});

describe('isRetryableLocalOnlySync', () => {
  it('does not treat intentionally local-only rows as retryable sync work', () => {
    expect(isRetryableLocalOnlySync({
      syncStatus: 'local_only',
      retryAttempt: 0,
      nextRetryAt: null,
      lastUploadError: null,
    })).toBe(false);
  });

  it('treats local-only rows with retry metadata as retryable sync work', () => {
    expect(isRetryableLocalOnlySync({
      syncStatus: 'local_only',
      retryAttempt: 0,
      nextRetryAt: 1779199000,
      lastUploadError: null,
    })).toBe(true);
    expect(isRetryableLocalOnlySync({
      syncStatus: 'local_only',
      retryAttempt: 1,
      nextRetryAt: null,
      lastUploadError: null,
    })).toBe(true);
    expect(isRetryableLocalOnlySync({
      syncStatus: 'local_only',
      retryAttempt: 0,
      nextRetryAt: null,
      lastUploadError: 'offline',
    })).toBe(true);
  });

  it('ignores persisted rows even if retry metadata is present', () => {
    expect(isRetryableLocalOnlySync({
      syncStatus: 'persisted',
      retryAttempt: 1,
      nextRetryAt: 1779199000,
      lastUploadError: 'offline',
    })).toBe(false);
  });
});

describe('upsertMessagesIntoLocalNodeCache', () => {
  it('materializes every local-first sibling into the local-node cache', () => {
    const rows = upsertMessagesIntoLocalNodeCache(
      undefined,
      'workspace-1',
      [
        message({ id: 'user-1', role: 'user', createdAt: '2026-05-19T00:00:01.000Z' }),
        message({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', status: 'pending', createdAt: '2026-05-19T00:00:02.000Z' }),
        message({ id: 'user-2', role: 'user', createdAt: '2026-05-19T00:00:03.000Z' }),
        message({ id: 'assistant-2', role: 'assistant', parentId: 'user-2', status: 'pending', createdAt: '2026-05-19T00:00:04.000Z' }),
      ],
      { finalizedAt: 1779199000, syncStatus: 'local_only' },
    );

    expect(rows.map((row) => row.nodeId)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
    expect(rows.every((row) => row.syncStatus === 'local_only')).toBe(true);
    expect(rows.every((row) => row.finalizedAt === 1779199000)).toBe(true);
  });

  it('replaces stale cached message payloads without dropping retry metadata', () => {
    const rows = upsertMessagesIntoLocalNodeCache(
      [
        localNode({
          nodeId: 'assistant-1',
          retryAttempt: 3,
          lastUploadError: 'offline',
          message: { id: 'assistant-1', role: 'assistant', status: 'running' },
        }),
      ],
      'workspace-1',
      [
        message({
          id: 'assistant-1',
          role: 'assistant',
          status: 'completed',
          content: 'done',
          updatedAt: '2026-05-19T00:01:00.000Z',
        }),
      ],
      { finalizedAt: 1779199000, syncStatus: 'local_only' },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: 'assistant-1',
      retryAttempt: 3,
      lastUploadError: 'offline',
      message: {
        id: 'assistant-1',
        status: 'completed',
        content: 'done',
      },
    });
  });
});
