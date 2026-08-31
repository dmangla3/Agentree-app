import { describe, expect, it } from 'vitest';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';
import { compileFlowDefinition } from './flowNodeRegistry';
import { validateFlowDefinition } from './validateFlow';

describe('predefined flows', () => {
  it('ships a global parallel review flow', () => {
    expect(PREDEFINED_FLOW_SOURCES.map((flow) => flow.id)).toContain('parallel_review_until_satisfied');
  });

  it('keeps predefined flows global and workspace-independent', () => {
    const flow = PREDEFINED_FLOW_SOURCES.find((candidate) => candidate.id === 'parallel_review_until_satisfied');
    expect(flow?.scope).toBe('global');
    expect(flow?.source).toContain('parallel:');
    expect(flow?.source).toContain('loop:');
  });
});

describe('validateFlowDefinition', () => {
  it('validates the predefined parallel review flow', () => {
    const result = compileFlowDefinition(parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source));
    expect(result.issues).toEqual([]);
    expect(result.definition?.flow.id).toBe('parallel_review_until_satisfied');
  });

  it('accepts call-level parent expressions for reusable node placement', () => {
    const result = validateFlowDefinition({
      flow: { id: 'call_parent' },
      nodes: [
        { id: 'Reviewer', params: { request: 'string' }, parent: 'root', prompt: 'Review {{ request }}' },
      ],
      run: [
        { set: 'reviewer_parent', value: 'root' },
        { set: 'review', call: 'Reviewer', parent: 'reviewer_parent', args: { request: 'input.input' } },
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.definition?.run[1]).toEqual({
      set: 'review',
      call: 'Reviewer',
      parent: 'reviewer_parent',
      args: { request: 'input.input' },
    });
  });

  it('rejects duplicate node ids', () => {
    const result = validateFlowDefinition({
      flow: { id: 'duplicate_nodes' },
      nodes: [
        { id: 'Worker', parent: 'root', prompt: 'one' },
        { id: 'Worker', parent: 'root', prompt: 'two' },
      ],
      run: [],
    });

    expect(result.issues).toContainEqual({
      path: 'nodes.1.id',
      message: 'Node id "Worker" is already used.',
    });
  });

  it('rejects calls to missing node templates', () => {
    const result = validateFlowDefinition({
      flow: { id: 'missing_call' },
      nodes: [{ id: 'Worker', parent: 'root', prompt: 'work' }],
      run: [{ set: 'result', call: 'Reviewer' }],
    });

    expect(result.issues).toContainEqual({
      path: 'run.0.call',
      message: 'Call references unknown node template "Reviewer".',
    });
  });

  it('rejects args that are not declared as node params', () => {
    const result = validateFlowDefinition({
      flow: { id: 'bad_args' },
      nodes: [{ id: 'Worker', params: { input: 'string' }, parent: 'root', prompt: 'work' }],
      run: [{ set: 'result', call: 'Worker', args: { input: 'input.input', extra: 'input.extra' } }],
    });

    expect(result.issues).toContainEqual({
      path: 'run.0.args.extra',
      message: 'Argument "extra" is not declared in params for node template "Worker".',
    });
  });

  it('rejects legacy array params', () => {
    const result = validateFlowDefinition({
      flow: { id: 'legacy_params' },
      inputs: { input: { type: 'string' } },
      nodes: [{ id: 'Worker', params: ['request'], parent: 'root', prompt: 'work {{ request }}' }],
      run: [{ set: 'worker', call: 'Worker', args: { request: 'input.input' } }],
    });

    expect(result.issues).toContainEqual({
      path: 'nodes.0.params',
      message: 'Node params must be an object of typed params.',
    });
  });

  it('rejects unknown projected node fields in flow expressions', () => {
    const result = validateFlowDefinition({
      flow: { id: 'bad_projection' },
      inputs: { input: { type: 'string' } },
      nodes: [
        { id: 'Planner', params: { request: 'string' }, parent: 'root', prompt: 'plan {{ request }}' },
        {
          id: 'PlanSynthesizer',
          params: { candidate_commits: 'commit[]' },
          parent: 'root',
          prompt: 'synthesize {{ candidate_commits }}',
        },
      ],
      run: [
        {
          set: 'planners',
          parallel: {
            count: 3,
            call: 'Planner',
            args: { request: 'input.input' },
          },
        },
        {
          set: 'final_plan',
          call: 'PlanSynthesizer',
          args: { candidate_commits: 'planners.commits' },
        },
      ],
    });

    expect(result.issues).toContainEqual({
      path: 'run.1.args.candidate_commits',
      message: 'Expression "planners.commits" references unknown field "commits" on "planners". Did you mean "planners.commit"?',
    });
  });

  it('accepts singular projected node fields in flow expressions', () => {
    const result = validateFlowDefinition({
      flow: { id: 'good_projection' },
      inputs: { input: { type: 'string' } },
      nodes: [
        { id: 'Planner', params: { request: 'string' }, parent: 'root', prompt: 'plan {{ request }}' },
        {
          id: 'PlanSynthesizer',
          params: { candidate_commits: 'commit[]' },
          parent: 'root',
          prompt: 'synthesize {{ candidate_commits }}',
        },
      ],
      run: [
        {
          set: 'planners',
          parallel: {
            count: 3,
            call: 'Planner',
            args: { request: 'input.input' },
          },
        },
        {
          set: 'final_plan',
          call: 'PlanSynthesizer',
          args: { candidate_commits: 'planners.commit' },
        },
      ],
    });

    expect(result.issues).toEqual([]);
  });

  it('accepts typed object params and normalizes them on compiled templates', () => {
    const result = validateFlowDefinition({
      flow: { id: 'typed_params' },
      inputs: { input: { type: 'string' } },
      nodes: [
        {
          id: 'Worker',
          params: { request: 'string', source_nodes: 'agent | agent[]' },
          parent: 'root',
          prompt: 'work {{ request }}',
        },
      ],
      run: [
        { set: 'worker', call: 'Worker', args: { request: 'input.input' } },
        { set: 'handoff', call: 'Worker', args: { request: 'input.input', source_nodes: 'worker' } },
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.definition?.nodes[0].params).toEqual(['request', 'source_nodes']);
    expect(result.definition?.nodes[0].paramTypes).toEqual({
      request: ['string'],
      source_nodes: ['agent', 'agent[]'],
    });
  });

  it('rejects incompatible typed argument bindings before save or run', () => {
    const result = validateFlowDefinition({
      flow: { id: 'type_mismatch' },
      inputs: { input: { type: 'string' } },
      nodes: [
        { id: 'Implementer', params: { request: 'string' }, parent: 'root', requiresFinalizedCommit: true, prompt: 'work {{ request }}' },
        { id: 'Reviewer', params: { commit: 'commit' }, parent: 'root', prompt: 'review {{ commit }}' },
      ],
      run: [
        { set: 'implementations', parallel: { count: 2, call: 'Implementer', args: { request: 'input.input' } } },
        { set: 'reviewer', call: 'Reviewer', args: { commit: 'implementations.commit' } },
      ],
    });

    expect(result.issues).toContainEqual({
      path: 'run.1.args.commit',
      message: 'Reviewer.commit expected commit but expression "implementations.commit" resolves to commit[].',
    });
  });

  it('rejects non-positive loop max rounds', () => {
    const result = validateFlowDefinition({
      flow: { id: 'bad_loop' },
      nodes: [{ id: 'Worker', parent: 'root', prompt: 'work' }],
      run: [{ loop: { max_rounds: 0, steps: [] } }],
    });

    expect(result.issues).toContainEqual({
      path: 'run.0.loop.max_rounds',
      message: 'Loop max_rounds must be an integer from 1 to 8.',
    });
  });

  it('requires parallel count to be bounded by input max or literal <= 8', () => {
    const literalResult = validateFlowDefinition({
      flow: { id: 'bad_literal_count' },
      nodes: [{ id: 'Worker', parent: 'root', prompt: 'work' }],
      run: [{ set: 'workers', parallel: { count: 9, call: 'Worker' } }],
    });
    expect(literalResult.issues).toContainEqual({
      path: 'run.0.parallel.count',
      message: 'Parallel count must be an integer from 1 to 8.',
    });

    const inputResult = validateFlowDefinition({
      flow: { id: 'bad_input_count' },
      inputs: { count: { type: 'integer', min: 1, max: 9 } },
      nodes: [{ id: 'Worker', parent: 'root', prompt: 'work' }],
      run: [{ set: 'workers', parallel: { count: 'input.count', call: 'Worker' } }],
    });
    expect(inputResult.issues).toContainEqual({
      path: 'run.0.parallel.count',
      message: 'Input-backed parallel count must have min >= 1 and max <= 8.',
    });
  });

  it('rejects unsupported statement keys', () => {
    const result = validateFlowDefinition({
      flow: { id: 'unsupported_statement' },
      nodes: [{ id: 'Worker', parent: 'root', prompt: 'work' }],
      run: [{ set: 'result', wait: 'Worker' }],
    });

    expect(result.issues).toContainEqual({
      path: 'run.0',
      message: 'Statement must match exactly one supported shape.',
    });
  });
});
