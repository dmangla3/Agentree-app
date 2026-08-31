import { describe, expect, it } from 'vitest';
import {
  buildUserFlowNodeRegistry,
  readUserFlowNodeDefinitions,
  saveUserFlowNodeDefinitions,
  USER_FLOW_NODE_REGISTRY_STORE_KEY,
} from './userFlowNodeRegistryStore';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('user flow node registry store', () => {
  it('saves reusable node templates and exposes them as a registry map', () => {
    const backingStore = storage();
    const saved = saveUserFlowNodeDefinitions({
      now: '2026-06-09T00:00:00.000Z',
      definitions: [{
        id: 'core.planner@1',
        label: 'Planner',
        params: { request: 'string' },
        parent: 'root',
        requiresFinalizedCommit: true,
        prompt: 'Create a plan for {{ request }}',
      }],
    }, backingStore);

    expect(saved[0]).toEqual(expect.objectContaining({
      id: 'core.planner@1',
      version: 1,
      enabled: true,
    }));
    expect(saved[0].params).toEqual({ request: 'string' });
    expect(JSON.parse(backingStore.getItem(USER_FLOW_NODE_REGISTRY_STORE_KEY) ?? '{}').definitions).toHaveLength(1);
    const registry = buildUserFlowNodeRegistry(readUserFlowNodeDefinitions(backingStore));
    expect(registry['core.planner@1'].prompt).toContain('Create a plan');
    expect(registry['core.planner@1'].params).toEqual({ request: 'string' });
  });

  it('rejects attempts to overwrite built-in node ids', () => {
    expect(() => saveUserFlowNodeDefinitions({
      definitions: [{
        id: 'core.implementer@1',
        label: 'Replacement',
        params: { request: 'string' },
        parent: 'root',
        prompt: 'Replace {{ request }}',
      }],
    }, storage())).toThrow('already built in');
  });
});
