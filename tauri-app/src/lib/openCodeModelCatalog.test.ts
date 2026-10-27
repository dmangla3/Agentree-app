import { describe, expect, it } from 'vitest';
import {
  getCachedOpenCodeModelCatalog,
  getCachedOpenCodeModelCatalogCheckedAt,
} from './openCodeModelCatalog';

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'openai/gpt-5.6-sol',
  providerId: 'openai',
  providerName: 'OpenAI',
  modelId: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  reasoning: true,
  attachment: true,
  toolCall: true,
  inputModalities: ['text'],
  outputModalities: ['text'],
  variants: ['low', 'medium'],
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  releaseDate: '2026-08-01',
  status: 'active',
  isFree: false,
  ...overrides,
});

describe('cached OpenCode model catalog', () => {
  it('reads a persisted catalog without invoking a runtime', () => {
    const profile = {
      provider: 'opencode',
      config: {
        opencode_model_catalog_checked_at: 123,
        opencode_model_catalog: [model()],
      },
    };

    expect(getCachedOpenCodeModelCatalog(profile)).toEqual([model()]);
    expect(getCachedOpenCodeModelCatalogCheckedAt(profile)).toBe(123);
  });

  it('filters invalid providers and keeps free models for unfunded providers', () => {
    const profile = {
      provider: 'opencode',
      config: {
        opencode_provider_capabilities: {
          openai: { authStatus: 'invalid', pricedModelAccess: 'unknown' },
          openrouter: { authStatus: 'valid', pricedModelAccess: 'unavailable' },
        },
        opencode_model_catalog: [
          model(),
          model({ id: 'openrouter/free', providerId: 'openrouter', modelId: 'free', name: 'Free', isFree: true }),
          model({ id: 'openrouter/paid', providerId: 'openrouter', modelId: 'paid', name: 'Paid', isFree: false }),
        ],
      },
    };

    expect(getCachedOpenCodeModelCatalog(profile).map((entry) => entry.id)).toEqual(['openrouter/free']);
  });

  it('ignores malformed catalog entries', () => {
    const profile = {
      provider: 'opencode',
      config: { opencode_model_catalog: [{ id: 'incomplete' }, null, 'bad'] },
    };

    expect(getCachedOpenCodeModelCatalog(profile)).toEqual([]);
  });
});
