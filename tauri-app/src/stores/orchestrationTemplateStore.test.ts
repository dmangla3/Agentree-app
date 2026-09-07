import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORCHESTRATION_TEMPLATES } from '../orchestration/templates';

const commandMocks = vi.hoisted(() => ({
  getOrchestrationUserTemplates: vi.fn<() => Promise<string | null>>(),
  saveOrchestrationUserTemplates: vi.fn<() => Promise<null>>(),
}));

vi.mock('../generated/tauri-bindings', () => ({
  commands: commandMocks,
}));

import {
  hydrateNativeOrchestrationUserTemplates,
  mergeOrchestrationTemplates,
  useOrchestrationTemplateStore,
} from './orchestrationTemplateStore';

describe('orchestration template store', () => {
  beforeEach(() => {
    commandMocks.getOrchestrationUserTemplates.mockReset();
    commandMocks.getOrchestrationUserTemplates.mockResolvedValue(null);
    commandMocks.saveOrchestrationUserTemplates.mockReset();
    commandMocks.saveOrchestrationUserTemplates.mockResolvedValue(null);
    useOrchestrationTemplateStore.getState().clearUserTemplates();
  });

  it('merges built-in templates with normalized user templates', () => {
    const templates = mergeOrchestrationTemplates([{
      id: 'Migration Review',
      kind: 'orchestration',
      label: '#migration_review',
      prompt: 'Create two parallel #planner for {{request}}.',
      defaultAgentId: 'codex-agent',
    }]);

    expect(templates.length).toBe(DEFAULT_ORCHESTRATION_TEMPLATES.length + 1);
    expect(templates.find((template) => template.id === '@migration_review')).toEqual(expect.objectContaining({
      kind: 'orchestration',
      label: '#migration_review',
      source: 'user',
      defaultAgentId: 'codex-agent',
    }));
  });

  it('lets user templates override built-ins by normalized id and be deleted independently', () => {
    useOrchestrationTemplateStore.getState().upsertUserTemplate({
      id: '@planner',
      kind: 'node',
      label: '#planner',
      prompt: 'Custom plan for {{request}}',
      source: 'user',
    });

    expect(useOrchestrationTemplateStore.getState().templates.find((template) => template.id === '@planner'))
      .toEqual(expect.objectContaining({
        prompt: 'Custom plan for {{request}}',
        source: 'user',
      }));

    useOrchestrationTemplateStore.getState().deleteUserTemplate('planner');

    expect(useOrchestrationTemplateStore.getState().templates.find((template) => template.id === '@planner'))
      .toEqual(expect.objectContaining({
        prompt: 'Create a concrete implementation plan for {{request}}. Include validation steps and key risks.',
      }));
  });

  it('hydrates user templates from native storage so MCP-readable templates are the durable source', async () => {
    commandMocks.getOrchestrationUserTemplates.mockResolvedValue(JSON.stringify([{
      id: '#native_planner',
      kind: 'node',
      label: '#native_planner',
      prompt: 'Use the native prompt store for {{request}}.',
      source: 'user',
    }]));

    await hydrateNativeOrchestrationUserTemplates();

    expect(useOrchestrationTemplateStore.getState().userTemplates).toEqual([
      expect.objectContaining({
        id: '@native_planner',
        kind: 'node',
        label: '#native_planner',
        prompt: 'Use the native prompt store for {{request}}.',
        source: 'user',
      }),
    ]);
    expect(useOrchestrationTemplateStore.getState().templates.find((template) => template.id === '@native_planner'))
      .toEqual(expect.objectContaining({
        prompt: 'Use the native prompt store for {{request}}.',
      }));
  });
});
