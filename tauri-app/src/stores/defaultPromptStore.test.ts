import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROMPT_DEFINITIONS, mergeDefaultPromptOverrides } from '../lib/prompts/defaultPrompts';

const commandMocks = vi.hoisted(() => ({
  getDefaultPromptOverrides: vi.fn<() => Promise<string | null>>(),
  saveDefaultPromptOverrides: vi.fn<(promptsJson: string) => Promise<null>>(),
}));

vi.mock('../generated/tauri-bindings', () => ({
  commands: commandMocks,
}));

import {
  getDefaultPromptOverridesSnapshot,
  getEffectiveDefaultPromptText,
  hydrateNativeDefaultPromptOverrides,
  useDefaultPromptStore,
} from './defaultPromptStore';

describe('default prompt store', () => {
  beforeEach(() => {
    commandMocks.getDefaultPromptOverrides.mockReset();
    commandMocks.getDefaultPromptOverrides.mockResolvedValue(null);
    commandMocks.saveDefaultPromptOverrides.mockReset();
    commandMocks.saveDefaultPromptOverrides.mockResolvedValue(null);
    useDefaultPromptStore.getState().clearUserPrompts();
  });

  it('merges user prompt overrides without changing other built-ins', () => {
    const prompts = mergeDefaultPromptOverrides([{
      id: 'dependency_guard',
      text: 'Custom dependency guard',
      updatedAt: '2026-06-21T00:00:00.000Z',
    }]);

    expect(prompts.find((prompt) => prompt.id === 'dependency_guard')).toEqual(expect.objectContaining({
      text: 'Custom dependency guard',
      source: 'user',
    }));
    expect(prompts.find((prompt) => prompt.id === 'artifact_path')).toEqual(expect.objectContaining({
      source: 'built_in',
    }));
  });

  it('normalizes empty, unknown, and default-equivalent overrides away', () => {
    const dependencyGuard = DEFAULT_PROMPT_DEFINITIONS.find((prompt) => prompt.id === 'dependency_guard');
    const prompts = mergeDefaultPromptOverrides([
      {
        id: 'dependency_guard',
        text: dependencyGuard?.defaultText ?? '',
      },
      {
        id: 'artifact_path',
        text: '   ',
      },
      {
        id: 'thread_title_none',
        text: 'Custom thread title behavior',
      },
      {
        id: 'unknown_prompt' as any,
        text: 'Ignored',
      },
    ]);

    expect(prompts.find((prompt) => prompt.id === 'dependency_guard')).toEqual(expect.objectContaining({
      source: 'built_in',
    }));
    expect(prompts.find((prompt) => prompt.id === 'artifact_path')).toEqual(expect.objectContaining({
      source: 'built_in',
    }));
    expect(prompts.find((prompt) => prompt.id === 'thread_title_none')).toEqual(expect.objectContaining({
      text: 'Custom thread title behavior',
      source: 'user',
    }));
  });

  it('rejects overrides that omit required prompt variables', () => {
    const prompts = mergeDefaultPromptOverrides([
      {
        id: 'agentree_context_envelope',
        text: 'Context: {{contextText}}\nRequest missing',
      },
      {
        id: 'thread_title_none',
        text: 'No variables needed here.',
      },
    ]);

    expect(prompts.find((prompt) => prompt.id === 'agentree_context_envelope')).toEqual(expect.objectContaining({
      source: 'built_in',
    }));
    expect(prompts.find((prompt) => prompt.id === 'thread_title_none')).toEqual(expect.objectContaining({
      text: 'No variables needed here.',
      source: 'user',
    }));
  });

  it('uses saved overrides when rendering effective prompt text', () => {
    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'agentree_context_envelope',
      text: 'Context: {{contextText}}\nRequest: {{userPrompt}}',
    });

    expect(getEffectiveDefaultPromptText('agentree_context_envelope', {
      contextText: 'Prior turn',
      userPrompt: 'Ship the fix',
    })).toBe('Context: Prior turn\nRequest: Ship the fix');
  });

  it('can reset one saved prompt back to the built-in text', () => {
    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'thread_title_none',
      text: 'Custom thread title behavior',
    });

    expect(getEffectiveDefaultPromptText('thread_title_none')).toBe('Custom thread title behavior');

    useDefaultPromptStore.getState().deleteUserPrompt('thread_title_none');

    expect(getEffectiveDefaultPromptText('thread_title_none')).toContain('set thread_title to null');
  });

  it('clears an existing override when saved text matches the built-in default', () => {
    const dependencyGuard = DEFAULT_PROMPT_DEFINITIONS.find((prompt) => prompt.id === 'dependency_guard');

    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'dependency_guard',
      text: 'Custom dependency guard',
    });
    expect(getDefaultPromptOverridesSnapshot()).toEqual([
      expect.objectContaining({
        id: 'dependency_guard',
        text: 'Custom dependency guard',
      }),
    ]);

    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'dependency_guard',
      text: dependencyGuard?.defaultText ?? '',
    });

    expect(getDefaultPromptOverridesSnapshot()).toEqual([]);
    expect(getEffectiveDefaultPromptText('dependency_guard')).toBe(dependencyGuard?.defaultText);
  });

  it('persists prompt override changes through native app storage', () => {
    useDefaultPromptStore.getState().upsertUserPrompt({
      id: 'dependency_guard',
      text: 'Custom dependency guard',
    });

    const persistedCalls = commandMocks.saveDefaultPromptOverrides.mock.calls;
    const persisted = persistedCalls[persistedCalls.length - 1]?.[0] ?? '[]';
    expect(JSON.parse(persisted)).toEqual([
      expect.objectContaining({
        id: 'dependency_guard',
        text: 'Custom dependency guard',
      }),
    ]);

    useDefaultPromptStore.getState().deleteUserPrompt('dependency_guard');

    expect(commandMocks.saveDefaultPromptOverrides).toHaveBeenLastCalledWith(JSON.stringify([]));
  });

  it('hydrates prompt overrides from native app storage', async () => {
    commandMocks.getDefaultPromptOverrides.mockResolvedValue(JSON.stringify([
      {
        id: 'thread_title_none',
        text: 'Native existing-thread title behavior',
      },
    ]));

    await hydrateNativeDefaultPromptOverrides();

    expect(getDefaultPromptOverridesSnapshot()).toEqual([
      expect.objectContaining({
        id: 'thread_title_none',
        text: 'Native existing-thread title behavior',
      }),
    ]);
    expect(getEffectiveDefaultPromptText('thread_title_none')).toBe('Native existing-thread title behavior');
  });
});
