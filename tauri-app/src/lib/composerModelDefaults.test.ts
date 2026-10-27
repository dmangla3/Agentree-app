import { describe, expect, it } from 'vitest';
import {
  defaultRootRuntimeModelKey,
  resolveComposerDefaultAgentId,
} from './composerModelDefaults';
import { getRuntimeModelKey, runtimeModels } from './runtimeModels';

const agent = (key: string) => {
  const runtimeModel = runtimeModels.find((model) => model.key === key);
  if (!runtimeModel) throw new Error(`Missing runtime model: ${key}`);
  return {
    id: runtimeModel.key,
    name: runtimeModel.label,
    type: runtimeModel.provider,
    model_config: {
      model: runtimeModel.modelId,
      reasoningEffort: runtimeModel.reasoningEffort ?? null,
    },
    cliArgs: runtimeModel.cliArgs,
    promptFlag: runtimeModel.promptFlag,
  };
};

const agents = [
  agent('codex:gpt-5.5:high'),
  agent('codex:gpt-5.6-terra:medium'),
  agent('claude:claude-sonnet-5:high'),
];

describe('resolveComposerDefaultAgentId', () => {
  it('defaults root conversations to GPT-5.5 high', () => {
    expect(defaultRootRuntimeModelKey).toBe('codex:gpt-5.5:high');
    expect(resolveComposerDefaultAgentId({ agents, parentMessage: null })).toBe('codex:gpt-5.5:high');
  });

  it('inherits the parent conversation model and effort when available', () => {
    expect(resolveComposerDefaultAgentId({
      agents,
      parentMessage: {
        llmProvider: 'claude',
        llmModel: 'claude-sonnet-5',
        execution_data: {
          meta: {
            provider_reasoning_effort: 'high',
          },
        },
      },
    })).toBe('claude:claude-sonnet-5:high');
  });

  it('falls back to matching parent provider and model even if effort metadata is missing', () => {
    expect(resolveComposerDefaultAgentId({
      agents,
      parentMessage: {
        llmProvider: 'codex',
        llmModel: 'gpt-5.6-terra',
        execution_data: null,
      },
    })).toBe('codex:gpt-5.6-terra:medium');
  });

  it('uses visible models for a new conversation while preserving a hidden parent model', () => {
    const visibleAgents = agents.filter((item) => item.id !== 'codex:gpt-5.5:high');
    expect(resolveComposerDefaultAgentId({
      agents,
      fallbackAgents: visibleAgents,
      parentMessage: null,
    })).toBe('codex:gpt-5.6-terra:medium');

    expect(resolveComposerDefaultAgentId({
      agents,
      fallbackAgents: visibleAgents,
      parentMessage: {
        agent_id: 'codex:gpt-5.5:high',
      },
    })).toBe('codex:gpt-5.5:high');
  });

  it('returns no new-conversation default when every model is hidden', () => {
    expect(resolveComposerDefaultAgentId({
      agents,
      fallbackAgents: [],
      parentMessage: null,
    })).toBeNull();
  });

  it('inherits an exact dynamic OpenCode variant from the current agent catalog', () => {
    const dynamicId = getRuntimeModelKey('opencode', 'openrouter/vendor:model', 'extra:high')!;
    const dynamicAgent = {
      id: dynamicId,
      type: 'opencode',
      model_config: {
        model: 'openrouter/vendor:model',
        reasoningEffort: 'extra:high',
      },
    };

    expect(resolveComposerDefaultAgentId({
      agents: [...agents, dynamicAgent],
      parentMessage: {
        llmProvider: 'opencode',
        llmModel: 'openrouter/vendor:model',
        execution_data: {
          meta: { provider_reasoning_effort: 'extra:high' },
        },
      },
    })).toBe(dynamicId);
  });
});
