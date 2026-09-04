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
      'core.handoff@1',
      'core.fixer@1',
    ]));
    expect(FLOW_NODE_REGISTRY['core.implementer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('Produce one finalized commit that best satisfies the request');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('plans, documentation, tests, analysis');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('Do not convert a planning, documentation, testing, or analysis task into implementation work');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].prompt).toContain('use one candidate unchanged');
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].returns).toBeUndefined();
    expect(FLOW_NODE_REGISTRY['core.synthesizer@1'].params).toEqual({
      request: 'string',
      candidate_commits: 'commit[]',
    });
    expect(FLOW_NODE_REGISTRY['core.fixer@1'].requiresFinalizedCommit).toBe(true);
    expect(FLOW_NODE_REGISTRY['core.reviewer@1'].returns).toEqual({
      verdict: ['pass', 'fail'],
    });
    expect(FLOW_NODE_REGISTRY['core.handoff@1'].requiresFinalizedCommit).toBe(false);
    expect(FLOW_NODE_REGISTRY['core.handoff@1'].returns).toBeUndefined();
    expect(FLOW_NODE_REGISTRY['core.handoff@1'].prompt).toContain('prose-only node');
    expect(FLOW_NODE_REGISTRY['core.handoff@1'].prompt).toContain('Quick Checks');
  });

  it('resolves predefined flow node references before validation', () => {
    const result = compileFlowDefinition(parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source));

    expect(result.issues).toEqual([]);
    expect(result.definition?.nodes.map((node) => ({
      id: node.id,
      registryId: node.registryId,
      params: node.params,
      paramTypes: node.paramTypes,
      requiresFinalizedCommit: node.requiresFinalizedCommit,
    }))).toEqual([
      {
        id: 'Implementer',
        registryId: 'core.implementer@1',
        params: ['request'],
        paramTypes: { request: ['string'] },
        requiresFinalizedCommit: true,
      },
      {
        id: 'Synthesizer',
        registryId: 'core.synthesizer@1',
        params: ['request', 'candidate_commits'],
        paramTypes: { request: ['string'], candidate_commits: ['commit[]'] },
        requiresFinalizedCommit: true,
      },
      {
        id: 'Reviewer',
        registryId: 'core.reviewer@1',
        params: ['request', 'commit', 'latest_fix_commit', 'criteria'],
        paramTypes: { request: ['string'], commit: ['commit'], latest_fix_commit: ['commit'], criteria: ['string'] },
        requiresFinalizedCommit: false,
      },
      {
        id: 'Fixer',
        registryId: 'core.fixer@1',
        params: ['review'],
        paramTypes: { review: ['agent'] },
        requiresFinalizedCommit: true,
      },
      {
        id: 'Handoff',
        registryId: 'core.handoff@1',
        params: ['request', 'phase', 'source_nodes', 'review', 'focus'],
        paramTypes: {
          request: ['string'],
          phase: ['string'],
          source_nodes: ['agent', 'agent[]'],
          review: ['agent', 'string'],
          focus: ['string'],
        },
        requiresFinalizedCommit: false,
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
      message: expect.stringContaining('Reusable node "core.unknown@1" is not registered. Use a known registry id or define "core.unknown@1" under top-level registry in this YAML.'),
    });
  });

  it('resolves reusable node references from a supplied candidate registry', () => {
    const result = compileFlowDefinition({
      flow: { id: 'candidate_registry' },
      nodes: [{ use: 'core.planner@1', as: 'Planner' }],
      run: [{ set: 'planner', call: 'Planner', args: { request: 'input.input' } }],
    }, {
      ...FLOW_NODE_REGISTRY,
      'core.planner@1': {
        id: 'core.planner@1',
        label: 'Planner',
        params: { request: 'string' },
        parent: 'root',
        requiresFinalizedCommit: true,
        prompt: 'Plan {{ request }}',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.definition?.nodes[0]).toEqual(expect.objectContaining({
      id: 'Planner',
      registryId: 'core.planner@1',
      prompt: 'Plan {{ request }}',
    }));
  });

  it('keeps inline node definitions available for private flow behavior', () => {
    const result = compileFlowDefinition({
      flow: { id: 'inline_node' },
      nodes: [{ id: 'PrivateWorker', parent: 'root', prompt: 'Work on {{ input }}', params: { input: 'string' } }],
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
