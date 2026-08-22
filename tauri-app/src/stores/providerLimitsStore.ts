import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeProvider } from '../lib/runtimeModels';

export type ProviderLimitSeverity = 'normal' | 'warning' | 'critical';
type ClaudeRateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';
type ClaudeRateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';

export interface CodexProviderLimitWindow {
  resetsAt: number | null;
  usedPercent: number | null;
  windowDurationMins: number | null;
}

export interface CodexProviderLimits {
  kind: 'codex';
  receivedAt: number;
  credits: {
    balance: string | null;
    hasCredits: boolean;
    unlimited: boolean;
  } | null;
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: CodexProviderLimitWindow | null;
  secondary: CodexProviderLimitWindow | null;
}

export interface ClaudeProviderLimitBucket {
  isUsingOverage: boolean | null;
  overageDisabledReason: string | null;
  overageResetsAt: number | null;
  overageStatus: ClaudeRateLimitStatus | null;
  rateLimitType: ClaudeRateLimitType | null;
  resetsAt: number | null;
  status: ClaudeRateLimitStatus | null;
  surpassedThreshold: number | null;
  utilization: number | null;
}

export interface ClaudeProviderLimits {
  kind: 'claude';
  buckets: Partial<Record<ClaudeRateLimitType, ClaudeProviderLimitBucket>>;
  receivedAt: number;
}

export type ProviderLimitsSnapshot = CodexProviderLimits | ClaudeProviderLimits;
export type ProviderLimitKey = RuntimeProvider | `${RuntimeProvider}:${string}`;

export const providerLimitKey = (provider: RuntimeProvider, profileId?: string | null): ProviderLimitKey =>
  profileId ? `${provider}:${profileId}` : provider;

export interface ProviderLimitDisplayWindow {
  id: string;
  label: string;
  percent: number | null;
  reason: string | null;
  resetsAt: number | null;
  severity: ProviderLimitSeverity;
  shortLabel: string;
}

interface ProviderLimitsState {
  byProvider: Partial<Record<ProviderLimitKey, ProviderLimitsSnapshot>>;
  clearAll: () => void;
  refreshIfStale: (provider: RuntimeProvider, now?: number) => boolean;
  upsertFromMeta: (provider: RuntimeProvider, meta: Record<string, any>, profileId?: string | null) => void;
}

const PROVIDER_LIMITS_REFRESH_STALE_MS = 2 * 60 * 1000;
const PROVIDER_LIMITS_REFRESH_TIMEOUT_MS = 10 * 1000;
const refreshInFlight: Partial<Record<RuntimeProvider, Promise<void>>> = {};
const refreshAttemptedAt: Partial<Record<RuntimeProvider, number>> = {};
const isProviderLimitsRefreshTimeout = (error: unknown) => (
  error instanceof Error && error.message.includes('Provider limits refresh timed out')
);

const CLAUDE_BUCKET_ORDER: ClaudeRateLimitType[] = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'overage',
];

const formatWindowShortLabel = (windowDurationMins: number | null | undefined) => {
  if (!Number.isFinite(windowDurationMins)) return null;
  const mins = Number(windowDurationMins);
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
};

const normalizePercent = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return Math.round(value * 100);
  return Math.round(value);
};

const statusSeverity = (status: ClaudeRateLimitStatus | null | undefined): ProviderLimitSeverity => {
  if (status === 'rejected') return 'critical';
  if (status === 'allowed_warning') return 'warning';
  return 'normal';
};

const mergeSeverity = (current: ProviderLimitSeverity, next: ProviderLimitSeverity): ProviderLimitSeverity => {
  if (current === 'critical' || next === 'critical') return 'critical';
  if (current === 'warning' || next === 'warning') return 'warning';
  return 'normal';
};

const percentSeverity = (percent: number | null) => {
  if (percent == null) return 'normal';
  if (percent <= 5) return 'critical';
  if (percent <= 20) return 'warning';
  return 'normal';
};

