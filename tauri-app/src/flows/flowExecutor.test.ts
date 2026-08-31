import { describe, expect, it } from 'vitest';
import { executeFlow, type FlowNodeRunner, type FlowNodeRunInput } from './flowExecutor';
import { compileFlowDefinition } from './flowNodeRegistry';
import { parseFlowYaml } from './parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from './predefinedFlows';
import type { FlowDefinition, FlowNodeValue } from './types';

function predefinedDefinition(): FlowDefinition {
  const result = compileFlowDefinition(parseFlowYaml(PREDEFINED_FLOW_SOURCES[0].source));
  if (!result.definition || result.issues.length > 0) {
    throw new Error(`Invalid predefined flow: ${JSON.stringify(result.issues)}`);
  }
  return result.definition;
}

function singleCallDefinition(): FlowDefinition {
  return {
    flow: { id: 'single_call' },
    nodes: [{
      id: 'Worker',
      params: ['request'],
      paramTypes: { request: ['string'] },
      parent: 'root',
      prompt: '{{ request }}',
    }],
    run: [{
      set: 'worker',
      call: 'Worker',
      args: {
        request: 'input.input',
      },
      parent: 'root',
    }],
  };
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
        if (input.templateId === 'Synthesizer') {
          expect(input.args.candidate_commits).toEqual(['commit-1', 'commit-2']);
          expect(input.args.request).toBe('Build the feature');
          expect(input.requiresFinalizedCommit).toBe(true);
          expect(input.prompt).toContain('commit-1');
          expect(input.prompt).toContain('commit-2');
          expect(input.prompt).not.toContain('implementation 1');
          expect(input.prompt).not.toContain('implementation 2');
          return node({
            id: 'synthesizer-1',
            label: 'Synthesizer',
            commit: 'commit-synth-1',
            message: 'Synthesized implementation 2 with useful error handling from implementation 1.',
          });
        }
        if (input.templateId === 'Reviewer') {
          if (nextCount === 1) {
            expect(input.args.request).toBe('Build the feature');
            expect(input.args.commit).toBe('commit-synth-1');
            expect(input.args.latest_fix_commit).toBeNull();
            expect(input.args.criteria).toBe('Review correctness against the original request.');
            expect(input.prompt).toContain('Original request:');
            expect(input.prompt).toContain('Build the feature');
            expect(input.prompt).toContain('Latest fix commit, if any:');
            expect(input.prompt).not.toContain('counterpoint: reviewer missed context');
            expect(input.prompt).not.toContain('Synthesized implementation 2');
            expect(input.prompt).not.toContain('null');
            return node({ id: 'reviewer-1', label: 'Reviewer 1', message: 'verdict: fail' });
          }
          expect(input.args.request).toBe('Build the feature');
          expect(input.args.commit).toBe('commit-fix-1');
          expect(input.args.latest_fix_commit).toBe('commit-fix-1');
          expect(input.prompt).toContain('Original request:');
          expect(input.prompt).toContain('Build the feature');
          expect(input.prompt).toContain('commit-fix-1');
          expect(input.prompt).not.toContain('counterpoint: reviewer missed context');
          expect(input.prompt).not.toContain('Synthesized implementation 2');
          return node({ id: 'reviewer-2', label: 'Reviewer 2', message: 'verdict: pass' });
        }
        if (input.templateId === 'Fixer') {
          expect(input.args.review).toEqual(expect.objectContaining({ id: 'reviewer-1' }));
          return node({
            id: 'fixer-1',
            label: 'Fixer',
            commit: 'commit-fix-1',
            message: 'fixed\ncounterpoint: reviewer missed context',
          });
        }
        if (input.templateId === 'Handoff') {
          expect(input.requiresFinalizedCommit).toBe(false);
          expect(input.parent).toEqual(expect.objectContaining({ id: 'fixer-1' }));
          expect(input.args.request).toBe('Build the feature');
          expect(input.args.phase).toBe('implementation handoff');
          expect(input.args.source_nodes).toEqual(expect.objectContaining({ id: 'fixer-1' }));
          expect(input.args.review).toEqual(expect.objectContaining({ id: 'reviewer-2' }));
          expect(input.prompt).toContain('prose-only node');
          expect(input.prompt).toContain('Summarize the final implementation');
          expect(input.prompt).toContain('reviewer-2');
          return node({ id: 'handoff-1', label: 'Handoff', message: '## What Matters\n- Fixed.' });
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
    expect(calls[0].args).toEqual({ request: 'Build the feature' });
    expect(calls[1].args).toEqual({ request: 'Build the feature' });
    expect(calls[0].prompt).toBe(calls[1].prompt);
    expect(calls[2].templateId).toBe('Synthesizer');
    expect(calls[3]).toEqual(expect.objectContaining({
      templateId: 'Reviewer',
      parent: 'root',
    }));
    expect(calls[4]).toEqual(expect.objectContaining({
      templateId: 'Fixer',
      parent: expect.objectContaining({ id: 'synthesizer-1' }),
    }));
    expect(calls[5]).toEqual(expect.objectContaining({
      templateId: 'Reviewer',
      parent: 'root',
    }));
    expect(calls[6]).toEqual(expect.objectContaining({
      templateId: 'Handoff',
      parent: expect.objectContaining({ id: 'fixer-1' }),
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
        if (input.templateId === 'Synthesizer') {
          return node({ id: 'synthesizer', commit: 'commit-synth', message: 'Using implementation 1 unchanged.' });
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
        if (input.templateId === 'Synthesizer') {
          return node({ id: 'synthesizer', commit: 'commit-synth', message: 'Synthesized the candidate commits.' });
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

  it('does not parse structured-looking synthesizer text as flow returns', async () => {
    const runner: FlowNodeRunner = {
      async runNode(input) {
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: 'commit-1' });
        }
        if (input.templateId === 'Synthesizer') {
          return node({
            id: 'synthesizer',
            commit: 'commit-synth',
            message: 'selected: missing-node\nverdict: maybe\nUsing the first candidate unchanged.',
          });
        }
        if (input.templateId === 'Reviewer') {
          expect(input.args.commit).toBe('commit-synth');
          expect(input.args.latest_fix_commit).toBeNull();
          expect(input.prompt).not.toContain('Using the first candidate unchanged');
          return node({ id: 'reviewer', message: 'verdict: pass' });
        }
        if (input.templateId === 'Handoff') {
          return node({ id: 'handoff' });
        }
        throw new Error(`Unexpected template ${input.templateId}`);
      },
    };

    const result = await executeFlow({
      definition: predefinedDefinition(),
      inputs: { input: 'Bad returns', count: 1 },
      runner,
    });

    expect(result.status).toBe('completed');
  });

  it('stops before review when the synthesized implementation has no commit', async () => {
    const calls: FlowNodeRunInput[] = [];
    const runner: FlowNodeRunner = {
      async runNode(input) {
        calls.push(input);
        if (input.templateId === 'Implementer') {
          return node({ id: 'impl-1', commit: null, message: 'I need clarification before changing code.' });
        }
        if (input.templateId === 'Synthesizer') {
          return node({ id: 'synthesizer', commit: null, message: 'No commit was produced.' });
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
    expect(result.reason).toBe('synthesized_implementation_has_no_commit');
    expect(calls.map((call) => call.templateId)).toEqual(['Implementer', 'Synthesizer']);
  });

  it('returns cancelled without launching nodes when already aborted', async () => {
    const controller = new AbortController();
    controller.abort('User cancelled flow.');
    const calls: FlowNodeRunInput[] = [];
    const runner: FlowNodeRunner = {
      async runNode(input) {
        calls.push(input);
        return node({ id: 'worker-1' });
      },
    };

    const result = await executeFlow({
      definition: singleCallDefinition(),
      inputs: { input: 'Build' },
      runner,
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.reason).toBe('User cancelled flow.');
    expect(calls).toHaveLength(0);
    expect(result.events).toEqual([{
      type: 'flow_cancelled',
      message: 'User cancelled flow.',
    }]);
  });

  it('passes cancellation context through node calls and emits launched node events', async () => {
    const controller = new AbortController();
    const runner: FlowNodeRunner = {
      async runNode(input) {
        expect(input.signal).toBe(controller.signal);
        input.onNodeLaunched?.({
          templateId: input.templateId,
          userNodeId: 'user-1',
          assistantNodeId: 'assistant-1',
        });
        return node({ id: 'assistant-1' });
      },
    };

    const result = await executeFlow({
      definition: singleCallDefinition(),
      inputs: { input: 'Build' },
      runner,
      signal: controller.signal,
    });

    expect(result.status).toBe('completed');
    expect(result.events).toEqual(expect.arrayContaining([
      {
        type: 'node_launched',
        templateId: 'Worker',
        userNodeId: 'user-1',
        nodeId: 'assistant-1',
        message: 'Launched Worker.',
      },
    ]));
  });

  it('returns cancelled when a child node is cancelled', async () => {
    const runner: FlowNodeRunner = {
      async runNode() {
        return node({ id: 'assistant-1', status: 'cancelled' });
      },
    };

    const result = await executeFlow({
      definition: singleCallDefinition(),
      inputs: { input: 'Build' },
      runner,
    });

    expect(result.status).toBe('cancelled');
    expect(result.reason).toBe('Node "assistant-1" ended with status "cancelled".');
    expect(result.events[result.events.length - 1]).toEqual({
      type: 'flow_cancelled',
      message: 'Node "assistant-1" ended with status "cancelled".',
    });
  });
});
