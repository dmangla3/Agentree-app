import { describe, expect, it } from 'vitest';
import type { FlowRuntimeValue } from './types';
import { evaluateFlowCondition, evaluateFlowExpression } from './flowExpressions';

const scope: Record<string, FlowRuntimeValue> = {
  input: { count: 3 },
  judge: {
    kind: 'node',
    id: 'judge-node',
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
    expect(evaluateFlowCondition('judge.verdict == fail', scope)).toEqual({ value: true, issues: [] });
    expect(evaluateFlowCondition('reviewer.verdict == pass', scope)).toEqual({ value: true, issues: [] });
  });

  it('evaluates equality checks against null literals', () => {
    expect(evaluateFlowCondition('noCommitImplementation.commit == null', scope)).toEqual({ value: true, issues: [] });
    expect(evaluateFlowCondition('implementation.commit == null', scope)).toEqual({ value: false, issues: [] });
  });

  it('evaluates node property access', () => {
    expect(evaluateFlowExpression('implementation.commit', scope)).toEqual({ value: 'abc123', issues: [] });
    expect(evaluateFlowExpression('judge.selected', scope)).toEqual({
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

  it('reports missing variables as structured errors', () => {
    expect(evaluateFlowExpression('missing.value', scope)).toEqual({
      value: null,
      issues: [{ path: 'missing.value', message: 'Missing flow value at "missing".' }],
    });
  });

  it('rejects unsupported operators', () => {
    expect(evaluateFlowCondition('judge.verdict != fail', scope)).toEqual({
      value: false,
      issues: [{ path: 'judge.verdict != fail', message: 'Only equality conditions are supported.' }],
    });
  });
});
