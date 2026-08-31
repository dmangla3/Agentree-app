import { describe, expect, it } from 'vitest';
import { listEnabledUserFlowSources, normalizeUserFlowSources, writeUserFlowSources, USER_FLOW_STORE_KEY } from './userFlowStore';
import type { UserFlowSource } from './types';

function source(input: Partial<UserFlowSource> & Pick<UserFlowSource, 'id' | 'label' | 'source'>): UserFlowSource {
  return {
    scope: 'workspace',
    workspaceId: 'workspace-1',
    version: 1,
    enabled: true,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...input,
  };
}

function storage(initial?: unknown): Storage {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(USER_FLOW_STORE_KEY, JSON.stringify(initial));
  }
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('user flow source normalization', () => {
  it('normalizes, de-duplicates, and sorts enabled sources first by label', () => {
    const normalized = normalizeUserFlowSources([
      source({ id: 'disabled', label: 'Disabled', enabled: false, source: 'flow:\n  id: disabled\nnodes: []\nrun: []' }),
      source({ id: 'zeta', label: 'Zeta', source: 'flow:\n  id: zeta\nnodes: []\nrun: []' }),
      source({ id: 'alpha', label: 'Alpha', source: 'flow:\n  id: alpha\nnodes: []\nrun: []' }),
      source({ id: 'alpha', label: 'Alpha', source: 'old', version: 0 }),
      { id: 'bad' },
    ]);

    expect(normalized.map((flow) => flow.id)).toEqual(['alpha', 'zeta', 'disabled']);
  });

  it('lists enabled workspace and global user flow sources only', () => {
    const backingStore = storage({
      sources: [
        source({ id: 'workspace', label: 'Workspace', source: 'flow:\n  id: workspace\nnodes: []\nrun: []' }),
        source({ id: 'other-workspace', label: 'Other', workspaceId: 'workspace-2', source: 'flow:\n  id: other\nnodes: []\nrun: []' }),
        source({ id: 'global', label: 'Global', scope: 'global', workspaceId: null, source: 'flow:\n  id: global\nnodes: []\nrun: []' }),
        source({ id: 'disabled', label: 'Disabled', enabled: false, source: 'flow:\n  id: disabled\nnodes: []\nrun: []' }),
      ],
    });

    expect(listEnabledUserFlowSources({ workspaceId: 'workspace-1', storage: backingStore }).map((flow) => flow.id))
      .toEqual(['global', 'workspace']);
  });

  it('writes normalized sources back to storage', () => {
    const backingStore = storage();
    writeUserFlowSources([
      source({ id: 'zeta', label: 'Zeta', source: 'flow:\n  id: zeta\nnodes: []\nrun: []' }),
      source({ id: 'alpha', label: 'Alpha', source: 'flow:\n  id: alpha\nnodes: []\nrun: []' }),
    ], backingStore);

    const parsed = JSON.parse(backingStore.getItem(USER_FLOW_STORE_KEY) ?? '{}');
    expect(parsed.sources.map((flow: UserFlowSource) => flow.id)).toEqual(['alpha', 'zeta']);
  });
});
