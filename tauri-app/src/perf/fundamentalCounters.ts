interface FundamentalCounterAggregate {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number | null;
  lastAt: string;
  lastDetails?: Record<string, unknown>;
  breakdown?: Record<string, number>;
  samples: Array<{
    at: string;
    durationMs: number | null;
    details?: Record<string, unknown>;
  }>;
}

type FundamentalCounterSnapshot = Record<string, FundamentalCounterAggregate>;

const SAMPLE_LIMIT = 12;
const counters = new Map<string, FundamentalCounterAggregate>();
const BREAKDOWN_FIELDS = ['mode', 'phase', 'activeSendFlow', 'runningCount', 'visualChangeKey'];

declare global {
  interface Window {
    __AGENTREE_FUNDAMENTALS__?: {
      read: () => FundamentalCounterSnapshot;
      clear: () => void;
    };
  }
}

const isEnabled = () => import.meta.env.DEV && typeof window !== 'undefined';

const cloneDetails = (details?: Record<string, unknown>) => {
  if (!details) return undefined;
  return { ...details };
};

const cloneBreakdown = (breakdown?: Record<string, number>) => {
  if (!breakdown) return undefined;
  return { ...breakdown };
};

const snapshot = (): FundamentalCounterSnapshot => {
  const result: FundamentalCounterSnapshot = {};
  counters.forEach((value, key) => {
    result[key] = {
      ...value,
      lastDetails: cloneDetails(value.lastDetails),
      breakdown: cloneBreakdown(value.breakdown),
      samples: value.samples.map((sample) => ({
        ...sample,
        details: cloneDetails(sample.details),
      })),
    };
  });
  return result;
};

export const installFundamentalCounterApi = () => {
  if (!isEnabled() || window.__AGENTREE_FUNDAMENTALS__) return;
  window.__AGENTREE_FUNDAMENTALS__ = {
    read: snapshot,
    clear: () => counters.clear(),
  };
};

export const recordFundamentalCounter = (
  name: string,
  details?: Record<string, unknown>,
  durationMs?: number
) => {
  if (!isEnabled()) return;
  installFundamentalCounterApi();

  const now = new Date().toISOString();
  const safeDuration = typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? Number(durationMs.toFixed(2))
    : null;
  const aggregate = counters.get(name) ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: null,
    lastAt: now,
    samples: [],
  };

  aggregate.count += 1;
  aggregate.lastAt = now;
  aggregate.lastDurationMs = safeDuration;
  aggregate.lastDetails = cloneDetails(details);
  if (safeDuration !== null) {
    aggregate.totalDurationMs = Number((aggregate.totalDurationMs + safeDuration).toFixed(2));
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, safeDuration);
  }
  if (details) {
    for (const field of BREAKDOWN_FIELDS) {
      const value = details[field];
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      const key = `${field}:${String(value)}`;
      aggregate.breakdown = aggregate.breakdown ?? {};
      aggregate.breakdown[key] = (aggregate.breakdown[key] ?? 0) + 1;
    }
  }
  aggregate.samples.push({
    at: now,
    durationMs: safeDuration,
    details: cloneDetails(details),
  });
  if (aggregate.samples.length > SAMPLE_LIMIT) {
    aggregate.samples.splice(0, aggregate.samples.length - SAMPLE_LIMIT);
  }

  counters.set(name, aggregate);
};
