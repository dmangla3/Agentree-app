import { describe, expect, it } from 'vitest';
import { getThreadAwarenessSummary, type ThreadAwarenessMessageLike } from './threadAwareness';

const message = (overrides: Partial<ThreadAwarenessMessageLike>): ThreadAwarenessMessageLike => ({
  id: 'message',
  parentId: null,
  role: 'assistant',
  status: 'completed',
  createdAt: '2026-05-27T00:00:00.000Z',
  updatedAt: '2026-05-27T00:00:00.000Z',
  ...overrides,
});

describe('thread awareness summary', () => {
  it('counts completed assistant leaves after the last visit', () => {
    const result = getThreadAwarenessSummary({
      lastVisitedAt: Date.parse('2026-05-27T00:02:00.000Z'),
      messages: [
        message({ id: 'root-user', role: 'user', status: null, createdAt: '2026-05-27T00:00:00.000Z' }),
        message({ id: 'old-leaf', parentId: 'root-user', createdAt: '2026-05-27T00:01:00.000Z', updatedAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'new-leaf', parentId: 'root-user', createdAt: '2026-05-27T00:03:00.000Z', updatedAt: '2026-05-27T00:03:00.000Z' }),
        message({ id: 'user-leaf', role: 'user', parentId: 'root-user', status: null, createdAt: '2026-05-27T00:04:00.000Z', updatedAt: '2026-05-27T00:04:00.000Z' }),
      ],
    });

    expect(result.unreadCompletedLeafCount).toBe(1);
    expect(result.initialPreviewNodeId).toBe('new-leaf');
  });

  it('does not count completed assistant messages that have child messages', () => {
    const result = getThreadAwarenessSummary({
      lastVisitedAt: Date.parse('2026-05-27T00:00:00.000Z'),
      messages: [
        message({ id: 'assistant-parent', createdAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'follow-up-user', role: 'user', status: null, parentId: 'assistant-parent', createdAt: '2026-05-27T00:02:00.000Z' }),
      ],
    });

    expect(result.unreadCompletedLeafCount).toBe(0);
    expect(result.initialPreviewNodeId).toBe('assistant-parent');
    expect(result.previewNodeIds).toEqual(['assistant-parent']);
  });

  it('prefers unread leaves, then active nodes, then failed leaves for the initial preview', () => {
    const activeOnly = getThreadAwarenessSummary({
      lastVisitedAt: Date.parse('2026-05-27T00:10:00.000Z'),
      messages: [
        message({ id: 'completed-leaf', createdAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'running-node', status: 'running', createdAt: '2026-05-27T00:02:00.000Z' }),
      ],
    });
    expect(activeOnly.initialPreviewNodeId).toBe('running-node');

    const failedOnly = getThreadAwarenessSummary({
      lastVisitedAt: Date.parse('2026-05-27T00:10:00.000Z'),
      messages: [
        message({ id: 'completed-leaf', createdAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'failed-leaf', status: 'failed', createdAt: '2026-05-27T00:02:00.000Z' }),
      ],
    });
    expect(failedOnly.initialPreviewNodeId).toBe('failed-leaf');
  });

  it('orders preview node ids from newest to oldest by timestamp', () => {
    const result = getThreadAwarenessSummary({
      lastVisitedAt: 0,
      messages: [
        message({ id: 'older', createdAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'newer', createdAt: '2026-05-27T00:02:00.000Z' }),
      ],
    });

    expect(result.previewNodeIds).toEqual(['newer', 'older']);
  });

  it('limits thread hover previews to assistant messages', () => {
    const result = getThreadAwarenessSummary({
      lastVisitedAt: 0,
      messages: [
        message({ id: 'older-assistant', role: 'assistant', createdAt: '2026-05-27T00:01:00.000Z' }),
        message({ id: 'newer-user', role: 'user', status: null, createdAt: '2026-05-27T00:02:00.000Z' }),
      ],
    });

    expect(result.initialPreviewNodeId).toBe('older-assistant');
    expect(result.previewNodeIds).toEqual(['older-assistant']);
  });
});
