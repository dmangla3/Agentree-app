import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  buildAttachedThreadLinkIndex,
  isDelegatedSubgraphThreadLinkMessage,
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
