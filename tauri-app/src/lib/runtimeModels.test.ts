import { describe, expect, it } from 'vitest';
import {
  compareOpenCodeCatalogModels,
  getReasoningEffortSortOrder,
  getRuntimeModelByKey,
  getRuntimeModelByProviderAndId,
  getRuntimeModelFamilyKey,
  getRuntimeModelKey,
  parseRuntimeModelKey,
  reasoningEffortsByProvider,
  runtimeModels,
  runtimeModelsFromNativeCatalog,
  runtimeModelsFromOpenCodeCatalog,
} from './runtimeModels';

const openCodeModel = {
  id: 'openrouter/vendor:model/name',
  providerId: 'openrouter',
  providerName: 'OpenRouter',
  modelId: 'vendor:model/name',
  name: 'Dynamic Model',
  reasoning: true,
  attachment: false,
  toolCall: true,
  inputModalities: ['text'],
  outputModalities: ['text'],
  variants: ['extra:high'],
  contextWindow: null,
  maxOutputTokens: null,
  releaseDate: null,
  status: 'active',
  isFree: false,
};

describe('runtime model identity', () => {
  it('round-trips provider model ids and variants without delimiter collisions', () => {
    const key = getRuntimeModelKey('opencode', openCodeModel.id, 'extra:high');

    expect(key).toBe('opencode:openrouter%2Fvendor%3Amodel%2Fname:extra%3Ahigh');
    expect(parseRuntimeModelKey(key)).toEqual({
      provider: 'opencode',
      modelId: openCodeModel.id,
      reasoningEffort: 'extra:high',
    });
    expect(getRuntimeModelFamilyKey('opencode', openCodeModel.id))
      .toBe('opencode:openrouter%2Fvendor%3Amodel%2Fname');
  });

  it('looks up dynamic models in the current catalog rather than the bootstrap only', () => {
    const catalog = runtimeModelsFromOpenCodeCatalog([openCodeModel]);
    const key = getRuntimeModelKey('opencode', openCodeModel.id, 'extra:high');

    expect(getRuntimeModelByKey(key, catalog)?.label).toBe('Dynamic Model Extra:high');
    expect(getRuntimeModelByKey(key)).toBeNull();
  });
});

describe('runtimeModels', () => {
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

  it('only exposes current Codex model families in the selector catalog', () => {
    const codexFamilyKeys = [
      ...new Set(
        runtimeModels
          .filter((model) => model.provider === 'codex')
          .map((model) => model.familyKey)
      ),
    ];

    expect(codexFamilyKeys).toEqual([
      'codex:gpt-5.6-sol',
      'codex:gpt-5.6-terra',
      'codex:gpt-5.6-luna',
      'codex:gpt-5.5',
      'codex:gpt-image-2',
    ]);
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.6');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.4');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.4-mini');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.3-codex');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.2-codex');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.2');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.1-codex-max');
    expect(codexFamilyKeys).not.toContain('codex:gpt-5.1-codex-mini');
  });

  it('uses the canonical GPT-5.6 variant IDs for Codex selector runs', () => {
    const variants = runtimeModels.filter((model) => (
      model.provider === 'codex' && model.modelId.startsWith('gpt-5.6-')
    ));

    expect([...new Set(variants.map((model) => model.modelId))]).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(variants).toHaveLength(18);
    expect(variants.every((model) => model.cliArgs.includes(`--model ${model.modelId}`))).toBe(true);
  });

  it('includes the current Claude model families exposed by Anthropic', () => {
    const claudeFamilies = new Map(
      runtimeModels
        .filter((model) => model.provider === 'claude')
        .map((model) => [model.familyKey, model])
    );

    expect([...claudeFamilies.keys()]).toEqual([
      'claude:claude-fable-5',
      'claude:claude-opus-5',
      'claude:claude-opus-4-8',
      'claude:claude-sonnet-5',
    ]);
    expect([...claudeFamilies.keys()]).not.toContain('claude:claude-sonnet-4-6');
    expect([...claudeFamilies.keys()]).not.toContain('claude:claude-haiku-4-5-20251001');
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

  it('uses the canonical Claude Opus 5 ID and current Claude CLI opus alias', () => {
    const opus = runtimeModels.find((model) => model.key === 'claude:claude-opus-5:high');

    expect(opus).toMatchObject({
      modelId: 'claude-opus-5',
      label: 'Claude Opus 5 High',
      familyLabel: 'Claude Opus 5',
      reasoningEffort: 'high',
    });
    expect(opus?.cliArgs).toContain('--model opus');
    expect(opus?.cliArgs).toContain('--effort high');
  });

  it('uses the canonical Opus 4.8 model ID instead of the generic opus alias', () => {
    const opus = runtimeModels.find((model) => model.key === 'claude:claude-opus-4-8:high');

    expect(opus).toMatchObject({
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8 High',
    });
    expect(opus?.cliArgs).toContain('--model claude-opus-4-8');
  });

  it('uses the canonical Claude Sonnet 5 ID with the current sonnet CLI alias', () => {
    const sonnet = runtimeModels.find((model) => model.key === 'claude:claude-sonnet-5:high');

    expect(sonnet).toMatchObject({
      modelId: 'claude-sonnet-5',
      label: 'Claude Sonnet 5 High',
      familyLabel: 'Claude Sonnet 5',
      reasoningEffort: 'high',
    });
    expect(sonnet?.cliArgs).toContain('--model sonnet');
    expect(sonnet?.cliArgs).toContain('--effort high');
  });

  it('exposes every provider-specific effort in order for every text model family', () => {
    expect(reasoningEffortsByProvider.claude.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(reasoningEffortsByProvider.codex.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);

    for (const provider of ['claude', 'codex'] as const) {
      const expectedEfforts = reasoningEffortsByProvider[provider].map((effort) => effort.id);
      const textModels = runtimeModels.filter((model) => (
        model.provider === provider && model.capabilities.reasoningEffort
      ));
      const effortsByFamily = new Map<string, typeof textModels>();
      for (const model of textModels) {
        effortsByFamily.set(model.familyKey, [...(effortsByFamily.get(model.familyKey) ?? []), model]);
      }

      for (const familyModels of effortsByFamily.values()) {
        expect(familyModels.map((model) => model.reasoningEffort)).toEqual(expectedEfforts);
        expect(familyModels.map((model) => model.effortDescription)).toEqual(
          reasoningEffortsByProvider[provider].map((effort) => effort.description)
        );
      }
    }
  });

  it('sorts each provider effort using its complete catalog order', () => {
    expect(getReasoningEffortSortOrder('claude', 'xhigh')).toBe(3);
    expect(getReasoningEffortSortOrder('claude', 'max')).toBe(4);
    expect(getReasoningEffortSortOrder('codex', 'max')).toBe(4);
    expect(getReasoningEffortSortOrder('codex', 'ultra')).toBe(5);
    expect(getReasoningEffortSortOrder('codex', 'unknown')).toBe(99);
  });

  it('exposes GPT Image 2 as one image-capable Codex model without reasoning variants', () => {
    const imageModels = runtimeModels.filter((model) => model.modelId === 'gpt-image-2');

    expect(imageModels).toHaveLength(1);
    expect(imageModels[0]).toMatchObject({
      key: 'codex:gpt-image-2',
      provider: 'codex',
      reasoningEffort: null,
      capabilities: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text', 'image'],
        reasoningEffort: false,
      },
    });
    expect(imageModels[0].cliArgs).toBe('--model gpt-image-2');
    expect(imageModels[0].cliArgs).not.toContain('--reasoning-effort');
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
