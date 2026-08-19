import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { removeMessageBranchFromCache } from './useMessages';

const message = (overrides: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: overrides.id,
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? '',
  parentId: overrides.parentId ?? null,
  workspaceId: overrides.workspaceId ?? 'workspace-1',
  createdAt: overrides.createdAt ?? '2026-05-28T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-05-28T00:00:00.000Z',
  status: overrides.status ?? null,
  execution_data: overrides.execution_data ?? null,
});

describe('removeMessageBranchFromCache', () => {
  it('removes the deleted root and all cached descendants', () => {
    const messages = [
      message({ id: 'root' }),
      message({ id: 'deleted-root', parentId: 'root' }),
      message({ id: 'deleted-child', parentId: 'deleted-root' }),
      message({ id: 'deleted-grandchild', parentId: 'deleted-child' }),
      message({ id: 'sibling', parentId: 'root' }),
    ];

    const remaining = removeMessageBranchFromCache(messages, 'deleted-root');

    expect(remaining.map((item) => item.id)).toEqual(['root', 'sibling']);
  });
});
