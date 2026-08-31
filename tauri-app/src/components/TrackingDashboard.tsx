import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Brain,
  CheckCircle2,
  CircleDot,
  Code2,
  Gauge,
  GitCommitHorizontal,
  Hash,
  ListChecks,
  Loader2,
  PanelRightOpen,
  TrendingUp,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type {
  BackgroundAttentionBucket,
  TrackingBucket,
  TrackingRange,
  TrackingRunRow,
} from '../domain/trackingDashboardMetrics';
import type { BackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import { useTrackingDashboardData } from '../hooks/useTrackingDashboardData';
import type { Workspace } from '../stores/workspaceStore';

interface TrackingDashboardProps {
  workspace: Workspace | null;
}

interface MetricTileProps {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone: 'accent' | 'success' | 'warning' | 'neutral';
}

const rangeOptions: Array<{ value: TrackingRange; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: 'all', label: 'All' },
];

const numberFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? '0' : numberFormatter.format(value);

const formatCompact = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : compactFormatter.format(value);

const formatSigned = (value: number): string => {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '-'}${numberFormatter.format(Math.abs(value))}`;
};

const formatReason = (value: string): string => (
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
);

const shortId = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
};

const metadataSummary = (metadata: Record<string, unknown> | null | undefined): string | null => {
  if (!metadata) return null;
  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 3)
    .map(([key, value]) => `${formatReason(key)}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  return entries.length > 0 ? entries.join(' · ') : null;
};

