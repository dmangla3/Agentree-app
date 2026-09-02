import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from '../agent-runs/agentRunManager';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import { resolveNodeState } from './runStateResolver';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  content: 'persisted final',
  status: 'completed',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:00.000Z',
  execution_data: { last_terminal_status: 'completed' },
  ...overrides,
});

const projection = (overrides: Partial<AgentRunProjectedMessage> = {}): AgentRunProjectedMessage => ({
  ...message({
    content: 'live partial',
    status: 'preparing_worktree',
    execution_data: {},
  }),
  _optimisticStatus: 'preparing_worktree',
  _setupProgress: 'Preparing worktree...',
  ...overrides,
});

describe('resolveNodeState', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  });

  afterEach(() => {
    agentRunManager.clearAll();
    vi.unstubAllGlobals();
  });

  it('keeps authoritative persisted terminal status over stale live setup projection', () => {
    const state = resolveNodeState(message(), projection());

    expect(state.status).toBe('completed');
    expect(state.source).toBe('merged');
  });

  it('keeps authoritative persisted terminal status over stale actor setup status', () => {
    agentRunManager.seed(message({
      content: '',
      status: 'pending',
      execution_data: {},
    }), 'run-1');
    agentRunManager.dispatch('assistant-1', {
      type: 'setup_progress',
      status: 'preparing_worktree',
      progress: 'Preparing worktree...',
    });

    const state = resolveNodeState(message(), projection({ _optimisticStatus: undefined }));

    expect(state.status).toBe('completed');
  });
});