const formatReasonLabel = (reason: string | null | undefined) => {
  if (!reason) return null;
  return reason
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const mapCodexWindow = (window: Record<string, any> | null | undefined): CodexProviderLimitWindow | null => {
  if (!window || typeof window !== 'object') return null;
  return {
    resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null,
    usedPercent: normalizePercent(window.usedPercent),
    windowDurationMins: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null,
  };
};

const mapCodexLimits = (limits: Record<string, any>): CodexProviderLimits | null => {
  if (!limits || typeof limits !== 'object') return null;
  return {
    kind: 'codex',
    receivedAt: Date.now(),
    credits: limits.credits && typeof limits.credits === 'object'
      ? {
        balance: typeof limits.credits.balance === 'string' ? limits.credits.balance : null,
        hasCredits: Boolean(limits.credits.hasCredits),
        unlimited: Boolean(limits.credits.unlimited),
      }
      : null,
    limitId: typeof limits.limitId === 'string' ? limits.limitId : null,
    limitName: typeof limits.limitName === 'string' ? limits.limitName : null,
    planType: typeof limits.planType === 'string' ? limits.planType : null,
    primary: mapCodexWindow(limits.primary),
    secondary: mapCodexWindow(limits.secondary),
  };
};

const mapClaudeBucket = (bucket: Record<string, any>): ClaudeProviderLimitBucket | null => {
  if (!bucket || typeof bucket !== 'object') return null;
  const rateLimitType = typeof bucket.rateLimitType === 'string'
    ? bucket.rateLimitType as ClaudeRateLimitType
    : null;
  return {
    isUsingOverage: typeof bucket.isUsingOverage === 'boolean' ? bucket.isUsingOverage : null,
    overageDisabledReason: typeof bucket.overageDisabledReason === 'string' ? bucket.overageDisabledReason : null,
    overageResetsAt: typeof bucket.overageResetsAt === 'number' ? bucket.overageResetsAt : null,
    overageStatus: typeof bucket.overageStatus === 'string'
      ? bucket.overageStatus as ClaudeRateLimitStatus
      : null,
    rateLimitType,
    resetsAt: typeof bucket.resetsAt === 'number' ? bucket.resetsAt : null,
    status: typeof bucket.status === 'string' ? bucket.status as ClaudeRateLimitStatus : null,
    surpassedThreshold: typeof bucket.surpassedThreshold === 'number' ? bucket.surpassedThreshold : null,
    utilization: normalizePercent(bucket.utilization),
  };
};

const mapProviderLimits = (
  provider: RuntimeProvider,
  limits: Record<string, any>,
  previous?: ProviderLimitsSnapshot
): ProviderLimitsSnapshot | null => {
  if (provider === 'codex') {
    return mapCodexLimits(limits);
  }

  const bucket = mapClaudeBucket(limits.bucket);
  if (!bucket || !bucket.rateLimitType) return previous && previous.kind === 'claude' ? previous : null;
  const existingBuckets = previous?.kind === 'claude' ? previous.buckets : {};
  return {
    kind: 'claude',
    buckets: {
      ...existingBuckets,
      [bucket.rateLimitType]: bucket,
    },
    receivedAt: Date.now(),
  };
};

const canRefreshProviderLimits = (provider: RuntimeProvider) => provider === 'codex';

const refreshProviderLimits = async (provider: RuntimeProvider) => {
  if (!canRefreshProviderLimits(provider)) return;
  const rawLimits = await Promise.race([
    invoke<string | Record<string, any> | null>('refresh_provider_limits', { provider }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Provider limits refresh timed out after ${PROVIDER_LIMITS_REFRESH_TIMEOUT_MS}ms`)), PROVIDER_LIMITS_REFRESH_TIMEOUT_MS);
    }),
  ]);
  const limits = typeof rawLimits === 'string' ? JSON.parse(rawLimits) : rawLimits;
  if (!limits || typeof limits !== 'object') return;
  useProviderLimitsStore.getState().upsertFromMeta(provider, {
    provider_limits: limits,
  });
};

export const getProviderLimitWindows = (snapshot: ProviderLimitsSnapshot | null | undefined): ProviderLimitDisplayWindow[] => {
  if (!snapshot) return [];

  if (snapshot.kind === 'codex') {
    const windows: ProviderLimitDisplayWindow[] = [];
    [snapshot.primary, snapshot.secondary].forEach((window, index) => {
      if (!window) return;
      const shortLabel = formatWindowShortLabel(window.windowDurationMins) || (index === 0 ? 'Primary' : 'Secondary');
      const percent = normalizePercent(window.usedPercent);
      windows.push({
        id: index === 0 ? 'primary' : 'secondary',
        label: `${shortLabel} window`,
        percent,
        reason: null,
        resetsAt: window.resetsAt,
        severity: percentSeverity(percent),
        shortLabel,
      });
    });
    return windows;
  }

  const windows: ProviderLimitDisplayWindow[] = [];
  CLAUDE_BUCKET_ORDER.forEach((type) => {
    const bucket = snapshot.buckets[type] ?? null;
    if (!bucket?.rateLimitType) return;
    const percent = normalizePercent(bucket.utilization);
    let label = 'Usage';
    let shortLabel = 'Usage';
    if (bucket.rateLimitType === 'five_hour') {
      label = '5h window';
      shortLabel = '5h';
    } else if (bucket.rateLimitType === 'seven_day') {
      label = '7d window';
      shortLabel = '7d';
    } else if (bucket.rateLimitType === 'seven_day_sonnet') {
      label = '7d Sonnet';
      shortLabel = '7d';
    } else if (bucket.rateLimitType === 'seven_day_opus') {
      label = '7d Opus';
      shortLabel = '7d';
    } else if (bucket.rateLimitType === 'overage') {
      label = 'Overage';
      shortLabel = 'Over';
    }
    const overageSeverity = statusSeverity(bucket.overageStatus);
    const baseSeverity = mergeSeverity(statusSeverity(bucket.status), percentSeverity(percent));
    const severity = mergeSeverity(baseSeverity, overageSeverity);
    const reason =
      bucket.status === 'rejected'
        ? 'Usage blocked'
        : bucket.status === 'allowed_warning'
          ? 'Approaching limit'
          : bucket.overageDisabledReason
            ? formatReasonLabel(bucket.overageDisabledReason)
            : null;
    windows.push({
      id: bucket.rateLimitType,
      label,
      percent,
      reason,
      resetsAt: bucket.resetsAt ?? bucket.overageResetsAt,
      severity,
      shortLabel,
    });
  });
  return windows;
};

export const getProviderLimitSeverity = (snapshot: ProviderLimitsSnapshot | null | undefined): ProviderLimitSeverity => {
  return getProviderLimitWindows(snapshot).reduce<ProviderLimitSeverity>(
    (severity, window) => mergeSeverity(severity, window.severity),
    'normal'
  );
};

export const getProviderLimitSummary = (snapshot: ProviderLimitsSnapshot | null | undefined): string | null => {
  if (!snapshot) return null;
  const windows = getProviderLimitWindows(snapshot);
  if (windows.length === 0) return null;

  if (snapshot.kind === 'claude') {
    const fiveHour = windows.find((window) => window.id === 'five_hour' && window.percent != null) ?? null;
    const sevenDay = windows
      .filter((window) => String(window.id).startsWith('seven_day') && window.percent != null)
      .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;
    const preferred = [fiveHour, sevenDay].filter((window): window is ProviderLimitDisplayWindow => window != null);
    if (preferred.length > 0) {
      return preferred.map((window) => `${window.shortLabel} ${window.percent}%`).join(' · ');
    }
  }

  const summaryWindows = windows.filter((window) => window.percent != null).slice(0, 2);
  if (summaryWindows.length === 0) return null;
  return summaryWindows.map((window) => `${window.shortLabel} ${window.percent}%`).join(' · ');
};

export const formatProviderLimitReset = (resetsAt: number | null | undefined) => {
  if (!Number.isFinite(resetsAt)) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(Number(resetsAt) * 1000));
};

export const useProviderLimitsStore = create<ProviderLimitsState>()(
  persist(
    (set) => ({
      byProvider: {},
      clearAll: () => set({ byProvider: {} }),
      refreshIfStale: (provider, now = Date.now()) => {
        if (!canRefreshProviderLimits(provider)) return false;
        const snapshot = useProviderLimitsStore.getState().byProvider[provider];
        const isStale = !snapshot || now - snapshot.receivedAt >= PROVIDER_LIMITS_REFRESH_STALE_MS;
        const lastAttemptedAt = refreshAttemptedAt[provider] ?? 0;
        const canAttempt = lastAttemptedAt === 0 || now - lastAttemptedAt >= PROVIDER_LIMITS_REFRESH_STALE_MS;
        if (!isStale || !canAttempt || refreshInFlight[provider]) return false;
        refreshAttemptedAt[provider] = now;
        refreshInFlight[provider] = refreshProviderLimits(provider)
          .catch((error) => {
            if (isProviderLimitsRefreshTimeout(error)) {
              delete refreshAttemptedAt[provider];
            }
            console.debug('[providerLimitsStore] Provider limits refresh failed', { provider, error });
          })
          .finally(() => {
            delete refreshInFlight[provider];
          });
        return true;
      },
      upsertFromMeta: (provider, meta, profileId = null) => set((state) => {
        const limits = meta?.provider_limits;
        if (!limits || typeof limits !== 'object') return state;
        const key = providerLimitKey(provider, profileId);
        const previous = state.byProvider[key] ?? state.byProvider[provider];
        const next = mapProviderLimits(provider, limits, previous);
        if (!next) return state;
        return {
          byProvider: {
            ...state.byProvider,
            [key]: next,
            ...(profileId ? { [provider]: state.byProvider[provider] ?? next } : null),
          },
        };
      }),
    }),
    {
      name: 'provider-limits-storage',
      partialize: (state) => ({
        byProvider: state.byProvider,
      }),
    }
  )
);
