import { describe, expect, it } from 'vitest';
import type { FlowRuntimeValue } from './types';
import { evaluateFlowCondition, evaluateFlowExpression } from './flowExpressions';

const scope: Record<string, FlowRuntimeValue> = {
  input: { count: 3 },
  chooser: {
    kind: 'node',
    id: 'chooser-node',
    status: 'complete',
    returns: {
      verdict: 'fail',
      selected: {
        kind: 'node',
        id: 'implementation-2',
        label: 'Implementation 2',
        status: 'complete',
        commit: 'abc123',
      },
    },
  },
  reviewer: {
    kind: 'node',
    id: 'reviewer-node',
    status: 'complete',
    returns: {
      verdict: 'pass',
    },
  },
  implementation: {
    kind: 'node',
    id: 'implementation-2',
    label: 'Implementation 2',
    status: 'complete',
    commit: 'abc123',
  },
  implementations: [
    {
      kind: 'node',
      id: 'implementation-1',
      label: 'Implementation 1',
      status: 'complete',
      commit: 'aaa111',
      message: 'First implementation details',
    },
    {
      kind: 'node',
      id: 'implementation-2',
      label: 'Implementation 2',
      status: 'complete',
      commit: 'bbb222',
      message: 'Second implementation details',
    },
  ],
  noCommitImplementation: {
    kind: 'node',
    id: 'implementation-empty',
    label: 'Implementation Empty',
    status: 'complete',
    commit: null,
  },
};

describe('flow expressions', () => {
  it('evaluates variable paths', () => {
    expect(evaluateFlowExpression('input.count', scope)).toEqual({ value: 3, issues: [] });
  });

  it('allows sentence literals for flow call arguments', () => {
    expect(evaluateFlowExpression('Review correctness against the original request.', scope)).toEqual({
      value: 'Review correctness against the original request.',
      issues: [],
    });
  });

  it('evaluates equality checks against bare enum literals', () => {
    expect(evaluateFlowCondition('chooser.verdict == fail', scope)).toEqual({ value: true, issues: [] });
    expect(evaluateFlowCondition('reviewer.verdict == pass', scope)).toEqual({ value: true, issues: [] });
  });

  it('evaluates equality checks against null literals', () => {
    expect(evaluateFlowCondition('noCommitImplementation.commit == null', scope)).toEqual({ value: true, issues: [] });
    expect(evaluateFlowCondition('implementation.commit == null', scope)).toEqual({ value: false, issues: [] });
  });

  it('evaluates node property access', () => {
    expect(evaluateFlowExpression('implementation.commit', scope)).toEqual({ value: 'abc123', issues: [] });
    expect(evaluateFlowExpression('chooser.selected', scope)).toEqual({
      value: {
        kind: 'node',
        id: 'implementation-2',
        label: 'Implementation 2',
        status: 'complete',
        commit: 'abc123',
      },
      issues: [],
    });
  });

  it('projects node properties across arrays without carrying sibling messages', () => {
    expect(evaluateFlowExpression('implementations.commit', scope)).toEqual({
      value: ['aaa111', 'bbb222'],
      issues: [],
    });
  });

  it('reports missing variables as structured errors', () => {
    expect(evaluateFlowExpression('missing.value', scope)).toEqual({
      value: null,
      issues: [{ path: 'missing.value', message: 'Missing flow value at "missing".' }],
    });
  });

  it('rejects unsupported operators', () => {
    expect(evaluateFlowCondition('chooser.verdict != fail', scope)).toEqual({
      value: false,
      issues: [{ path: 'chooser.verdict != fail', message: 'Only equality conditions are supported.' }],
    });
  });
});
