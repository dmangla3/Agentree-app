import { describe, expect, it } from 'vitest';
import { buildFlowRunMermaid } from './flowMermaid';
import type { FlowDefinition } from './types';

const definition: FlowDefinition = {
  flow: { id: 'diagram', label: 'Diagram' },
  inputs: {
    count: { type: 'integer', default: 2, min: 1, max: 4 },
  },
  nodes: [
    { id: 'Worker', parent: 'root', prompt: 'work' },
    { id: 'Reviewer', parent: 'root', prompt: 'review' },
    { id: 'Fixer', parent: 'root', prompt: 'fix' },
  ],
  run: [
    { set: 'workers', parallel: { count: 'input.count', call: 'Worker', parent: 'root' } },
    { if: 'workers.commit == null', then: { stop: 'missing_commit' } },
    {
      loop: {
        max_rounds: 2,
        steps: [
          { set: 'reviewer', call: 'Reviewer' },
          { if: 'reviewer.verdict == pass', then: { break: true } },
          { set: 'fixer', call: 'Fixer' },
        ],
      },
    },
  ],
};

describe('buildFlowRunMermaid', () => {
  it('renders call, parallel, if, loop, stop, and break from the compiled AST', () => {
    const chart = buildFlowRunMermaid(definition);

    expect(chart).toContain('flowchart LR');
    expect(chart).toContain('subgraph parallel_');
    expect(chart).toContain('["Worker 1"]');
    expect(chart).toContain('["Worker 2"]');
    expect(chart).toContain('{"workers.commit == null"}');
    expect(chart).toContain('(("stop: missing_commit"))');
    expect(chart).toContain('{"loop max 2"}');
    expect(chart).toContain('["Reviewer"]');
    expect(chart).toContain('{"reviewer.verdict == pass"}');
    expect(chart).toContain('(("break"))');
    expect(chart).toContain('["Fixer"]');
    expect(chart).not.toContain('set workers');
  });

  it('can include set statements in debug mode', () => {
    const chart = buildFlowRunMermaid({
      ...definition,
      run: [{ set: 'commit', value: 'worker.commit' }, { set: 'worker', call: 'Worker' }],
    }, { debugSetStatements: true });

    expect(chart).toContain('["set commit"]');
  });
});
