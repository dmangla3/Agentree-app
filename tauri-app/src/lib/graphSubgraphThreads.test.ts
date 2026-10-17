import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { buildThreadRootIndex } from './graphThreadRoots';
import {
  applySubgraphThreadConversions,
  buildAttachedThreadLinkIndex,
  getSubgraphThreadLinkNodeId,
  getSubgraphThreadLinkTargetId,
  isDelegatedSubgraphThreadLinkMessage,
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

  it('docks only delegation-backed links whose stored parent is an assistant', () => {
    const owner = message('assistant-a', 'assistant', 'user-a');
    const delegated = {
      ...message('thread-link:child-a', 'user', owner.id),
      content: 'Validate the graph fix',
      execution_data: {
        meta: {
          node_kind: 'subgraph_thread_link',
          target_thread_root_id: 'child-a',
          delegation_request_id: 'request-a',
        },
      },
    };
    const manuallyConverted = {
      ...message('thread-link:manual', 'user', owner.id),
      execution_data: {
        meta: {
          node_kind: 'subgraph_thread_link',
          target_thread_root_id: 'manual',
        },
      },
    };
    const missingParent = {
      ...delegated,
      id: 'thread-link:missing',
      parentId: 'missing-assistant',
    };
    const nonAssistantParent = {
      ...delegated,
      id: 'thread-link:non-assistant',
      parentId: 'user-a',
    };
    const user = message('user-a', 'user', null);

    const index = buildAttachedThreadLinkIndex([
      user,
      owner,
      delegated,
      manuallyConverted,
      missingParent,
      nonAssistantParent,
    ]);

    expect(isDelegatedSubgraphThreadLinkMessage(delegated)).toBe(true);
    expect(isDelegatedSubgraphThreadLinkMessage(manuallyConverted)).toBe(false);
    expect(index.dockedLinkMessageIds).toEqual(new Set([delegated.id]));
    expect(index.byAssistantId.get(owner.id)).toEqual([
      expect.objectContaining({
        linkMessageId: delegated.id,
        threadRootId: 'child-a',
        title: 'Validate the graph fix',
      }),
    ]);
  });

  it('projects the latest child assistant status for the attached-thread tray', () => {
    const owner = message('assistant-a', 'assistant', 'user-a');
    const delegated = {
      ...message('thread-link:child-a', 'user', owner.id),
      execution_data: {
        meta: {
          node_kind: 'subgraph_thread_link',
          target_thread_root_id: 'child-a',
          delegation_request_id: 'request-a',
        },
      },
    };
    const childAssistant = {
      ...message('child-assistant', 'assistant', 'child-user', '2026-05-27T00:00:05.000Z'),
      status: 'running' as const,
      threadId: 'child-a',
    };

    const attached = buildAttachedThreadLinkIndex([
      message('user-a', 'user', null),
      owner,
      delegated,
      childAssistant,
    ]).byAssistantId.get(owner.id)?.[0];

    expect(attached?.status).toBe('running');
    expect(attached?.statusNodeId).toBe(childAssistant.id);
  });
});
