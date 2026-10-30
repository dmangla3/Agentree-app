export const LITELLM_MODEL_RATES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface ModelRate {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;
export type UsageCostSource = 'providerReported' | 'modelPriced' | 'unpriced';
export type PricingStatus = 'fresh' | 'cached' | 'unavailable';

export interface PricingSnapshot {
  rates: RateTable;
  status: PricingStatus;
  source: string;
  fetchedAt: string | null;
  knownModels: number;
}

export interface UsageForPricing {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface PricedUsage {
  costUsd: number;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheSavingsUsd: number;
  costSource: UsageCostSource;
}

interface LiteLlmEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
}

const UNPRICEABLE_MODELS = new Set([
  '<synthetic>',
  'synthetic',
  'opus',
  'sonnet',
  'haiku',
  'fable',
]);

const REASONING_EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max|ultra)$/;

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const normalizeModelName = (model: string): string => {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
};

export const parseModelRateTable = (document: unknown): RateTable => {
  const table = new Map<string, ModelRate>();
  if (typeof document !== 'object' || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }

  return table;
};

export const lookupModelRate = (table: RateTable, model: string): ModelRate | null => {
  const normalized = normalizeModelName(model);
  if (!normalized || UNPRICEABLE_MODELS.has(normalized)) return null;
  const exact = table.get(normalized);
  if (exact) return exact;

  // Agentree may persist reasoning effort in an agent-derived model name.
  // Only remove it after an exact miss so real tier names stay intact.
  const withoutEffort = normalized.replace(REASONING_EFFORT_SUFFIX, '');
  return withoutEffort === normalized ? null : table.get(withoutEffort) ?? null;
};

export const priceModelUsage = (
  table: RateTable,
  model: string,
  usage: UsageForPricing,
  providerReportedCostUsd: number | null,
): PricedUsage => {
  const rate = lookupModelRate(table, model);
  const modelInputCost = rate === null
    ? null
    : usage.uncachedInputTokens * rate.inputCostPerToken
      + usage.cachedInputTokens * rate.cacheReadCostPerToken
      + usage.cacheCreationTokens * rate.cacheCreationCostPerToken;
  const modelOutputCost = rate === null ? null : usage.outputTokens * rate.outputCostPerToken;
  const cacheSavingsUsd = rate === null
    ? 0
    : usage.cachedInputTokens * Math.max(0, rate.inputCostPerToken - rate.cacheReadCostPerToken);

  if (providerReportedCostUsd !== null && Number.isFinite(providerReportedCostUsd)) {
    const modelTotal = (modelInputCost ?? 0) + (modelOutputCost ?? 0);
    const scale = modelTotal > 0 ? providerReportedCostUsd / modelTotal : null;
    return {
      costUsd: providerReportedCostUsd,
      inputCostUsd: scale === null || modelInputCost === null ? null : modelInputCost * scale,
      outputCostUsd: scale === null || modelOutputCost === null ? null : modelOutputCost * scale,
      cacheSavingsUsd,
      costSource: 'providerReported',
    };
  }

  if (rate === null || modelInputCost === null || modelOutputCost === null) {
    return {
      costUsd: 0,
      inputCostUsd: null,
      outputCostUsd: null,
      cacheSavingsUsd: 0,
      costSource: 'unpriced',
    };
  }

  return {
    costUsd: modelInputCost + modelOutputCost,
    inputCostUsd: modelInputCost,
    outputCostUsd: modelOutputCost,
    cacheSavingsUsd,
    costSource: 'modelPriced',
  };
};

export const unavailablePricingSnapshot = (): PricingSnapshot => ({
  rates: new Map(),
  status: 'unavailable',
  source: LITELLM_MODEL_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
});
