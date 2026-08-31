import { describe, expect, it } from 'vitest';
import { buildFlowCatalog, getRunnableFlowDescriptors } from './flowCatalog';
import type { UserFlowSource } from './types';

function userSource(input: Partial<UserFlowSource> & Pick<UserFlowSource, 'id' | 'label' | 'source'>): UserFlowSource {
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

describe('user flow catalog persistence boundary', () => {
  it('surfaces invalid stored YAML as a disabled catalog error instead of crashing compilation', () => {
    const catalog = buildFlowCatalog({
      predefinedSources: [],
      userSources: [
        userSource({
          id: 'bad_yaml',
          label: 'Bad YAML',
          source: 'flow:\n  id: bad_yaml\nnodes:\n  - use: core.unknown@1\n    as: Worker\nrun:\n  - set: worker\n    call: Worker',
        }),
      ],
    });

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual(expect.objectContaining({
      id: 'bad_yaml',
      kind: 'user',
      definition: null,
      runnable: false,
    }));
    expect(catalog[0].issues).toContainEqual({
      path: 'nodes.0.use',
      message: 'Reusable node "core.unknown@1" is not registered.',
    });
    expect(getRunnableFlowDescriptors(catalog)).toEqual([]);
  });

  it('compiles predefined and user flows into runnable descriptors', () => {
    const catalog = buildFlowCatalog({
      userSources: [
        userSource({
          id: 'single_implementation',
          label: 'Single Implementation',
          source: `flow:
  id: single_implementation
  label: Single Implementation
inputs:
  input:
    type: string
nodes:
  - use: core.implementer@1
    as: Implementer
run:
  - set: implementation
    call: Implementer
    parent: root
    args:
      request: input.input`,
        }),
      ],
    });

    const runnable = getRunnableFlowDescriptors(catalog);
    expect(runnable.map((flow) => flow.id)).toEqual(expect.arrayContaining([
      'parallel_review_until_satisfied',
      'single_implementation',
    ]));
    expect(runnable.find((flow) => flow.id === 'single_implementation')?.sourceVersion).toBe(1);
  });
});
