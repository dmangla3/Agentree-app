import { describe, expect, it } from 'vitest';
import { getAssistantIdentityLabel, getAssistantProviderIconKind } from './assistantIdentity';

describe('getAssistantIdentityLabel', () => {
  it('uses the persisted llmModel before the agent display name', () => {
    expect(getAssistantIdentityLabel({
      agentName: 'Codex',
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
    })).toBe('GPT 5.5 High');
  });
});

describe('getAssistantProviderIconKind', () => {
  it('uses Codex for native Codex provider messages', () => {
    expect(getAssistantProviderIconKind({
      llmModel: 'gpt-5.5-high',
      llmProvider: 'codex',
    })).toBe('codex');
  });

  it('uses Claude for native Claude provider messages', () => {
    expect(getAssistantProviderIconKind({
      llmModel: 'claude-sonnet-4-6',
      llmProvider: 'claude',
    })).toBe('claude');
  });

  it('keeps generic OpenAI model messages on the fallback icon', () => {
    expect(getAssistantProviderIconKind({
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
    })).toBe('generic');
  });
});
