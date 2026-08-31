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
    expect(prompt).toContain('core.implementer@1');
    expect(prompt).toContain('Prefer nodes that use the registry');
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
