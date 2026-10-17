// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { applyLocalNodeMessages, useGraphMessages } from './useLiveMessages';
import type { Message } from '../stores/workspaceStore';
import type { LocalNodeMessage } from './useLocalNodes';

const baseMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: 'server preview',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-05-08T00:00:00.000Z',
  updatedAt: '2026-05-08T00:00:01.000Z',
  status: 'completed',
  execution_data: {
    meta: { server: true },
  },
  tags: ['keep'],
  comments: [{ type: 'note', content: 'server comment', author: 'user', timestamp: 'now' }],
  ...overrides,
});

const localMessage = (overrides: Partial<LocalNodeMessage> = {}): LocalNodeMessage => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  syncStatus: 'local_only',
  finalizedAt: 1_778_191_200,
  retryAttempt: 0,
  message: {
    id: 'assistant-1',
    role: 'assistant',
    workspaceId: 'workspace-1',
    content: 'local final markdown',
    status: 'completed',
    execution_data: {
      timeline: [{ type: 'tool_use', toolName: 'edit' }],
      meta: { local: true },
    },
    promptTokens: 11,
    completionTokens: 22,
    totalTokens: 33,
  },
  ...overrides,
});

const projectedMessage = (overrides: Partial<AgentRunProjectedMessage> = {}): AgentRunProjectedMessage => ({
  ...baseMessage(),
  content: 'server preview',
  updatedAt: '2026-05-29T00:00:00.000Z',
  _optimisticStatus: 'completed',
  ...overrides,
});

afterEach(() => {
  useAgentRunProjectionStore.getState().clearAllProjections();
});

describe('applyLocalNodeMessages', () => {
  it('preserves local terminal content and timeline over server or graph-safe data', () => {
    const [merged] = applyLocalNodeMessages(
      [baseMessage({ execution_data: { meta: { server: true }, timeline: [] } })],
      [localMessage()],
      'workspace-1',
    );

    expect(merged.content).toBe('local final markdown');
    expect(merged.execution_data.timeline).toEqual([{ type: 'tool_use', toolName: 'edit' }]);
    expect(merged.execution_data.meta).toEqual({ server: true, local: true });
    expect(merged.promptTokens).toBe(11);
    expect(merged.tags).toEqual(['keep']);
    expect(merged.comments?.[0]?.content).toBe('server comment');
  });

  it('adds a local-only finalized node when server data is missing', () => {
    const [merged] = applyLocalNodeMessages([], [localMessage()], 'workspace-1');

    expect(merged.id).toBe('assistant-1');
    expect(merged.content).toBe('local final markdown');
    expect(merged.execution_data.__local_authority.syncStatus).toBe('local_only');
  });

  it('normalizes millisecond timestamp strings from local payloads', () => {
    const [merged] = applyLocalNodeMessages(
      [],
      [localMessage({ message: { ...localMessage().message, updatedAt: '1778211468369' } })],
      'workspace-1',
    );

    expect(Number.isFinite(new Date(merged.updatedAt).getTime())).toBe(true);
    expect(merged.updatedAt).toBe('2026-05-08T03:37:48.369Z');
  });

  it('ignores local records from other workspaces', () => {
    const messages = applyLocalNodeMessages(
      [baseMessage()],
      [localMessage({ workspaceId: 'workspace-2' })],
      'workspace-1',
    );

    expect(messages[0].content).toBe('server preview');
  });
});

describe('useGraphMessages', () => {
  it('does not detach a running projection when its transient parent id is blank', () => {
    useAgentRunProjectionStore.getState().setProjectionForNode('assistant-1', projectedMessage({
      parentId: '',
      status: 'running',
      _optimisticStatus: 'running',
    }));

    const { result } = renderHook(() => useGraphMessages('workspace-1', [baseMessage()]));

    expect(result.current[0].parentId).toBe('user-1');
  });

  it('keeps persisted updatedAt when hover hydration projects an already-completed node', () => {
    useAgentRunProjectionStore.getState().setProjectionForNode('assistant-1', projectedMessage());

    const { result } = renderHook(() => useGraphMessages('workspace-1', [baseMessage()]));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].updatedAt).toBe('2026-05-08T00:00:01.000Z');
  });

  it('keeps persisted updatedAt when hover hydration projects fuller completed content', () => {
    useAgentRunProjectionStore.getState().setProjectionForNode('assistant-1', projectedMessage({
      content: 'server preview plus hydrated terminal output',
    }));

    const { result } = renderHook(() => useGraphMessages('workspace-1', [baseMessage()]));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].content).toBe('server preview plus hydrated terminal output');
    expect(result.current[0].updatedAt).toBe('2026-05-08T00:00:01.000Z');
  });
});