const formatDateTime = (value: string): string => {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Unknown';
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const statusClassName = (status: string | null): string => {
  if (status === 'completed') return 'border-[hsl(var(--app-success)/0.22)] bg-[hsl(var(--app-success)/0.1)] text-[hsl(var(--app-success))]';
  if (status === 'failed' || status === 'cancelled') return 'border-[hsl(var(--app-danger)/0.24)] bg-[hsl(var(--app-danger)/0.1)] text-[hsl(var(--app-danger))]';
  if (status === 'running' || status === 'streaming') return 'border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.11)] text-[hsl(var(--app-warning))]';
  return 'border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong)/0.72)] text-muted-foreground';
};

const auditOutcomeClassName = (outcome: BackgroundAttentionAuditEvent['outcome']): string => {
  if (outcome === 'ran') return 'border-[hsl(var(--app-success)/0.24)] bg-[hsl(var(--app-success)/0.1)] text-[hsl(var(--app-success))]';
  if (outcome === 'failed') return 'border-[hsl(var(--app-danger)/0.24)] bg-[hsl(var(--app-danger)/0.1)] text-[hsl(var(--app-danger))]';
  if (outcome === 'skipped') return 'border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.11)] text-[hsl(var(--app-warning))]';
  if (outcome === 'queued') return 'border-[hsl(var(--app-accent)/0.24)] bg-[hsl(var(--app-accent)/0.1)] text-[hsl(var(--app-accent))]';
  return 'border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel-strong)/0.72)] text-muted-foreground';
};

function MetricTile({ label, value, detail, icon, tone }: MetricTileProps) {
  const toneClassName = {
    accent: 'bg-[hsl(var(--app-accent)/0.1)] text-[hsl(var(--app-accent))]',
    success: 'bg-[hsl(var(--app-success)/0.1)] text-[hsl(var(--app-success))]',
    warning: 'bg-[hsl(var(--app-warning)/0.11)] text-[hsl(var(--app-warning))]',
    neutral: 'bg-[hsl(var(--app-panel-strong))] text-muted-foreground',
  }[tone];

  return (
    <section className="rounded-xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.86)] p-4 shadow-[0_14px_36px_-32px_hsl(var(--foreground)/0.38),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
          <div className="mt-2 font-mono text-2xl font-semibold tracking-normal text-foreground">{value}</div>
        </div>
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', toneClassName)}>
          {icon}
        </div>
      </div>
      <div className="mt-3 text-xs leading-5 text-muted-foreground">{detail}</div>
    </section>
  );
}

function ThroughputChart({ buckets }: { buckets: TrackingBucket[] }) {
  const visibleBuckets = buckets.slice(-30);
  const maxLoc = Math.max(1, ...visibleBuckets.map((bucket) => bucket.locAdded + bucket.locDeleted));
  const maxTokens = Math.max(1, ...visibleBuckets.map((bucket) => bucket.totalTokens));

  if (visibleBuckets.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-[hsl(var(--app-border)/0.78)] text-sm text-muted-foreground">
        No activity in this range
      </div>
    );
  }

  return (
    <div className="flex h-64 items-end gap-2 rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.38)] px-3 pb-3 pt-6">
      {visibleBuckets.map((bucket) => {
        const locHeight = Math.max(4, ((bucket.locAdded + bucket.locDeleted) / maxLoc) * 100);
        const tokenHeight = Math.max(4, (bucket.totalTokens / maxTokens) * 100);
        const hasActivity = bucket.commitCount > 0 || bucket.totalTokens > 0;
        return (
          <div key={bucket.key} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex h-48 w-full items-end justify-center gap-1">
              <div
                className={cn(
                  'w-full max-w-4 rounded-t-sm bg-[hsl(var(--app-graph-commit)/0.82)] transition-[height,opacity] duration-200',
                  !hasActivity && 'opacity-20'
                )}
                style={{ height: `${locHeight}%` }}
                title={`${bucket.label}: ${formatNumber(bucket.locAdded)} added, ${formatNumber(bucket.locDeleted)} deleted`}
              />
              <div
                className={cn(
                  'w-full max-w-4 rounded-t-sm bg-[hsl(var(--app-accent)/0.72)] transition-[height,opacity] duration-200',
                  bucket.totalTokens === 0 && 'opacity-20'
                )}
                style={{ height: `${tokenHeight}%` }}
                title={`${bucket.label}: ${formatNumber(bucket.totalTokens)} tokens`}
              />
            </div>
            <div className="w-full truncate text-center text-[10px] font-medium text-muted-foreground">{bucket.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function BackgroundAttentionChart({ buckets }: { buckets: BackgroundAttentionBucket[] }) {
  const visibleBuckets = buckets.slice(-30);
  const hasActivity = visibleBuckets.some((bucket) => (
    bucket.totalTokens > 0
    || bucket.candidateCount > 0
    || bucket.queuedTriggers > 0
    || bucket.ranTriggers > 0
    || bucket.skippedTriggers > 0
    || bucket.failedTriggers > 0
  ));
  const maxTokens = Math.max(1, ...visibleBuckets.map((bucket) => bucket.totalTokens));
  const maxCandidates = Math.max(1, ...visibleBuckets.map((bucket) => bucket.candidateCount));
  const maxSkipped = Math.max(1, ...visibleBuckets.map((bucket) => bucket.skippedTriggers + bucket.failedTriggers));

  if (visibleBuckets.length === 0 || !hasActivity) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-[hsl(var(--app-border)/0.78)] text-sm text-muted-foreground">
        No background attention activity in this range
      </div>
    );
  }

  return (
    <div className="flex h-56 items-end gap-2 rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.38)] px-3 pb-3 pt-6">
      {visibleBuckets.map((bucket) => {
        const tokenHeight = Math.max(4, (bucket.totalTokens / maxTokens) * 100);
        const candidateHeight = Math.max(4, (bucket.candidateCount / maxCandidates) * 100);
        const skippedHeight = Math.max(4, ((bucket.skippedTriggers + bucket.failedTriggers) / maxSkipped) * 100);
        const bucketHasActivity = bucket.totalTokens > 0 || bucket.candidateCount > 0 || bucket.skippedTriggers > 0 || bucket.failedTriggers > 0;
        return (
          <div key={bucket.key} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex h-40 w-full items-end justify-center gap-1">
              <div
                className={cn(
                  'w-full max-w-4 rounded-t-sm bg-[hsl(var(--app-accent)/0.76)] transition-[height,opacity] duration-200',
                  bucket.totalTokens === 0 && 'opacity-20'
                )}
                style={{ height: `${tokenHeight}%` }}
                title={`${bucket.label}: ${formatNumber(bucket.totalTokens)} background tokens`}
              />
              <div
                className={cn(
                  'w-full max-w-4 rounded-t-sm bg-[hsl(var(--app-success)/0.72)] transition-[height,opacity] duration-200',
                  bucket.candidateCount === 0 && 'opacity-20'
                )}
                style={{ height: `${candidateHeight}%` }}
                title={`${bucket.label}: ${formatNumber(bucket.candidateCount)} candidates, ${formatNumber(bucket.surfacedCount)} surfaced`}
              />
              <div
                className={cn(
                  'w-full max-w-4 rounded-t-sm bg-[hsl(var(--app-warning)/0.72)] transition-[height,opacity] duration-200',
                  !bucketHasActivity && 'opacity-20',
                  bucket.skippedTriggers + bucket.failedTriggers === 0 && 'opacity-20'
                )}
                style={{ height: `${skippedHeight}%` }}
                title={`${bucket.label}: ${formatNumber(bucket.skippedTriggers)} skipped, ${formatNumber(bucket.failedTriggers)} failed`}
              />
            </div>
            <div className="w-full truncate text-center text-[10px] font-medium text-muted-foreground">{bucket.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function BackgroundAttentionAuditDrawer({
  open,
  events,
  onClose,
}: {
  open: boolean;
  events: BackgroundAttentionAuditEvent[];
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]">
      <button
        type="button"
        aria-label="Close background attention audit drawer"
        className="absolute inset-0 cursor-default bg-black/28"
        onClick={onClose}
      />
      <aside className="absolute bottom-4 right-4 top-4 flex w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.96)] shadow-[0_24px_80px_-36px_hsl(var(--foreground)/0.52),inset_0_1px_0_hsl(var(--foreground)/0.04)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4 border-b border-[hsl(var(--app-border)/0.58)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ListChecks className="h-4 w-4 text-[hsl(var(--app-accent))]" />
              Attention audit
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Why background attention queued, ran, skipped, or failed.
            </p>
          </div>
          <button
            type="button"
            className="app-focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-[hsl(var(--app-panel-strong)/0.78)] hover:text-foreground active:scale-[0.96]"
            onClick={onClose}
            aria-label="Close audit drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          {events.length === 0 ? (
            <div className="flex h-full min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-[hsl(var(--app-border)/0.78)] px-5 text-center">
              <ListChecks className="h-7 w-7 text-muted-foreground" />
              <div className="mt-3 text-sm font-semibold text-foreground">No audit events yet</div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Enable insights and run an assistant turn to populate trigger decisions.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => {
                const parentId = shortId(event.parentNodeId);
                const runId = shortId(event.runNodeId);
                const summary = metadataSummary(event.metadata);
                return (
                  <article
                    key={event.id}
                    className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.58)] p-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={cn('inline-flex shrink-0 items-center rounded-md border px-2 py-1 text-[11px] font-semibold capitalize', auditOutcomeClassName(event.outcome))}>
                            {event.outcome}
                          </span>
                          <span className="truncate text-sm font-semibold text-foreground">{formatReason(event.reason)}</span>
                        </div>
                        {event.message && (
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">{event.message}</p>
                        )}
                      </div>
                      <time className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                      </time>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
                      <span className="rounded-md bg-[hsl(var(--app-bg-muted)/0.68)] px-2 py-1">{event.triggerClass ?? 'light'} trigger</span>
                      {parentId && <span className="rounded-md bg-[hsl(var(--app-bg-muted)/0.68)] px-2 py-1">parent {parentId}</span>}
                      {runId && <span className="rounded-md bg-[hsl(var(--app-bg-muted)/0.68)] px-2 py-1">run {runId}</span>}
                    </div>
                    {summary && (
                      <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={summary}>
                        {summary}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function SourceMix({ agentCommits, mergeCommits, manualCommits, externalCommits }: {
  agentCommits: number;
  mergeCommits: number;
  manualCommits: number;
  externalCommits: number;
}) {
  const total = Math.max(1, agentCommits + mergeCommits + manualCommits + externalCommits);
  const segments = [
    { label: 'Agent', value: agentCommits, className: 'bg-[hsl(var(--app-graph-agent))]' },
    { label: 'Merge', value: mergeCommits, className: 'bg-[hsl(var(--app-graph-commit))]' },
    { label: 'Manual', value: manualCommits, className: 'bg-[hsl(var(--app-warning))]' },
    { label: 'External', value: externalCommits, className: 'bg-[hsl(var(--app-text-soft))]' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex h-2 overflow-hidden rounded-full bg-[hsl(var(--app-bg-muted))]">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center justify-between gap-3 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', segment.className)} />
              {segment.label}
            </span>
            <span className="font-mono text-xs font-semibold text-foreground">{formatNumber(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: TrackingRunRow[] }) {
  if (runs.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[hsl(var(--app-border)/0.78)] text-sm text-muted-foreground">
        No assistant runs with tracking data yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--app-border)/0.62)]">
      <div className="min-w-[720px]">
        <div className="grid grid-cols-[minmax(220px,1fr)_112px_88px_112px_88px] gap-3 border-b border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.72)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          <div>Run</div>
          <div>Time</div>
          <div>Status</div>
          <div className="text-right">Tokens</div>
          <div className="text-right">LOC</div>
        </div>
        <div className="max-h-72 overflow-auto">
          {runs.map((run) => (
            <div key={run.nodeId} className="grid grid-cols-[minmax(220px,1fr)_112px_88px_112px_88px] items-center gap-3 border-b border-[hsl(var(--app-border)/0.42)] px-4 py-3 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{run.label}</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  {formatNumber(run.commitCount)} commits
                </div>
              </div>
              <div className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</div>
              <div>
                <span className={cn('inline-flex max-w-full items-center rounded-md border px-2 py-1 text-[11px] font-semibold capitalize', statusClassName(run.status ?? null))}>
                  {run.status ?? 'unknown'}
                </span>
              </div>
              <div className="font-mono text-sm font-semibold text-foreground text-right">{formatCompact(run.totalTokens)}</div>
              <div className={cn('font-mono text-sm font-semibold text-right', run.netLoc >= 0 ? 'text-[hsl(var(--app-success))]' : 'text-[hsl(var(--app-danger))]')}>
                {formatSigned(run.netLoc)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TrackingDashboard({ workspace }: TrackingDashboardProps) {
  const [range, setRange] = useState<TrackingRange>('7d');
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  const { metrics, isLoading, isRefreshing, error } = useTrackingDashboardData(workspace, range);
  const backgroundAttention = metrics.backgroundAttention;
  const hasData = metrics.totals.commits > 0 || metrics.totals.tokenKnownRuns > 0;
  const observedAttentionRuns = Math.max(backgroundAttention.totals.runCount, backgroundAttention.totals.ranTriggers);
  const chartSummary = useMemo(() => {
    const activeDays = metrics.buckets.filter((bucket) => bucket.commitCount > 0 || bucket.totalTokens > 0).length;
    return `${formatNumber(activeDays)} active days, ${formatNumber(metrics.totals.locKnownCommits)} commits with LOC stats`;
  }, [metrics.buckets, metrics.totals.locKnownCommits]);
  const backgroundAttentionSummary = useMemo(() => {
    const activeDays = backgroundAttention.buckets.filter((bucket) => (
      bucket.totalTokens > 0
      || bucket.candidateCount > 0
      || bucket.queuedTriggers > 0
      || bucket.ranTriggers > 0
      || bucket.skippedTriggers > 0
      || bucket.failedTriggers > 0
    )).length;
    return `${formatNumber(activeDays)} active days, ${formatNumber(backgroundAttention.totals.auditEventCount)} audit events`;
  }, [backgroundAttention.buckets, backgroundAttention.totals.auditEventCount]);

  return (
    <div className="app-view-frame mx-auto flex h-full w-full max-w-7xl flex-col">
      <header className="app-view-header">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Workspace tracking</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Tracking</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Commits, code volume, and token usage for {workspace?.name ?? 'the selected workspace'}.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {isRefreshing && (
            <div className="hidden items-center gap-2 text-xs font-medium text-muted-foreground sm:flex">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Updating
            </div>
          )}
          <div className="flex rounded-lg border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel-strong)/0.64)] p-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
            {rangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'app-focus-ring h-8 rounded-md px-3 text-xs font-semibold transition-[background-color,color,box-shadow]',
                  range === option.value
                    ? 'bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] shadow-[0_1px_2px_hsl(var(--foreground)/0.08),inset_0_0_0_1px_hsl(var(--app-border)/0.62)]'
                    : 'text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.58)] hover:text-foreground'
                )}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto pb-5">
        <div className="grid gap-4 lg:grid-cols-4">
          <MetricTile
            label="Commits"
            value={formatNumber(metrics.totals.commits)}
            detail={`${formatNumber(metrics.totals.agentCommits)} agent, ${formatNumber(metrics.totals.mergeCommits)} merge`}
            icon={<GitCommitHorizontal className="h-4 w-4" />}
            tone="accent"
          />
          <MetricTile
            label="LOC Generated"
            value={formatSigned(metrics.totals.netLoc)}
            detail={`${formatNumber(metrics.totals.locAdded)} added, ${formatNumber(metrics.totals.locDeleted)} deleted`}
            icon={<Code2 className="h-4 w-4" />}
            tone="success"
          />
          <MetricTile
            label="Token Usage"
            value={formatCompact(metrics.totals.totalTokens)}
            detail={`${formatNumber(metrics.totals.tokenKnownRuns)} runs captured, ${formatNumber(metrics.totals.tokenCoveragePercent)}% coverage`}
            icon={<CircleDot className="h-4 w-4" />}
            tone="warning"
          />
          <MetricTile
            label="Efficiency"
            value={metrics.totals.tokensPerCommit === null ? '-' : formatCompact(metrics.totals.tokensPerCommit)}
            detail={`${metrics.totals.tokensPerLocAdded === null ? '-' : formatCompact(metrics.totals.tokensPerLocAdded)} tokens per added LOC`}
            icon={<Gauge className="h-4 w-4" />}
            tone="neutral"
          />
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-[hsl(var(--app-danger)/0.24)] bg-[hsl(var(--app-danger)/0.08)] px-4 py-3 text-sm text-[hsl(var(--app-danger))]">
            Tracking data could not fully refresh: {error.message}
          </div>
        )}

        <section className="mt-4 rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.88)] p-4 shadow-[var(--app-shadow-panel)]">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Brain className="h-4 w-4 text-[hsl(var(--app-accent))]" />
                Background attention
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Trigger decisions, private candidates, and token usage over time.
              </p>
            </div>
            <button
              type="button"
              className="app-focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.62)] px-3 text-xs font-semibold text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[background-color,color,box-shadow,transform] hover:bg-[hsl(var(--app-panel-strong)/0.86)] active:scale-[0.96]"
              onClick={() => setAuditDrawerOpen(true)}
            >
              <PanelRightOpen className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />
              Audit drawer
              <span className="font-mono text-[11px] text-muted-foreground">{formatNumber(backgroundAttention.totals.auditEventCount)}</span>
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--app-success))]" />
                Runs
              </div>
              <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatNumber(observedAttentionRuns)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{formatNumber(backgroundAttention.totals.queuedTriggers)} queued · {formatNumber(backgroundAttention.totals.failedTriggers)} failed</div>
            </div>
            <div className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <CircleDot className="h-3.5 w-3.5 text-[hsl(var(--app-warning))]" />
                Tokens
              </div>
              <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatCompact(backgroundAttention.totals.totalTokens)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{formatCompact(backgroundAttention.totals.promptTokens)} in · {formatCompact(backgroundAttention.totals.completionTokens)} out</div>
            </div>
            <div className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ListChecks className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />
                Candidates
              </div>
              <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatNumber(backgroundAttention.totals.candidateCount)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{formatNumber(backgroundAttention.totals.surfacedCount)} surfaced · {formatNumber(backgroundAttention.totals.savedCount)} saved</div>
            </div>
            <div className="rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                Skips
              </div>
              <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatNumber(backgroundAttention.totals.skippedTriggers)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{formatNumber(backgroundAttention.totals.baselineEvents)} baselines · {formatNumber(backgroundAttention.totals.archivedCount)} archived</div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">{backgroundAttentionSummary}</p>
              <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-accent))]" /> Tokens</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-success))]" /> Candidates</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-warning))]" /> Skips/failures</span>
              </div>
            </div>
            <BackgroundAttentionChart buckets={backgroundAttention.buckets} />
          </div>
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.8fr)]">
          <section className="rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.88)] p-4 shadow-[var(--app-shadow-panel)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <BarChart3 className="h-4 w-4 text-[hsl(var(--app-accent))]" />
                  Daily throughput
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{chartSummary}</p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-graph-commit))]" /> LOC</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-accent))]" /> Tokens</span>
              </div>
            </div>
            <ThroughputChart buckets={metrics.buckets} />
          </section>

          <section className="rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.88)] p-4 shadow-[var(--app-shadow-panel)]">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="h-4 w-4 text-[hsl(var(--app-accent))]" />
              Commit source mix
            </div>
            <SourceMix
              agentCommits={metrics.totals.agentCommits}
              mergeCommits={metrics.totals.mergeCommits}
              manualCommits={metrics.totals.manualCommits}
              externalCommits={metrics.totals.externalCommits}
            />
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" />
                  LOC coverage
                </div>
                <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatNumber(metrics.totals.locCoveragePercent)}%</div>
              </div>
              <div className="rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.56)] p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Token coverage
                </div>
                <div className="mt-2 font-mono text-xl font-semibold text-foreground">{formatNumber(metrics.totals.tokenCoveragePercent)}%</div>
              </div>
            </div>
          </section>
        </div>

        <section className="mt-4 rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.88)] p-4 shadow-[var(--app-shadow-panel)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Recent runs</div>
              <p className="mt-1 text-xs text-muted-foreground">Assistant outputs connected to commits and token usage.</p>
            </div>
            {isLoading && (
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading
              </div>
            )}
          </div>
          {hasData ? (
            <RecentRunsTable runs={metrics.recentRuns} />
          ) : (
            <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed border-[hsl(var(--app-border)/0.78)] px-6 text-center">
              <GitCommitHorizontal className="h-7 w-7 text-muted-foreground" />
              <div className="mt-3 text-sm font-semibold text-foreground">No tracking data yet</div>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Run agents in this workspace to populate commit counts, generated LOC, and token usage.
              </p>
            </div>
          )}
        </section>
      </div>
      <BackgroundAttentionAuditDrawer
        open={auditDrawerOpen}
        events={backgroundAttention.recentAuditEvents}
        onClose={() => setAuditDrawerOpen(false)}
      />
    </div>
  );
}
