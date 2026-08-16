import { describe, expect, it } from 'vitest';
import { interpolateFlowPrompt } from './interpolateFlowPrompt';

describe('interpolateFlowPrompt', () => {
  it('replaces scalar tokens', () => {
    expect(interpolateFlowPrompt('Please implement:\n{{ input }}', { input: 'Add tests' })).toBe(
      'Please implement:\nAdd tests'
    );
  });

  it('renders null optional tokens as blank text', () => {
    expect(interpolateFlowPrompt('Latest fixer response:\n{{ fixer_node }}\nEnd', { fixer_node: null })).toBe(
      'Latest fixer response:\n\nEnd'
    );
  });

  it('replaces node tokens with compact node reference blocks', () => {
    const result = interpolateFlowPrompt('Feedback:\n{{ reviewer_node }}', {
      reviewer_node: {
        kind: 'node',
        id: 'reviewer-1',
        label: 'Reviewer',
        status: 'complete',
        commit: null,
        message: 'This needs a focused regression test before the fix is complete.',
      },
    });

    expect(result).toContain('[Agentree node]');
    expect(result).toContain('id: reviewer-1');
    expect(result).toContain('label: Reviewer');
    expect(result).toContain('status: complete');
    expect(result).toContain('commit: none');
    expect(result).toContain('This needs a focused regression test');
    expect(result).not.toContain('{{');
  });

  it('renders node arrays as numbered compact references', () => {
    const result = interpolateFlowPrompt('{{ implementations }}', {
      implementations: [
        {
          kind: 'node',
          id: 'implementation-1',
          status: 'complete',
          commit: 'aaa111',
          message: 'First implementation',
        },
        {
          kind: 'node',
          id: 'implementation-2',
          status: 'complete',
          commit: 'bbb222',
          message: 'Second implementation',
        },
      ],
    });

    expect(result).toContain('1. [Agentree node]');
    expect(result).toContain('id: implementation-1');
    expect(result).toContain('2. [Agentree node]');
    expect(result).toContain('id: implementation-2');
    expect(result).not.toContain('{{');
  });
});
