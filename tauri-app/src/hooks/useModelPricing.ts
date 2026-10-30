import { useQuery } from '@tanstack/react-query';
import {
  LITELLM_MODEL_RATES_URL,
  parseModelRateTable,
  unavailablePricingSnapshot,
  type ModelRate,
  type PricingSnapshot,
  type RateTable,
} from '../domain/modelPricing';

const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const STORAGE_KEY = 'agentree:model-pricing:v1';

interface StoredPricingSnapshot {
  fetchedAtMs: number;
  rates: Array<[string, ModelRate]>;
}

const isModelRate = (value: unknown): value is ModelRate => {
  if (!value || typeof value !== 'object') return false;
  const rate = value as Partial<ModelRate>;
  return [
    rate.inputCostPerToken,
    rate.outputCostPerToken,
    rate.cacheReadCostPerToken,
    rate.cacheCreationCostPerToken,
  ].every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
};

const readStoredPricing = (): { fetchedAtMs: number; rates: RateTable } | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPricingSnapshot>;
    if (!Number.isFinite(parsed.fetchedAtMs) || !Array.isArray(parsed.rates)) return null;
    const rates = new Map(parsed.rates.filter((entry): entry is [string, ModelRate] => (
      Array.isArray(entry)
      && typeof entry[0] === 'string'
      && isModelRate(entry[1])
    )));
    return rates.size > 0 ? { fetchedAtMs: parsed.fetchedAtMs as number, rates } : null;
  } catch {
    return null;
  }
};

const writeStoredPricing = (fetchedAtMs: number, rates: RateTable): void => {
  try {
    const snapshot: StoredPricingSnapshot = {
      fetchedAtMs,
      rates: Array.from(rates.entries()),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // A read-only or full webview cache should not make tracking unavailable.
  }
};

const snapshot = (
  rates: RateTable,
  status: PricingSnapshot['status'],
  fetchedAtMs: number,
): PricingSnapshot => ({
  rates,
  status,
  source: LITELLM_MODEL_RATES_URL,
  fetchedAt: new Date(fetchedAtMs).toISOString(),
  knownModels: rates.size,
});

export const loadModelPricing = async (): Promise<PricingSnapshot> => {
  const cached = readStoredPricing();
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < RATES_TTL_MS) {
    return snapshot(cached.rates, 'cached', cached.fetchedAtMs);
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(LITELLM_MODEL_RATES_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`Pricing request failed with ${response.status}`);
    const rates = parseModelRateTable(await response.json());
    if (rates.size === 0) throw new Error('Pricing response contained no usable model rates');
    writeStoredPricing(now, rates);
    return snapshot(rates, 'fresh', now);
  } catch {
    return cached
      ? snapshot(cached.rates, 'cached', cached.fetchedAtMs)
      : unavailablePricingSnapshot();
  } finally {
    window.clearTimeout(timeoutId);
  }
};

export const useModelPricing = () => useQuery({
  queryKey: ['model-pricing-rates'],
  queryFn: loadModelPricing,
  staleTime: RATES_TTL_MS,
  gcTime: 7 * RATES_TTL_MS,
  retry: false,
  refetchOnWindowFocus: false,
});
