import { describe, expect, it } from 'vitest';
import { executeFlow, type FlowNodeRunner, type FlowNodeRunInput } from './flowExecutor';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';
import type { FlowDefinition, FlowNodeValue } from './types';
import { validateFlowDefinition } from './validateFlow';

function predefinedDefinition(): FlowDefinition {
  const result = validateFlowDefinition(parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source));
  if (!result.definition || result.issues.length > 0) {
    throw new Error(`Invalid predefined flow: ${JSON.stringify(result.issues)}`);
  }
  return result.definition;
}

function node(input: Partial<FlowNodeValue> & Pick<FlowNodeValue, 'id'>): FlowNodeValue {
  return {
    kind: 'node',
    status: 'complete',
    commit: null,
    message: '',
    ...input,
  };
}

describe('executeFlow', () => {
  it('runs the predefined review flow through a failing review and passing review', async () => {
    const calls: FlowNodeRunInput[] = [];
    const templateCounts = new Map<string, number>();
    const runner: FlowNodeRunner = {
      async runNode(input) {
        calls.push(input);
        const nextCount = (templateCounts.get(input.templateId) ?? 0) + 1;
        templateCounts.set(input.templateId, nextCount);

        if (input.templateId === 'Implementer') {
          return node({
            id: `impl-${nextCount}`,
            label: `Implementation ${nextCount}`,
            commit: `commit-${nextCount}`,
            message: `implementation ${nextCount}`,
          });
        }
        if (input.templateId === 'Judge') {
          expect(input.args.implementations).toEqual([
            expect.objectContaining({ id: 'impl-1' }),
            expect.objectContaining({ id: 'impl-2' }),
          ]);
          return node({
            id: 'judge-1',
            label: 'Judge',
            message: 'selected: impl-2\nverdict: fail',
          });
        }
        if (input.templateId === 'Reviewer') {
          if (nextCount === 1) {
            expect(input.args.input).toBe('Build the feature');
            expect(input.args.commit).toBe('commit-2');
            expect(input.args.fixer_node).toBeNull();
            expect(input.prompt).toContain('Original request:');
            expect(input.prompt).toContain('Build the feature');
            expect(input.prompt).toContain('Latest fixer response, if any:');
            expect(input.prompt).not.toContain('counterpoint: reviewer missed context');
            expect(input.prompt).not.toContain('implementation 2');
            expect(input.prompt).not.toContain('null');
            return node({ id: 'reviewer-1', label: 'Reviewer 1', message: 'verdict: fail' });
          }
          expect(input.args.input).toBe('Build the feature');
          expect(input.args.commit).toBe('commit-fix-1');
          expect(input.args.fixer_node).toEqual(expect.objectContaining({
            id: 'fixer-1',
            message: expect.stringContaining('counterpoint: reviewer missed context'),
          }));
          expect(input.prompt).toContain('Original request:');
          expect(input.prompt).toContain('Build the feature');
          expect(input.prompt).toContain('counterpoint: reviewer missed context');
          expect(input.prompt).not.toContain('implementation 2');
          return node({ id: 'reviewer-2', label: 'Reviewer 2', message: 'verdict: pass' });
        }
        if (input.templateId === 'Fixer') {
          return node({
            id: 'fixer-1',
            label: 'Fixer',
            commit: 'commit-fix-1',
            message: 'fixed\ncounterpoint: reviewer missed context',
          });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Build the feature', count: 2 },
      runner,
    });

    if (result.status !== 'completed') {
      throw new Error(result.reason ?? result.status);
    }
    expect(result.status).toBe('completed');
    expect(calls.slice(0, 2).map((call) => call.templateId)).toEqual(['Implementer', 'Implementer']);
    expect(calls[0].args).toEqual({ input: 'Build the feature' });
    expect(calls[1].args).toEqual({ input: 'Build the feature' });
    expect(calls[0].prompt).toBe(calls[1].prompt);
    expect(calls[2].templateId).toBe('Judge');
    expect(calls[3]).toEqual(expect.objectContaining({
      templateId: 'Reviewer',
      parent: expect.objectContaining({ id: 'judge-1' }),
    }));
    expect(calls[4]).toEqual(expect.objectContaining({
      templateId: 'Fixer',
      parent: expect.objectContaining({ id: 'impl-2' }),
    }));
    expect(calls[5]).toEqual(expect.objectContaining({
      templateId: 'Reviewer',
      parent: expect.objectContaining({ id: 'reviewer-1' }),
    }));
  });

  it('runs parallel implementer calls concurrently', async () => {
    let implementerStarts = 0;
    let releaseImplementers: (() => void) | null = null;
    const allImplementersStarted = new Promise<void>((resolve) => {
      releaseImplementers = resolve;
    });
    const runner: FlowNodeRunner = {
      async runNode(input) {
        if (input.templateId === 'Implementer') {
          implementerStarts += 1;
          const implementationIndex = implementerStarts;
          if (implementerStarts === 2) {
            releaseImplementers?.();
          }
          await allImplementersStarted;
          return node({ id: `impl-${implementationIndex}`, commit: `commit-${implementationIndex}` });
        }
        if (input.templateId === 'Judge') {
          return node({ id: 'judge', message: 'selected: impl-1\nverdict: pass' });
        }
        if (input.templateId === 'Reviewer') {
          return node({ id: 'reviewer', message: 'verdict: pass' });
        }
        return node({ id: input.templateId });
      },
    };

    const result = await Promise.race([
      executeFlow({
        definition: predefinedDefinition(),
        inputs: { input: 'Build concurrently', count: 2 },
        runner,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('parallel calls did not overlap')), 200)),
    ]);

    expect(result.status).toBe('completed');
  });

  it('stops with max_rounds_exhausted when review never passes', async () => {
    let fixerCount = 0;
    const runner: FlowNodeRunner = {
      async runNode(input) {
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: 'commit-1' });
        }
        if (input.templateId === 'Judge') {
          return node({ id: 'judge', message: 'selected: impl-1\nverdict: fail' });
        }
        if (input.templateId === 'Reviewer') {
          return node({ id: `reviewer-${fixerCount + 1}`, message: 'verdict: fail' });
        }
        if (input.templateId === 'Fixer') {
          fixerCount += 1;
          return node({ id: `fixer-${fixerCount}`, commit: `fix-${fixerCount}` });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Never passes', count: 1 },
      runner,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'stopped',
      reason: 'max_rounds_exhausted',
    }));
    expect(fixerCount).toBe(3);
  });

  it('stops when declared returns are invalid or missing', async () => {
    const runner: FlowNodeRunner = {
      async runNode(input) {
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: 'commit-1' });
        }
        if (input.templateId === 'Judge') {
          return node({ id: 'judge', message: 'verdict: maybe' });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Bad returns', count: 1 },
      runner,
    });

    expect(result.status).toBe('stopped');
    expect(result.reason).toContain('Return "verdict" must be one of');
    expect(result.reason).toContain('Missing declared return "selected"');
  });

  it('stops when selected node does not resolve to an implementation', async () => {
    const runner: FlowNodeRunner = {
      async runNode(input) {
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: 'commit-1' });
        }
        if (input.templateId === 'Judge') {
          return node({ id: 'judge', message: 'selected: missing-node\nverdict: pass' });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Missing selected', count: 1 },
      runner,
    });

    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('Node return "missing-node" does not match a selectable node.');
  });

  it('stops before review when the selected implementation has no commit', async () => {
    const calls: FlowNodeRunInput[] = [];
    const runner: FlowNodeRunner = {
      async runNode(input) {
        calls.push(input);
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: null, message: 'I need clarification before changing code.' });
        }
        if (input.templateId === 'Judge') {
          return node({ id: 'judge', message: 'selected: impl-1\nverdict: pass' });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Vague UI task', count: 1 },
      runner,
    });

    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('selected_implementation_has_no_commit');
    expect(calls.map((call) => call.templateId)).toEqual(['Implementer', 'Judge']);
  });
});
