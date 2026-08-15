import { describe, expect, it } from 'vitest';
import { getAssistantIdentityLabel } from './assistantIdentity';

describe('getAssistantIdentityLabel', () => {
  it('uses the persisted llmModel before the agent display name', () => {
    expect(getAssistantIdentityLabel({
      agentName: 'Codex',
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
    })).toBe('GPT 5.5 High');
  });
});
