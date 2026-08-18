import { describe, expect, it } from 'vitest';
import { compileFlowDefinition, FLOW_NODE_REGISTRY } from './flowNodeRegistry';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';

describe('flow node registry', () => {
  it('ships reusable node definitions for the parallel review flow', () => {
    expect(Object.keys(FLOW_NODE_REGISTRY)).toEqual(expect.arrayContaining([
      'core.implementer@1',
      'core.synthesizer@1',
      'core.reviewer@1',
      'core.fixer@1',
    ]));
    expect(FLOW_NODE_REGISTRY['core.implementer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('Produce one finalized implementation commit');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('use one candidate unchanged');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].returns).toBeUndefined();
    expect(FLOW_NODE_REGISTRY['core.fixer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.reviewer@1'].returns).toEqual({
      verdict: ['pass', 'fail'],
    });
  });

  it('resolves predefined flow node references before validation', () => {
    const result = compileFlowDefinition(parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source));

    expect(result.issues).toEqual([]);
    expect(result.definition?.nodes.map((node) => ({
      id: node.id,
      registryId: node.registryId,
      params: node.params,
      requiresFinalizedCommit: node.requiresFinalizedCommit,
    }))).toEqual([
      {
        id: 'Implementer',
        registryId: 'core.implementer@1',
        params: ['request'],
        requiresFinalizedCommit: true,
      },
      {
        id: 'Synthesizer',
        registryId: 'core.synthesizer@1',
        params: ['request', 'candidates'],
        requiresFinalizedCommit: true,
      },
      {
        id: 'Reviewer',
        registryId: 'core.reviewer@1',
        params: ['request', 'target_node', 'commit', 'latest_fix', 'criteria'],
        requiresFinalizedCommit: false,
      },
      {
        id: 'Fixer',
        registryId: 'core.fixer@1',
        params: ['review'],
        requiresFinalizedCommit: true,
      },
    ]);
  });

  it('rejects references to unknown reusable nodes', () => {
    const result = compileFlowDefinition({
      flow: { id: 'unknown_reusable_node' },
      nodes: [{ use: 'core.unknown@1', as: 'Worker' }],
      run: [{ set: 'worker', call: 'Worker' }],
    });

    expect(result.definition).toBeNull();
    expect(result.issues).toContainEqual({
      path: 'nodes.0.use',
      message: 'Reusable node "core.unknown@1" is not registered.',
    });
  });

  it('keeps inline node definitions available for private flow behavior', () => {
    const result = compileFlowDefinition({
      flow: { id: 'inline_node' },
      nodes: [{ id: 'PrivateWorker', parent: 'root', prompt: 'Work on {{ input }}', params: ['input'] }],
      run: [{ set: 'worker', call: 'PrivateWorker', args: { input: 'input.input' } }],
    });

    expect(result.issues).toEqual([]);
    expect(result.definition?.nodes[0]).toEqual(expect.objectContaining({
      id: 'PrivateWorker',
      prompt: 'Work on {{ input }}',
    }));
    expect(result.definition?.nodes[0].registryId).toBeUndefined();
  });
});
