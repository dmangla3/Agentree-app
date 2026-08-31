import { describe, expect, it } from 'vitest';
import { authorFlowFromNaturalLanguage, type FlowAuthoringAgent } from './flowAuthoring';
import { buildFlowAuthoringPrompt } from './flowAuthoringPrompt';

const validYaml = `flow:
  id: single_implementation
  label: Single Implementation
inputs:
  input:
    type: string
nodes:
  - use: core.implementer@1
    as: Implementer
run:
  - set: implementation
    call: Implementer
    parent: root
    args:
      request: input.input`;

describe('flow authoring', () => {
  it('builds prompt context with DSL and registry capabilities', () => {
    const prompt = buildFlowAuthoringPrompt('Run two implementers and review them.');

    expect(prompt).toContain('DSL contract');
    expect(prompt).toContain('registry:');
    expect(prompt).toContain('core.implementer@1');
    expect(prompt).toContain('add it under top-level "registry:"');
    expect(prompt).toContain('Prefer nodes that use the registry');
    expect(prompt).toContain('Set requiresFinalizedCommit: true only for implementation/fixer/synthesizer nodes');
    expect(prompt).toContain('Leave requiresFinalizedCommit false or omit it for planning, review, analysis');
    expect(prompt).toContain('Prefer core.handoff@1 as the final step');
    expect(prompt).toContain('ask clarifying questions only when actually required');
    expect(prompt).toContain('Prefer core.synthesizer@1 for combining candidate commits across implementation, planning, documentation, tests, and analysis');
    expect(prompt).toContain('Use typed params object form');
    expect(prompt).toContain('request: string');
    expect(prompt).toContain('commit[] -> commit[]');
    expect(prompt).toContain('requiresFinalizedCommit: false');
    expect(prompt).toContain('Known working flow patterns to adapt instead of inventing from scratch');
    expect(prompt).toContain('parallel_review_until_satisfied');
    expect(prompt).toContain('if the label/request says "synthesis", include a synthesizer call');
    expect(prompt).toContain('candidate_commits: candidates.commit');
    expect(prompt).toContain('planners.commit, never planners.commits');
    expect(prompt).toContain('Every registry addition must be used by at least one node entry with "use:"');
    expect(prompt).toContain('When a fixer produces a new commit, update the current commit variable');
    expect(prompt).toContain('core.handoff@1');
    expect(prompt).toContain('Run two implementers and review them.');
  });

  it('returns compiled review artifacts for valid agent YAML', async () => {
    const agent: FlowAuthoringAgent = {
      async complete() {
        return validYaml;
      },
    };

    const result = await authorFlowFromNaturalLanguage({
      request: 'Implement the request once.',
      workspaceId: 'workspace-1',
      agent,
      now: '2026-06-09T00:00:00.000Z',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.source).toEqual(expect.objectContaining({
      id: 'single_implementation',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      enabled: true,
      version: 1,
    }));
    expect(result.registryNodeIds).toEqual(['core.implementer@1']);
    expect(result.inlineNodeIds).toEqual([]);
    expect(result.definition.nodes[0].registryId).toBe('core.implementer@1');
  });

  it('returns registry additions and compiles the flow against the candidate registry', async () => {
    const agent: FlowAuthoringAgent = {
      async complete() {
        return `registry:
  - id: core.planner@1
    label: Planner
    params:
      request: string
    parent: root
    requiresFinalizedCommit: true
    prompt: "Create a high quality plan file for {{ request }}"
flow:
  id: parallel_planning
  label: Parallel Planning
inputs:
  input:
    type: string
nodes:
  - use: core.planner@1
    as: Planner
run:
  - set: plan
    call: Planner
    parent: root
    args:
      request: input.input`;
      },
    };

    const result = await authorFlowFromNaturalLanguage({
      request: 'Create a high quality plan.',
      agent,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.registryAdditionIds).toEqual(['core.planner@1']);
    expect(result.registryAdditions[0].requiresFinalizedCommit).toBe(true);
    expect(result.definition.nodes[0]).toEqual(expect.objectContaining({
      registryId: 'core.planner@1',
      prompt: 'Create a high quality plan file for {{ request }}',
    }));
  });

  it('feeds validation issues back for bounded repair', async () => {
    const prompts: string[] = [];
    const responses = [
      `flow:
  id: broken
nodes:
  - use: core.unknown@1
    as: Worker
run:
  - set: worker
    call: Worker`,
      validYaml,
    ];
    const agent: FlowAuthoringAgent = {
      async complete(prompt) {
        prompts.push(prompt);
        return responses.shift() ?? validYaml;
      },
    };

    const result = await authorFlowFromNaturalLanguage({
      request: 'Implement the request once.',
      agent,
      maxRepairAttempts: 1,
    });

    expect(result.status).toBe('ready');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Reusable node "core.unknown@1" is not registered.');
  });
});
