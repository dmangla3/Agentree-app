import { describe, expect, it } from 'vitest';
import type { LocalNodeMessage } from './useLocalNodes';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import { applyDashboardMetricMessageProjection } from './useTrackingDashboardData';

const workspaceId = 'workspace-1';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: 'persisted content',
  parentId: 'user-1',
  workspaceId,
  createdAt: '2026-05-23T08:00:00.000Z',
  updatedAt: '2026-05-23T08:00:01.000Z',
  status: 'pending' as any,
  execution_data: {
    meta: { persisted: true },
  },
  ...overrides,
});

const localNode = (overrides: Partial<LocalNodeMessage> = {}): LocalNodeMessage => ({
  nodeId: 'assistant-1',
  workspaceId,
  syncStatus: 'local_only',
  finalizedAt: 1_778_191_200,
  retryAttempt: 0,
  message: {
    id: 'assistant-1',
    role: 'assistant',
    workspaceId,
    content: 'local content',
    status: 'pending' as any,
    execution_data: {
      meta: { local: true },
    },
  },
  ...overrides,
});

const projection = (overrides: Partial<AgentRunProjectedMessage> = {}): AgentRunProjectedMessage => ({
  ...message(),
  content: 'streamed content that dashboard should ignore',
  status: 'completed' as any,
  _optimisticStatus: 'completed',
  execution_data: {
    last_terminal_status: 'completed',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
    meta: { projected: true },
  },
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  updatedAt: '2026-05-23T08:05:00.000Z',
  ...overrides,
});

describe('applyDashboardMetricMessageProjection', () => {
  it('overlays terminal status and token usage without adopting streamed content', () => {
    const [projected] = applyDashboardMetricMessageProjection({
      workspaceId,
      messages: [message()],
      localMessages: [localNode()],
      projectionsById: {
        'assistant-1': projection(),
      },
    });

    expect(projected.status).toBe('completed');
    expect(projected.content).toBe('local content');
    expect(projected.execution_data).toMatchObject({
      last_terminal_status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      meta: {
        local: true,
        projected: true,
      },
    });
    expect(projected.promptTokens).toBe(10);
    expect(projected.completionTokens).toBe(5);
    expect(projected.totalTokens).toBe(15);
  });

  it('ignores non-terminal live projections', () => {
    const [projected] = applyDashboardMetricMessageProjection({
      workspaceId,
      messages: [message()],
      localMessages: [localNode()],
      projectionsById: {
        'assistant-1': projection({
          status: 'streaming' as any,
          _optimisticStatus: 'running',
          execution_data: {
            usage: {
              total_tokens: 999,
            },
          },
          totalTokens: 999,
        }),
      },
    });

    expect(projected.status).toBe('pending');
    expect(projected.totalTokens).toBeNull();
    expect(projected.content).toBe('local content');
  });
});
