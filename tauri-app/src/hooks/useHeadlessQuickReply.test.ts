import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '../test/queryTestUtils';
import { localNodeKeys, type LocalNodeMessage } from './useLocalNodes';
import { materializeHeadlessQuickReplyMessages } from './useHeadlessQuickReply';
import type { Message } from '../stores/workspaceStore';

const makeMessage = (input: Partial<Message> & Pick<Message, 'id' | 'role'>): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  createdAt: input.createdAt ?? '2026-05-28T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-28T00:00:00.000Z',
});

describe('useHeadlessQuickReply', () => {
  it('materializes local fallback quick-reply nodes into query caches', () => {
    const queryClient = createTestQueryClient();
    const createdMessages = [
      makeMessage({
        id: 'user-1',
        role: 'user',
        content: 'Continue this',
        parentId: 'parent-1',
        createdAt: '2026-05-28T00:00:02.000Z',
      }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        status: 'pending' as any,
        createdAt: '2026-05-28T00:00:03.000Z',
      }),
    ];

    materializeHeadlessQuickReplyMessages(queryClient, 'workspace-1', createdMessages, {
      finalizedAt: 1779912000,
    });

    const cachedMessages = queryClient.getQueryData<Message[]>(['messages', 'workspace-1']) ?? [];
    const localRows = queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1')) ?? [];

    expect(cachedMessages.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(localRows.map((row) => row.nodeId)).toEqual(['user-1', 'assistant-1']);
    expect(localRows.every((row) => row.syncStatus === 'local_only')).toBe(true);
    expect(localRows.every((row) => row.finalizedAt === 1779912000)).toBe(true);
  });

  it('wires the quick-reply headless sender to local persistence callbacks', () => {
    const source = readFileSync(join(process.cwd(), 'src/hooks/useHeadlessQuickReply.ts'), 'utf8');

    expect(source).toContain('persistLocalNode:');
    expect(source).toContain('onMessagesCreated:');
    expect(source).toContain('materializeHeadlessQuickReplyMessages');
    expect(source).toContain('selectedLoginProfileId: selectedLoginProfile?.id ?? null');
    expect(source).toContain('markLocalAgentNodeTerminal');
  });
});
