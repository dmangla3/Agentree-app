import { describe, expect, it } from 'vitest';
import {
  getAssistantIdentityLabel,
  getAssistantIdentityParts,
  getAssistantProviderIconKind,
  getAssistantReasoningEffortFromExecutionData,
} from './assistantIdentity';

describe('getAssistantIdentityLabel', () => {
  it('uses the persisted llmModel before the agent display name', () => {
    expect(getAssistantIdentityLabel({
      agentName: 'Codex',
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
    })).toBe('GPT 5.5 High');
  });

  it('appends separate reasoning effort metadata to the model label', () => {
    expect(getAssistantIdentityLabel({
      agentName: 'Codex',
      llmModel: 'openai/gpt-5.5',
      llmProvider: 'openai',
      reasoningEffort: 'high',
    })).toBe('GPT 5.5 High');
  });

  it('does not duplicate effort when the model label already includes it', () => {
    expect(getAssistantIdentityLabel({
      agentName: 'Codex',
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
      reasoningEffort: 'high',
    })).toBe('GPT 5.5 High');
  });

  it('formats extra-high reasoning effort consistently', () => {
    expect(getAssistantIdentityLabel({
      llmModel: 'openai/gpt-5.5',
      llmProvider: 'openai',
      reasoningEffort: 'xhigh',
    })).toBe('GPT 5.5 Extra High');
  });

  it('restores the version decimal for dashed non-GPT model ids', () => {
    expect(getAssistantIdentityLabel({
      llmModel: 'claude-opus-4-8',
    })).toBe('Claude Opus 4.8');
  });
});

describe('getAssistantReasoningEffortFromExecutionData', () => {
  it('extracts reasoning effort from execution metadata', () => {
    expect(getAssistantReasoningEffortFromExecutionData({
      meta: {
        provider_reasoning_effort: 'low',
      },
    })).toBe('low');
  });
});

describe('getAssistantIdentityParts', () => {
  it('splits the metadata reasoning effort from the model label', () => {
    expect(getAssistantIdentityParts({
      llmModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    })).toEqual({ label: 'Claude Opus 4.8', reasoningEffort: 'High' });
  });

  it('splits an effort baked into the model id', () => {
    expect(getAssistantIdentityParts({
      llmModel: 'openai/gpt-5.5-high',
    })).toEqual({ label: 'GPT 5.5', reasoningEffort: 'High' });
  });

  it('splits the multi-word extra-high effort before the high effort', () => {
    expect(getAssistantIdentityParts({
      llmModel: 'openai/gpt-5.5',
      reasoningEffort: 'xhigh',
    })).toEqual({ label: 'GPT 5.5', reasoningEffort: 'Extra High' });
  });

  it('returns a null effort when none is present', () => {
    expect(getAssistantIdentityParts({
      llmModel: 'openai/gpt-5.5',
    })).toEqual({ label: 'GPT 5.5', reasoningEffort: null });
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
