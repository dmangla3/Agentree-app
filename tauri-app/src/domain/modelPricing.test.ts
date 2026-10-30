import { describe, expect, it } from 'vitest';
import {
  lookupModelRate,
  normalizeModelName,
  parseModelRateTable,
  priceModelUsage,
} from './modelPricing';

const rates = parseModelRateTable({
  'openai/gpt-5.6': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.00003,
    cache_read_input_token_cost: 0.0000005,
  },
  'anthropic/claude-sonnet-5': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000002,
    cache_creation_input_token_cost: 0.0000025,
  },
  incomplete: { input_cost_per_token: 0.000001 },
});

describe('model pricing', () => {
  it('parses only complete rates and safely defaults optional cache rates', () => {
    expect(rates.size).toBe(2);
    expect(lookupModelRate(rates, 'gpt-5.6')).toMatchObject({
      inputCostPerToken: 0.000005,
      cacheReadCostPerToken: 0.0000005,
      cacheCreationCostPerToken: 0.000005,
    });
    expect(lookupModelRate(rates, 'incomplete')).toBeNull();
  });

  it('normalizes provider paths and resolves Agentree reasoning-effort suffixes', () => {
    expect(normalizeModelName('OpenAI/GPT-5.6')).toBe('gpt-5.6');
    expect(lookupModelRate(rates, 'codex/gpt-5.6-xhigh')).toEqual(lookupModelRate(rates, 'gpt-5.6'));
    expect(lookupModelRate(rates, 'sonnet')).toBeNull();
  });

  it('prices model input, cache, output, and cache savings without double-charging reasoning', () => {
    const result = priceModelUsage(rates, 'claude-sonnet-5', {
      uncachedInputTokens: 100,
      cachedInputTokens: 1_000,
      cacheCreationTokens: 50,
      outputTokens: 20,
    }, null);

    expect(result.costSource).toBe('modelPriced');
    expect(result.inputCostUsd).toBeCloseTo(0.000525);
    expect(result.outputCostUsd).toBeCloseTo(0.0002);
    expect(result.costUsd).toBeCloseTo(0.000725);
    expect(result.cacheSavingsUsd).toBeCloseTo(0.0018);
  });

  it('lets a provider-reported cost, including zero, override model arithmetic', () => {
    const result = priceModelUsage(rates, 'gpt-5.6', {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 100,
    }, 0);

    expect(result.costSource).toBe('providerReported');
    expect(result.costUsd).toBe(0);
  });

  it('marks unknown models as unpriced instead of treating them as free', () => {
    expect(priceModelUsage(rates, 'future-model', {
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 10,
    }, null)).toMatchObject({ costUsd: 0, costSource: 'unpriced' });
  });
});
