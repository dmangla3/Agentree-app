import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { buildThreadRootIndex } from './graphThreadRoots';
import {
  applySubgraphThreadConversions,
  getSubgraphThreadLinkNodeId,
  getSubgraphThreadLinkTargetId,
  isSubgraphThreadLinkMessage,
} from './graphSubgraphThreads';

const message = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  createdAt = '2026-05-27T00:00:00.000Z',
): Message => ({
  id,
  role,
  content: `${role} ${id}`,
  parentId,
  workspaceId: 'workspace-1',
  createdAt,
  updatedAt: createdAt,
  status: 'completed',
} as Message);

describe('graph subgraph threads', () => {
  it('splits a nested user subgraph into its own thread and leaves a link node in the original thread', () => {
    const messages = [
      message('thread-a', 'user', null, '2026-05-27T00:00:01.000Z'),
      message('assistant-a', 'assistant', 'thread-a', '2026-05-27T00:00:02.000Z'),
      message('nested-user', 'user', 'assistant-a', '2026-05-27T00:00:03.000Z'),
      message('nested-assistant', 'assistant', 'nested-user', '2026-05-27T00:00:04.000Z'),
      message('sibling-user', 'user', 'assistant-a', '2026-05-27T00:00:05.000Z'),
    ];

    const converted = applySubgraphThreadConversions({
      messages,
      convertedRootIds: new Set(['nested-user']),
    });
    const linkId = getSubgraphThreadLinkNodeId('nested-user');
    const linkMessage = converted.find((item) => item.id === linkId);
    const nestedRoot = converted.find((item) => item.id === 'nested-user');
    const index = buildThreadRootIndex(converted);

    expect(linkMessage).toBeTruthy();
    expect(linkMessage?.parentId).toBe('assistant-a');
    expect(linkMessage?.role).toBe('user');
    expect(isSubgraphThreadLinkMessage(linkMessage)).toBe(true);
    expect(getSubgraphThreadLinkTargetId(linkMessage)).toBe('nested-user');
    expect((nestedRoot?.execution_data as any)?.meta?.thread_origin_id).toBe('nested-user');
    expect(index.threadRootIds).toEqual(['thread-a', 'nested-user']);
    expect(Array.from(index.messageIdsByThreadRootId.get('thread-a') ?? []).sort()).toEqual([
      'assistant-a',
      'sibling-user',
      'thread-a',
      linkId,
    ]);
    expect(Array.from(index.messageIdsByThreadRootId.get('nested-user') ?? []).sort()).toEqual([
      'nested-assistant',
      'nested-user',
    ]);
  });

  it('ignores assistant nodes and root user nodes when converting subgraphs', () => {
    const messages = [
      message('thread-a', 'user', null),
      message('assistant-a', 'assistant', 'thread-a'),
    ];

    const converted = applySubgraphThreadConversions({
      messages,
      convertedRootIds: new Set(['thread-a', 'assistant-a']),
    });

    expect(converted).toBe(messages);
  });
});
