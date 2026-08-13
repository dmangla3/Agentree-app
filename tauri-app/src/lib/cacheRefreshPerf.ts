import { recordFundamentalCounter } from '../perf/fundamentalCounters';
import { withRuntimeActivity } from '../perf/runtimeActivityContext';
import { recordPerfEvent } from './perfRecorder';

export interface CacheRefreshOperationInput {
  phase: string;
  workspaceId?: string | null;
  reason?: string | null;
  queryKey?: unknown;
  refetchType?: string | null;
  source?: string;
}

let nextCacheRefreshOperationId = 1;

const now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const summarizeQueryKey = (queryKey: unknown): string | null => {
  if (Array.isArray(queryKey)) {
    return queryKey.map((part) => String(part)).join(':');
  }
  if (typeof queryKey === 'string') return queryKey;
  if (queryKey === null || queryKey === undefined) return null;
  return String(queryKey);
};

export const runCacheRefreshOperation = async <Result>(
  input: CacheRefreshOperationInput,
  operation: () => Promise<Result> | Result,
): Promise<Result> => {
  const startedAt = now();
  const operationId = nextCacheRefreshOperationId++;
  const details = {
    operationId,
    phase: input.phase,
    workspaceId: input.workspaceId ?? null,
    reason: input.reason ?? null,
    queryKey: summarizeQueryKey(input.queryKey),
    refetchType: input.refetchType ?? null,
  };
  const source = input.source ?? 'cacheRefreshPerf';

  recordPerfEvent('query.cache-refresh.phase.start', details, { source });
  try {
    return await withRuntimeActivity({
      category: 'cache-refresh',
      name: input.phase,
      details,
    }, operation);
  } finally {
    const durationMs = Number(Math.max(0, now() - startedAt).toFixed(2));
    recordPerfEvent('query.cache-refresh.phase.end', details, { source, durationMs });
    recordFundamentalCounter('query.cache-refresh.phase', {
      phase: input.phase,
      workspaceId: input.workspaceId ?? null,
      reason: input.reason ?? null,
      queryKey: details.queryKey,
      refetchType: input.refetchType ?? null,
    }, durationMs);
  }
};

export const resetCacheRefreshPerfForTest = () => {
  nextCacheRefreshOperationId = 1;
};
