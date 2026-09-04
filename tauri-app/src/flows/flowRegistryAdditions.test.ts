import { describe, expect, it } from 'vitest';
import { extractFlowRegistryAdditions } from './flowRegistryAdditions';
import type { FlowNodeRegistry } from './flowNodeRegistry';

const baseRegistry: FlowNodeRegistry = {
  'core.worker@1': {
    id: 'core.worker@1',
    label: 'Worker',
    params: { request: 'string' },
    parent: 'root',
    prompt: 'Work on {{ request }}',
    requiresFinalizedCommit: false,
  },
};

describe('extractFlowRegistryAdditions', () => {
  it('ignores embedded registry entries that duplicate an existing reusable node definition', () => {
    const result = extractFlowRegistryAdditions({
      registry: [{
        id: 'core.worker@1',
        label: 'Worker',
        params: { request: 'string' },
        parent: 'root',
        prompt: 'Work on {{ request }}',
      }],
    }, baseRegistry);

    expect(result).toEqual({ registryAdditions: [], issues: [] });
  });

  it('rejects embedded registry entries that conflict with an existing reusable node definition', () => {
    const result = extractFlowRegistryAdditions({
      registry: [{
        id: 'core.worker@1',
        label: 'Worker',
        params: { request: 'string' },
        parent: 'root',
        prompt: 'Do different work for {{ request }}',
      }],
    }, baseRegistry);

    expect(result.registryAdditions).toEqual([]);
    expect(result.issues).toContainEqual({
      path: 'registry.0.id',
      message: 'Reusable node "core.worker@1" already exists with a different definition. Remove this registry entry to use the existing reusable node, or choose a new id for the new definition.',
    });
  });
});
