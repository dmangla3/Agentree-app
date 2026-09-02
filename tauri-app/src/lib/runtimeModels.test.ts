import { describe, expect, it } from 'vitest';
import { runtimeModels } from './runtimeModels';

describe('runtimeModels', () => {
  it('includes the current Claude model families exposed by Anthropic', () => {
    const claudeFamilies = new Map(
      runtimeModels
        .filter((model) => model.provider === 'claude')
        .map((model) => [model.familyKey, model])
    );

    expect([...claudeFamilies.keys()]).toEqual([
      'claude:claude-fable-5',
      'claude:claude-opus-4-8',
      'claude:claude-sonnet-4-6',
      'claude:claude-haiku-4-5-20251001',
    ]);
  });

  it('uses the canonical Fable 5 model ID for Claude selector runs', () => {
    const fable = runtimeModels.find((model) => model.key === 'claude:claude-fable-5:high');

    expect(fable).toMatchObject({
      modelId: 'claude-fable-5',
      label: 'Claude Fable 5 High',
      familyLabel: 'Claude Fable 5',
      reasoningEffort: 'high',
    });
    expect(fable?.cliArgs).toContain('--model claude-fable-5');
    expect(fable?.cliArgs).toContain('--effort high');
  });

  it('uses the canonical Opus 4.8 model ID instead of the generic opus alias', () => {
    const opus = runtimeModels.find((model) => model.key === 'claude:claude-opus-4-8:high');

    expect(opus).toMatchObject({
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8 High',
    });
    expect(opus?.cliArgs).toContain('--model claude-opus-4-8');
  });
});
