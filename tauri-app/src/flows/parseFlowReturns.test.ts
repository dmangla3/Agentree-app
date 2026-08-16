import { describe, expect, it } from 'vitest';
import { parseFlowReturns } from './parseFlowReturns';
import type { FlowNodeValue } from './types';

const selectableNodes: FlowNodeValue[] = [
  {
    kind: 'node',
    id: 'node-1',
    label: 'First implementation',
    status: 'complete',
    commit: 'aaa111',
  },
  {
    kind: 'node',
    id: 'node-2',
    label: 'Second implementation',
    status: 'complete',
    commit: 'bbb222',
  },
];

describe('parseFlowReturns', () => {
  it('extracts verdict from final plain lines', () => {
    const result = parseFlowReturns({
      message: 'The implementation looks good.\n\nverdict: pass',
      returns: { verdict: ['pass', 'fail'] },
    });

    expect(result).toEqual({ values: { verdict: 'pass' }, issues: [] });
  });

  it('extracts selected node ids', () => {
    const result = parseFlowReturns({
      message: 'I choose the second implementation.\nselected: node-2',
      returns: { selected: 'node' },
      selectableNodes,
    });

    expect(result).toEqual({ values: { selected: selectableNodes[1] }, issues: [] });
  });

  it('accepts fenced YAML footers', () => {
    const result = parseFlowReturns({
      message: 'Review complete.\n\n```yaml\nverdict: pass\n```',
      returns: { verdict: ['pass', 'fail'] },
    });

    expect(result).toEqual({ values: { verdict: 'pass' }, issues: [] });
  });

  it('ignores earlier mentions and scans from the bottom', () => {
    const result = parseFlowReturns({
      message: 'An earlier example might say verdict: fail.\n\nFinal answer:\nverdict: pass',
      returns: { verdict: ['pass', 'fail'] },
    });

    expect(result).toEqual({ values: { verdict: 'pass' }, issues: [] });
  });

  it('validates enum returns against declared values', () => {
    const result = parseFlowReturns({
      message: 'verdict: maybe',
      returns: { verdict: ['pass', 'fail'] },
    });

    expect(result).toEqual({
      values: {},
      issues: [{ path: 'returns.verdict', message: 'Return "verdict" must be one of: pass, fail.' }],
    });
  });

  it('maps selected node labels when unambiguous', () => {
    const result = parseFlowReturns({
      message: 'selected: Second implementation',
      returns: { selected: 'node' },
      selectableNodes,
    });

    expect(result).toEqual({ values: { selected: selectableNodes[1] }, issues: [] });
  });

  it('reports missing declared returns', () => {
    const result = parseFlowReturns({
      message: 'No flow footer today.',
      returns: { verdict: ['pass', 'fail'] },
    });

    expect(result).toEqual({
      values: {},
      issues: [{ path: 'returns.verdict', message: 'Missing declared return "verdict".' }],
    });
  });
});
