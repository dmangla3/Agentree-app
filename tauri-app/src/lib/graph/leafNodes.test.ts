import { describe, expect, it } from 'vitest';
import { getLeafMessagesByRecency } from './leafNodes';

describe('getLeafMessagesByRecency', () => {
  it('returns messages with no children sorted by most recent activity', () => {
    const messages = [
      {
        id: 'root',
        parentId: null,
        createdAt: '2026-05-01T09:00:00.000Z',
        updatedAt: '2026-05-01T09:00:00.000Z',
      },
      {
        id: 'older-leaf',
        parentId: 'root',
        createdAt: '2026-05-02T09:00:00.000Z',
        updatedAt: '2026-05-02T09:00:00.000Z',
      },
      {
        id: 'branch-parent',
        parentId: 'root',
        createdAt: '2026-05-03T09:00:00.000Z',
        updatedAt: '2026-05-10T09:00:00.000Z',
      },
      {
        id: 'latest-leaf',
        parentId: 'branch-parent',
        createdAt: '2026-05-04T09:00:00.000Z',
        updatedAt: '2026-05-04T09:00:00.000Z',
        last_event_at: '2026-05-11T09:00:00.000Z',
      },
    ];

    expect(getLeafMessagesByRecency(messages).map((message) => message.id)).toEqual([
      'latest-leaf',
      'older-leaf',
    ]);
  });
});
