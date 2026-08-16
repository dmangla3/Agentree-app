import { describe, expect, it } from 'vitest';
import {
  createSubgraphFilterState,
  getSubgraphMessageIds,
  shouldClearSubgraphForFocus,
} from './graphSubgraphFilter';
import type { Message } from '../stores/workspaceStore';

const makeMessage = (id: string, parentId: string | null): Message => ({
  id,
  parentId,
  role: id.startsWith('user') ? 'user' : 'assistant',
  content: id,
  workspaceId: 'workspace-1',
  status: null,
  agent_id: null,
  execution_data: null,
  createdAt: '2026-05-16T00:00:00.000Z',
  updatedAt: '2026-05-16T00:00:00.000Z',
});

describe('graph subgraph filter', () => {
  it('collects only the root node and descendants', () => {
    const messages = [
      makeMessage('user-root', null),
      makeMessage('assistant-parent', 'user-root'),
      makeMessage('user-target', 'assistant-parent'),
      makeMessage('assistant-child', 'user-target'),
      makeMessage('user-grandchild', 'assistant-child'),
      makeMessage('assistant-grandchild', 'user-grandchild'),
      makeMessage('user-sibling', 'assistant-parent'),
      makeMessage('assistant-sibling-child', 'user-sibling'),
    ];

    expect(Array.from(getSubgraphMessageIds(messages, 'user-target')).sort()).toEqual([
      'assistant-child',
      'assistant-grandchild',
      'user-grandchild',
      'user-target',
    ]);
  });

  it('overrides graph filters as descendants-only while a subgraph root is active', () => {
    const fallback = {
      matchingMessageIds: new Set(['assistant-parent']),
      filterActive: false,
      hasNodeTypeFilter: false,
      keepAncestors: true,
      keepDescendants: false,
    };

    const filtered = createSubgraphFilterState('user-target', new Set(['user-target', 'assistant-child']), fallback);

    expect(filtered.filterActive).toBe(true);
    expect(filtered.hasNodeTypeFilter).toBe(true);
    expect(filtered.keepAncestors).toBe(false);
    expect(filtered.keepDescendants).toBe(false);
    expect(Array.from(filtered.matchingMessageIds).sort()).toEqual(['assistant-child', 'user-target']);
  });

  it('clears an active subgraph when focus moves outside it', () => {
    const subgraphIds = new Set(['user-target', 'assistant-child']);

    expect(shouldClearSubgraphForFocus('user-target', subgraphIds, 'assistant-child')).toBe(false);
    expect(shouldClearSubgraphForFocus('user-target', subgraphIds, 'user-target')).toBe(false);
    expect(shouldClearSubgraphForFocus('user-target', subgraphIds, 'new-root-thread')).toBe(true);
    expect(shouldClearSubgraphForFocus(null, subgraphIds, 'new-root-thread')).toBe(false);
  });
});
