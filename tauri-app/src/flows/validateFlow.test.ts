import { describe, expect, it } from 'vitest';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';
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
    const parsed = parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source);
    const result = validateFlowDefinition(parsed);
    expect(result.issues).toEqual([]);
    expect(result.definition?.flow.id).toBe('parallel_review_until_satisfied');
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
      nodes: [{ id: 'Worker', params: ['input'], parent: 'root', prompt: 'work' }],
      run: [{ set: 'result', call: 'Worker', args: { input: 'input.input', extra: 'input.extra' } }],
    });

    expect(result.issues).toContainEqual({
      path: 'run.0.args.extra',
      message: 'Argument "extra" is not declared in params for node template "Worker".',
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
