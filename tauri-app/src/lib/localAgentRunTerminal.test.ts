import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_STATUS } from '@shared/agentStatus';
import type { Message } from '../stores/workspaceStore';
import {
  isStalePrelaunchLocalAgentNode,
  markStaleLocalAgentNodeCancelled,
} from './localAgentRunTerminal';
import { agentClient } from './agentClient';

vi.mock('./agentClient', () => ({
  agentClient: {
    upsertLocalNode: vi.fn(),
  },
}));

const mockedUpsertLocalNode = vi.mocked(agentClient.upsertLocalNode);

const assistantNode = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  role: 'assistant',
  content: '',
  status: AGENT_STATUS.pending,
  parentId: 'user-1',
  createdAt: '2026-06-15T02:37:24.137Z',
  updatedAt: '2026-06-15T02:37:24.137Z',
  execution_data: {},
  ...overrides,
} as Message);

describe('isStalePrelaunchLocalAgentNode', () => {
  it('recognizes stale quick-reply placeholders without native run ids', () => {
    expect(isStalePrelaunchLocalAgentNode(assistantNode({
      execution_data: {
        meta: { quick_reply: true },
      },
    }))).toBe(true);
  });

  it('recognizes prelaunch nodes without native run ids', () => {
    expect(isStalePrelaunchLocalAgentNode(assistantNode({
      execution_data: {
        meta: {},
      },
    }))).toBe(true);
  });

  it('does not treat user nodes as stale local agent nodes', () => {
    expect(isStalePrelaunchLocalAgentNode(assistantNode({
      role: 'user',
      execution_data: {
        meta: { quick_reply: true },
      },
    }))).toBe(false);
  });

  it('does not treat terminal nodes as stale local agent nodes', () => {
    expect(isStalePrelaunchLocalAgentNode(assistantNode({
      status: AGENT_STATUS.completed,
      execution_data: {
        meta: { quick_reply: true },
      },
    }))).toBe(false);
  });
});

describe('markStaleLocalAgentNodeCancelled', () => {
  beforeEach(() => {
    mockedUpsertLocalNode.mockReset();
    mockedUpsertLocalNode.mockResolvedValue(undefined);
  });

  it('persists a cancelled terminal local node for stale quick replies', async () => {
    const queryClient = new QueryClient();
    const node = assistantNode({
      execution_data: {
        meta: { quick_reply: true },
      },
    });

    const marked = await markStaleLocalAgentNodeCancelled({
      queryClient,
      workspaceId: 'workspace-1',
      nodeId: node.id,
      node,
      reason: 'User cancelled stale quick reply.',
    });

    expect(marked).toBe(true);
    expect(mockedUpsertLocalNode).toHaveBeenCalledTimes(1);
    const [, , persisted] = mockedUpsertLocalNode.mock.calls[0] as [string, string, Message];
    expect(persisted.status).toBe(AGENT_STATUS.cancelled);
    expect(persisted.execution_data).toMatchObject({
      last_terminal_status: AGENT_STATUS.cancelled,
      stop_reason: 'User cancelled stale quick reply.',
      meta: {
        quick_reply: true,
        cancellation_reason: 'User cancelled stale quick reply.',
      },
    });
  });
});
