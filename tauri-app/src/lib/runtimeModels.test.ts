import { describe, expect, it } from 'vitest';
import {
  compareOpenCodeCatalogModels,
  getReasoningEffortSortOrder,
  getRuntimeModelByProviderAndId,
  runtimeModelsFromNativeCatalog,
  runtimeModelsFromOpenCodeCatalog,
} from './runtimeModels';

describe('runtime model projections', () => {
  it('keeps canonical identity while launching through a runtime CLI alias', () => {
    const models = runtimeModelsFromNativeCatalog([{
      provider: 'claude',
      canonicalModelId: 'claude-sonnet-5',
      cliModelId: 'sonnet',
      name: 'Claude Sonnet 5',
      description: 'Balanced coding model',
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      inputModalities: ['text'],
      outputModalities: ['text'],
      checkedAt: 123,
    }]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      key: 'claude:claude-sonnet-5:high',
      familyKey: 'claude:claude-sonnet-5',
      canonicalModelId: 'claude-sonnet-5',
      modelId: 'sonnet',
    });
    expect(models[0].cliArgs).toContain('--model sonnet');
    expect(getRuntimeModelByProviderAndId('claude', 'claude-sonnet-5', models)).toBe(models[0]);
    expect(getRuntimeModelByProviderAndId('claude', 'sonnet', models)).toBe(models[0]);
  });

  it('orders OpenCode models by lifecycle and newest release before label', () => {
    const models = [
      { label: 'Alpha preview', modelProvider: 'provider', releaseDate: '2027-01-01', status: 'alpha' as const },
      { label: 'Older stable', modelProvider: 'provider', releaseDate: '2025-01-01', status: 'active' as const },
      { label: 'Newer stable', modelProvider: 'provider', releaseDate: '2026-01-01', status: 'active' as const },
      { label: 'Deprecated', modelProvider: 'provider', releaseDate: '2028-01-01', status: 'deprecated' as const },
    ];

    expect(models.sort(compareOpenCodeCatalogModels).map((model) => model.label)).toEqual([
      'Newer stable',
      'Older stable',
      'Alpha preview',
      'Deprecated',
    ]);
  });

  it('sorts provider efforts using the selector order', () => {
    expect(getReasoningEffortSortOrder('claude', 'xhigh')).toBe(3);
    expect(getReasoningEffortSortOrder('claude', 'max')).toBe(4);
    expect(getReasoningEffortSortOrder('codex', 'max')).toBe(4);
    expect(getReasoningEffortSortOrder('codex', 'ultra')).toBe(5);
    expect(getReasoningEffortSortOrder('codex', 'unknown')).toBe(99);
  });

  it('builds profile-dependent OpenCode models with full provider ids and variants', () => {
    const models = runtimeModelsFromOpenCodeCatalog([{
      id: 'openrouter/qwen/qwen3:free',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      modelId: 'qwen/qwen3:free',
      name: 'Qwen 3 Free',
      reasoning: true,
      attachment: true,
      toolCall: true,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      variants: ['high'],
      contextWindow: 200000,
      maxOutputTokens: 64000,
      releaseDate: '2025-04-29',
      status: 'active',
      isFree: true,
    }]);

    expect(models).toEqual([
      expect.objectContaining({
        key: 'opencode:openrouter%2Fqwen%2Fqwen3%3Afree:high',
        provider: 'opencode',
        modelId: 'openrouter/qwen/qwen3:free',
        cliArgs: '--model openrouter/qwen/qwen3:free --variant high',
        capabilities: expect.objectContaining({
          inputModalities: ['text', 'image'],
          reasoning: true,
          toolCall: true,
        }),
        releaseDate: '2025-04-29',
        status: 'active',
        isFree: true,
      }),
    ]);
  });
});
