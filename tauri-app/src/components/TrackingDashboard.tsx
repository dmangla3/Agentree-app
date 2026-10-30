import {
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Brain,
  CheckCircle2,
  CircleDot,
  Code2,
  DollarSign,
  Gauge,
  GitCommitHorizontal,
  Hash,
  ListChecks,
  Loader2,
  PanelRightOpen,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type {
  BackgroundAttentionBucket,
  TrackingBucket,
  TrackingRange,
  TrackingRunRow,
  TrackingModelUsageRow,
} from '../domain/trackingDashboardMetrics';
import type { BackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import { useTrackingDashboardData } from '../hooks/useTrackingDashboardData';
import type { Workspace } from '../stores/workspaceStore';

interface TrackingDashboardProps {
  workspace: Workspace | null;
}

type TrackingChartMetric = 'code' | 'tokens' | 'cost';
type BreakdownView = 'runs' | 'model' | 'source';

const rangeOptions: Array<{ value: TrackingRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
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

const formatUsd = (value: number): string => {
  const maximumFractionDigits = Math.abs(value) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
};

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

const formatRangeDate = (value: string): string => {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Unknown';
  return new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
};

const formatRange = (startedAt: string | null, endedAt: string): string => (
  startedAt === null
    ? `All recorded activity · through ${formatRangeDate(endedAt)}`
    : `${formatRangeDate(startedAt)} to ${formatRangeDate(endedAt)}`
);

const statusClassName = (status: string | null): string => {
  if (status === 'completed') return 'border-[hsl(var(--app-success)/0.22)] bg-[hsl(var(--app-success)/0.1)] text-[hsl(var(--app-success))]';
  if (status?.startsWith('failed') || status === 'cancelled') return 'border-[hsl(var(--app-danger)/0.24)] bg-[hsl(var(--app-danger)/0.1)] text-[hsl(var(--app-danger))]';
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

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex overflow-hidden rounded-lg border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel-strong)/0.5)] p-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={cn(
            'app-focus-ring h-7 rounded-md px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-[background-color,color,box-shadow]',
            option.value === value
              ? 'bg-[hsl(var(--app-panel))] text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08),inset_0_0_0_1px_hsl(var(--app-border)/0.56)]'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SummaryBreakdownRow({
  label,
  value,
  share,
  colorClassName,
  detail,
}: {
  label: string;
  value: string;
  share: number;
  colorClassName: string;
  detail: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', colorClassName)} />
          {label}
        </span>
        <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[hsl(var(--app-bg-muted))]">
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', colorClassName)}
          style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }}
        />
      </div>
      <div className="text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function MetricCell({ label, value, detail, icon }: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="min-w-0 bg-[hsl(var(--app-panel)/0.7)] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={detail}>{detail}</div>
    </div>
  );
}

const CHART_WIDTH = 760;
const CHART_HEIGHT = 220;
const CHART_TOP = 12;

function chartLine(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

function chartArea(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  return `M${first.x.toFixed(2)},${CHART_HEIGHT} ${chartLine(points).replace(/^M/, 'L')} L${last.x.toFixed(2)},${CHART_HEIGHT} Z`;
}

function ThroughputChart({ buckets, metric }: { buckets: TrackingBucket[]; metric: TrackingChartMetric }) {
  const visibleBuckets = buckets.slice(-30);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const series = useMemo(() => {
    if (metric === 'code') {
      return {
        primaryLabel: 'Added',
        secondaryLabel: 'Deleted',
        primaryColor: 'hsl(var(--app-graph-commit))',
        secondaryColor: 'hsl(var(--app-danger))',
        primary: visibleBuckets.map((bucket) => bucket.locAdded),
        secondary: visibleBuckets.map((bucket) => bucket.locDeleted),
      };
    }
    if (metric === 'tokens') {
      return {
        primaryLabel: 'Input',
        secondaryLabel: 'Output',
        primaryColor: 'hsl(var(--app-accent))',
        secondaryColor: 'hsl(var(--app-graph-summary))',
        primary: visibleBuckets.map((bucket) => bucket.promptTokens),
        secondary: visibleBuckets.map((bucket) => bucket.completionTokens),
      };
    }
    return {
      primaryLabel: 'Estimated cost',
      secondaryLabel: 'Cache saved',
      primaryColor: 'hsl(var(--app-warning))',
      secondaryColor: 'hsl(var(--app-success))',
      primary: visibleBuckets.map((bucket) => bucket.costUsd),
      secondary: visibleBuckets.map((bucket) => bucket.cacheSavingsUsd),
    };
  }, [metric, visibleBuckets]);
  const formatChartValue = (value: number) => metric === 'cost' ? formatUsd(value) : formatCompact(value);
  const peak = Math.max(0, ...series.primary, ...series.secondary);

  const chart = useMemo(() => {
    const count = visibleBuckets.length;
    const toX = (index: number) => count <= 1 ? CHART_WIDTH / 2 : (index / (count - 1)) * CHART_WIDTH;
    const toY = (value: number) => peak === 0
      ? CHART_HEIGHT
      : CHART_HEIGHT - (value / peak) * (CHART_HEIGHT - CHART_TOP);
    return {
      primaryPoints: series.primary.map((value, index) => ({ x: toX(index), y: toY(value) })),
      secondaryPoints: series.secondary.map((value, index) => ({ x: toX(index), y: toY(value) })),
      toX,
    };
  }, [peak, series.primary, series.secondary, visibleBuckets.length]);

  if (visibleBuckets.length === 0 || peak === 0) {
    return (
      <div className="flex h-64 items-center justify-center border-y border-dashed border-[hsl(var(--app-border)/0.72)] text-sm text-muted-foreground">
        No activity in this range
      </div>
    );
  }

  const hoveredBucket = hoveredIndex === null ? null : visibleBuckets[hoveredIndex] ?? null;
  const hoveredPrimary = hoveredIndex === null ? 0 : series.primary[hoveredIndex] ?? 0;
  const hoveredSecondary = hoveredIndex === null ? 0 : series.secondary[hoveredIndex] ?? 0;
  const hoverLeft = visibleBuckets.length <= 1 ? 50 : ((hoveredIndex ?? 0) / (visibleBuckets.length - 1)) * 100;
  const axisLabels = visibleBuckets.length === 1
    ? ['', visibleBuckets[0]?.label ?? '', '']
    : visibleBuckets.length === 2
      ? [visibleBuckets[0]?.label ?? '', '', visibleBuckets[1]?.label ?? '']
      : [
          visibleBuckets[0]?.label ?? '',
          visibleBuckets[Math.floor(visibleBuckets.length / 2)]?.label ?? '',
          visibleBuckets[visibleBuckets.length - 1]?.label ?? '',
        ];

  const handleMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const bounds = plotRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setHoveredIndex(Math.round(fraction * (visibleBuckets.length - 1)));
  };

  return (
    <div data-testid="tracking-throughput-chart" className="space-y-2">
      <div className="flex items-center justify-end gap-4 text-[11px] font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-graph-commit))]" style={{ backgroundColor: series.primaryColor }} /> {series.primaryLabel}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-danger))]" style={{ backgroundColor: series.secondaryColor }} /> {series.secondaryLabel}</span>
      </div>
      <div className="flex gap-2">
        <div className="relative h-56 w-12 shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="absolute right-0 top-0">{formatChartValue(peak)}</span>
          <span className="absolute right-0 top-1/2 -translate-y-1/2">{formatChartValue(peak / 2)}</span>
          <span className="absolute bottom-0 right-0">{metric === 'cost' ? '$0' : '0'}</span>
        </div>
        <div
          ref={plotRef}
          className="relative h-56 min-w-0 flex-1"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <svg
            className="h-full w-full overflow-visible"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily ${metric === 'code' ? 'code output' : metric === 'tokens' ? 'token usage' : 'estimated cost'}`}
          >
            {[0, 0.5, 1].map((position) => (
              <line
                key={position}
                x1="0"
                x2={CHART_WIDTH}
                y1={CHART_HEIGHT * position}
                y2={CHART_HEIGHT * position}
                stroke="hsl(var(--app-border))"
                strokeOpacity="0.54"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={chartArea(chart.primaryPoints)} fill={series.primaryColor} fillOpacity="0.16" />
            <path d={chartArea(chart.secondaryPoints)} fill={series.secondaryColor} fillOpacity="0.1" />
            <path d={chartLine(chart.primaryPoints)} fill="none" stroke={series.primaryColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <path d={chartLine(chart.secondaryPoints)} fill="none" stroke={series.secondaryColor} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            {visibleBuckets.length === 1 && chart.primaryPoints[0] && chart.secondaryPoints[0] ? (
              <>
                <circle cx={chart.primaryPoints[0].x} cy={chart.primaryPoints[0].y} r="4" fill={series.primaryColor} vectorEffect="non-scaling-stroke" />
                <circle cx={chart.secondaryPoints[0].x} cy={chart.secondaryPoints[0].y} r="3" fill={series.secondaryColor} vectorEffect="non-scaling-stroke" />
              </>
            ) : null}
            {hoveredIndex === null ? null : (
              <line
                x1={chart.toX(hoveredIndex)}
                x2={chart.toX(hoveredIndex)}
                y1="0"
                y2={CHART_HEIGHT}
                stroke="hsl(var(--foreground))"
                strokeOpacity="0.45"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hoveredBucket === null ? null : (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel)/0.96)] px-3 py-2 text-xs shadow-[var(--app-shadow-floating)] backdrop-blur-xl"
              style={{
                left: `${hoverLeft}%`,
                transform: hoverLeft > 62 ? 'translateX(-100%)' : 'translateX(0)',
              }}
            >
              <div className="mb-1.5 text-muted-foreground">{hoveredBucket.label}</div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{series.primaryLabel}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">{formatChartValue(hoveredPrimary)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{series.secondaryLabel}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">{formatChartValue(hoveredSecondary)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-14 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {axisLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
      </div>
    </div>
  );
}

function BackgroundAttentionChart({ buckets }: { buckets: BackgroundAttentionBucket[] }) {
  const visibleBuckets = buckets.slice(-30);
  const hasActivity = visibleBuckets.some((bucket) => (
    bucket.totalTokens > 0
    || bucket.candidateCount > 0
    || bucket.skippedTriggers > 0
    || bucket.failedTriggers > 0
  ));
  const maxima = {
    tokens: Math.max(1, ...visibleBuckets.map((bucket) => bucket.totalTokens)),
    candidates: Math.max(1, ...visibleBuckets.map((bucket) => bucket.candidateCount)),
    'skips or failures': Math.max(
      1,
      ...visibleBuckets.map((bucket) => bucket.skippedTriggers + bucket.failedTriggers),
    ),
  };

  if (visibleBuckets.length === 0 || !hasActivity) {
    return (
      <div className="flex h-44 items-center justify-center border-y border-dashed border-[hsl(var(--app-border)/0.72)] text-sm text-muted-foreground">
        No background attention activity in this range
      </div>
    );
  }

  return (
    <div className="flex h-44 items-end gap-1.5 border-y border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-bg-muted)/0.2)] px-2 pb-2 pt-4">
      {visibleBuckets.map((bucket) => {
        const values = [
          { label: 'tokens' as const, value: bucket.totalTokens, className: 'bg-[hsl(var(--app-accent)/0.78)]' },
          { label: 'candidates' as const, value: bucket.candidateCount, className: 'bg-[hsl(var(--app-success)/0.76)]' },
          { label: 'skips or failures' as const, value: bucket.skippedTriggers + bucket.failedTriggers, className: 'bg-[hsl(var(--app-warning)/0.76)]' },
        ];
        return (
          <div key={bucket.key} className="group flex h-full min-w-0 flex-1 items-end justify-center gap-px" title={bucket.label}>
            {values.map((entry) => (
              <div
                key={entry.label}
                className={cn('w-full max-w-2 rounded-t-sm transition-[height,opacity] duration-200', entry.className, entry.value === 0 && 'opacity-15')}
                style={{ height: `${Math.max(3, (entry.value / maxima[entry.label]) * 100)}%` }}
                title={`${bucket.label}: ${formatNumber(entry.value)} ${entry.label}`}
              />
            ))}
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
      <aside className="absolute bottom-4 right-4 top-4 flex w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-[hsl(var(--app-border)/0.74)] bg-[hsl(var(--app-panel)/0.96)] shadow-[var(--app-shadow-floating)] backdrop-blur-xl">
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
                        {event.message && <p className="mt-2 text-xs leading-5 text-muted-foreground">{event.message}</p>}
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
                    {summary && <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={summary}>{summary}</div>}
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

function SourceBreakdown({ agentCommits, mergeCommits, manualCommits }: {
  agentCommits: number;
  mergeCommits: number;
  manualCommits: number;
}) {
  const total = agentCommits + mergeCommits + manualCommits;
  const sources = [
    { label: 'Agent', value: agentCommits, className: 'bg-[hsl(var(--app-graph-agent))]' },
    { label: 'Merge', value: mergeCommits, className: 'bg-[hsl(var(--app-graph-commit))]' },
    { label: 'Manual', value: manualCommits, className: 'bg-[hsl(var(--app-warning))]' },
  ];

  if (total === 0) {
    return (
      <div className="flex h-40 items-center justify-center border-y border-dashed border-[hsl(var(--app-border)/0.72)] text-sm text-muted-foreground">
        No commits in this range
      </div>
    );
  }

  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-[hsl(var(--app-bg-muted))]">
        {sources.map((source) => (
          <div key={source.label} className={source.className} style={{ width: `${(source.value / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-5 divide-y divide-[hsl(var(--app-border)/0.5)] border-y border-[hsl(var(--app-border)/0.62)]">
        {sources.map((source) => {
          const share = source.value / total;
          return (
            <div key={source.label} className="grid grid-cols-[minmax(0,1fr)_90px_90px] items-center gap-4 py-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <span className={cn('h-2.5 w-2.5 rounded-sm', source.className)} />
                {source.label}
              </div>
              <div className="text-right font-mono tabular-nums text-muted-foreground">{(share * 100).toFixed(1)}%</div>
              <div className="text-right font-mono font-semibold tabular-nums text-foreground">{formatNumber(source.value)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModelBreakdown({ rows }: { rows: TrackingModelUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center border-y border-dashed border-[hsl(var(--app-border)/0.72)] text-sm text-muted-foreground">
        No model usage in this range
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-sm">
        <thead>
          <tr className="border-b border-[hsl(var(--app-border)/0.72)] text-left text-[11px] text-muted-foreground">
            <th className="py-2.5 font-medium">Model</th>
            <th className="py-2.5 text-right font-medium">Runs</th>
            <th className="py-2.5 text-right font-medium">Tokens</th>
            <th className="py-2.5 text-right font-medium">Estimated cost</th>
            <th className="py-2.5 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-[hsl(var(--app-border)/0.4)] last:border-b-0">
              <td className="max-w-96 py-3 pr-4">
                <div className="truncate font-medium text-foreground">{row.model}</div>
                <div className="mt-1 text-xs capitalize text-muted-foreground">
                  {row.provider ?? 'Unknown provider'}
                  {row.unpricedRunCount > 0 ? ` · ${formatNumber(row.unpricedRunCount)} unpriced` : ''}
                </div>
              </td>
              <td className="py-3 text-right font-mono tabular-nums text-muted-foreground">{formatNumber(row.runCount)}</td>
              <td className="py-3 text-right font-mono tabular-nums text-muted-foreground">{formatCompact(row.totalTokens)}</td>
              <td className="py-3 text-right font-mono font-semibold tabular-nums text-foreground">
                {row.pricedRunCount > 0 ? formatUsd(row.costUsd) : 'Unpriced'}
              </td>
              <td className="py-3 text-right font-mono tabular-nums text-muted-foreground">
                {row.pricedRunCount > 0 ? `${(row.costShare * 100).toFixed(1)}%` : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: TrackingRunRow[] }) {
  if (runs.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center border-y border-dashed border-[hsl(var(--app-border)/0.72)] text-sm text-muted-foreground">
        No assistant runs with tracking data yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-[hsl(var(--app-border)/0.72)] text-left text-[11px] text-muted-foreground">
            <th className="py-2.5 font-medium">Run</th>
            <th className="py-2.5 font-medium">Time</th>
            <th className="py-2.5 font-medium">Status</th>
            <th className="py-2.5 text-right font-medium">Tokens</th>
            <th className="py-2.5 text-right font-medium">Estimated cost</th>
            <th className="py-2.5 text-right font-medium">LOC</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.nodeId} className="border-b border-[hsl(var(--app-border)/0.4)] last:border-b-0">
              <td className="max-w-80 py-3 pr-4">
                <div className="truncate font-medium text-foreground">{run.label}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  {run.model ?? run.provider ?? 'Unknown model'} · {formatNumber(run.commitCount)} commits
                </div>
              </td>
              <td className="whitespace-nowrap py-3 pr-4 text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</td>
              <td className="py-3 pr-4">
                <span className={cn('inline-flex max-w-full items-center rounded-md border px-2 py-1 text-[11px] font-semibold capitalize', statusClassName(run.status ?? null))}>
                  {run.status ?? 'unknown'}
                </span>
              </td>
              <td className="py-3 text-right font-mono font-semibold tabular-nums text-foreground">{formatCompact(run.totalTokens)}</td>
              <td className="py-3 text-right font-mono font-semibold tabular-nums text-foreground">
                {run.costSource === 'unpriced' ? 'Unpriced' : formatUsd(run.costUsd)}
              </td>
              <td className={cn('py-3 text-right font-mono font-semibold tabular-nums', run.netLoc >= 0 ? 'text-[hsl(var(--app-success))]' : 'text-[hsl(var(--app-danger))]')}>
                {formatSigned(run.netLoc)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackingDashboardSkeleton() {
  return (
    <div aria-label="Loading tracking dashboard" className="space-y-7">
      <section className="grid gap-8 border-y border-[hsl(var(--app-border)/0.68)] py-6 xl:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.7fr)]">
        <div className="space-y-5">
          <div className="h-3 w-28 rounded-sm bg-[hsl(var(--app-bg-muted))]" />
          <div className="h-11 w-48 rounded-md bg-[hsl(var(--app-bg-muted))]" />
          <div className="h-3 w-56 rounded-sm bg-[hsl(var(--app-bg-muted))]" />
          <div className="space-y-4 pt-2">
            <div className="h-10 rounded-md bg-[hsl(var(--app-bg-muted)/0.74)]" />
            <div className="h-10 rounded-md bg-[hsl(var(--app-bg-muted)/0.74)]" />
          </div>
        </div>
        <div className="h-72 rounded-lg bg-[hsl(var(--app-bg-muted)/0.62)]" />
      </section>
      <div className="grid grid-cols-2 gap-px border-y border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-border)/0.66)] md:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="h-24 bg-[hsl(var(--app-panel)/0.72)]" />)}
      </div>
      <div className="h-72 rounded-lg bg-[hsl(var(--app-bg-muted)/0.48)]" />
    </div>
  );
}

export function TrackingDashboard({ workspace }: TrackingDashboardProps) {
  const [range, setRange] = useState<TrackingRange>('7d');
  const [chartMetric, setChartMetric] = useState<TrackingChartMetric>('code');
  const [breakdownView, setBreakdownView] = useState<BreakdownView>('runs');
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  const { metrics, isLoading, isRefreshing, error } = useTrackingDashboardData(workspace, range);
  const backgroundAttention = metrics.backgroundAttention;
  const observedAttentionRuns = Math.max(backgroundAttention.totals.runCount, backgroundAttention.totals.ranTriggers);
  const churn = metrics.totals.locAdded + metrics.totals.locDeleted;
  const observedTokens = metrics.totals.promptTokens + metrics.totals.completionTokens;
  const costAndSavings = metrics.totals.estimatedCostUsd + metrics.totals.cacheSavingsUsd;
  const hasKnownCost = metrics.totals.costKnownRuns > 0;

  const summaryRows = chartMetric === 'code'
    ? [
        {
          label: 'Added',
          value: formatNumber(metrics.totals.locAdded),
          share: churn === 0 ? 0 : metrics.totals.locAdded / churn,
          colorClassName: 'bg-[hsl(var(--app-graph-commit))]',
          detail: `${formatNumber(metrics.totals.locKnownCommits)} commits with line stats`,
        },
        {
          label: 'Deleted',
          value: formatNumber(metrics.totals.locDeleted),
          share: churn === 0 ? 0 : metrics.totals.locDeleted / churn,
          colorClassName: 'bg-[hsl(var(--app-danger))]',
          detail: `${formatNumber(metrics.totals.locCoveragePercent)}% LOC coverage`,
        },
      ]
    : chartMetric === 'tokens' ? [
        {
          label: 'Input',
          value: formatCompact(metrics.totals.promptTokens),
          share: observedTokens === 0 ? 0 : metrics.totals.promptTokens / observedTokens,
          colorClassName: 'bg-[hsl(var(--app-accent))]',
          detail: 'Prompt and context tokens',
        },
        {
          label: 'Output',
          value: formatCompact(metrics.totals.completionTokens),
          share: observedTokens === 0 ? 0 : metrics.totals.completionTokens / observedTokens,
          colorClassName: 'bg-[hsl(var(--app-graph-summary))]',
          detail: `${formatNumber(metrics.totals.tokenCoveragePercent)}% run coverage`,
        },
      ]
    : [
        {
          label: 'Usage cost',
          value: hasKnownCost ? formatUsd(metrics.totals.estimatedCostUsd) : 'Unpriced',
          share: costAndSavings === 0 ? 0 : metrics.totals.estimatedCostUsd / costAndSavings,
          colorClassName: 'bg-[hsl(var(--app-warning))]',
          detail: `${formatNumber(metrics.totals.costKnownRuns)} of ${formatNumber(metrics.totals.costEligibleRuns)} runs priced`,
        },
        {
          label: 'Cache saved',
          value: formatUsd(metrics.totals.cacheSavingsUsd),
          share: costAndSavings === 0 ? 0 : metrics.totals.cacheSavingsUsd / costAndSavings,
          colorClassName: 'bg-[hsl(var(--app-success))]',
          detail: 'Compared with full-price input tokens',
        },
      ];

  return (
    <div className="app-view-frame mx-auto flex h-full w-full max-w-7xl flex-col">
      <header className="app-view-header">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Workspace tracking</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Tracking</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {formatRange(metrics.startedAt, metrics.endedAt)} · {workspace?.name ?? 'Selected workspace'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {isRefreshing && !isLoading && (
            <div className="hidden items-center gap-2 text-xs font-medium text-muted-foreground sm:flex">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Updating
            </div>
          )}
          <div className="flex overflow-hidden rounded-lg border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel-strong)/0.5)] p-0.5" role="group" aria-label="Tracking date range">
            {rangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={range === option.value}
                className={cn(
                  'app-focus-ring h-8 rounded-md px-3 text-xs font-semibold transition-[background-color,color,box-shadow]',
                  range === option.value
                    ? 'bg-[hsl(var(--app-panel))] text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.08),inset_0_0_0_1px_hsl(var(--app-border)/0.56)]'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {error && (
          <div className="mb-5 rounded-xl border border-[hsl(var(--app-danger)/0.24)] bg-[hsl(var(--app-danger)/0.08)] px-4 py-3 text-sm text-[hsl(var(--app-danger))]">
            Tracking data could not fully refresh: {error.message}
          </div>
        )}

        {isLoading ? (
          <TrackingDashboardSkeleton />
        ) : (
          <div className="space-y-7">
            <section className="grid gap-8 border-y border-[hsl(var(--app-border)/0.68)] py-6 xl:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.7fr)]">
              <div className="flex flex-col gap-5">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {chartMetric === 'code' ? 'Net code output' : chartMetric === 'tokens' ? 'Processed tokens' : 'Estimated raw cost'}
                  </div>
                  <div className="mt-1.5 font-mono text-4xl font-semibold tracking-[-0.035em] text-foreground tabular-nums">
                    {chartMetric === 'code'
                      ? formatSigned(metrics.totals.netLoc)
                      : chartMetric === 'tokens'
                        ? formatCompact(metrics.totals.totalTokens)
                        : hasKnownCost ? formatUsd(metrics.totals.estimatedCostUsd) : 'Unpriced'}
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {chartMetric === 'code'
                      ? 'Additions minus deletions across tracked workspace commits.'
                      : chartMetric === 'tokens'
                        ? `Input and output captured across ${formatNumber(metrics.totals.tokenKnownRuns)} assistant runs.`
                        : `API-equivalent estimate, not your subscription bill · ${formatNumber(metrics.totals.costCoveragePercent)}% run coverage.`}
                  </p>
                  {chartMetric === 'cost' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      LiteLLM rates · {metrics.pricing.status === 'fresh' ? 'updated now' : metrics.pricing.status === 'cached' ? 'cached for offline use' : 'rate table unavailable'}
                    </p>
                  )}
                </div>
                <div className="space-y-4">
                  {summaryRows.map((row) => <SummaryBreakdownRow key={row.label} {...row} />)}
                </div>
              </div>

              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">Daily activity</h2>
                    <p className="mt-1 text-xs text-muted-foreground">Compare code output, token volume, and estimated API cost.</p>
                  </div>
                  <SegmentedControl
                    value={chartMetric}
                    options={[{ value: 'code', label: 'Code' }, { value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }]}
                    onChange={setChartMetric}
                    ariaLabel="Daily activity metric"
                  />
                </div>
                <ThroughputChart buckets={metrics.buckets} metric={chartMetric} />
              </div>
            </section>

            <section className="grid grid-cols-2 gap-px border-y border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-border)/0.66)] md:grid-cols-5" aria-label="Tracking metrics">
              {chartMetric === 'code' ? (
                <>
                  <MetricCell label="Commits" value={formatNumber(metrics.totals.commits)} detail={`${formatNumber(metrics.totals.agentCommits)} agent · ${formatNumber(metrics.totals.mergeCommits)} merge`} icon={<GitCommitHorizontal className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />} />
                  <MetricCell label="Lines added" value={formatCompact(metrics.totals.locAdded)} detail={`${formatNumber(metrics.totals.locCoveragePercent)}% commit coverage`} icon={<Code2 className="h-3.5 w-3.5 text-[hsl(var(--app-success))]" />} />
                  <MetricCell label="Lines deleted" value={formatCompact(metrics.totals.locDeleted)} detail={`${formatSigned(metrics.totals.netLoc)} net output`} icon={<Hash className="h-3.5 w-3.5 text-[hsl(var(--app-danger))]" />} />
                  <MetricCell label="Processed tokens" value={formatCompact(metrics.totals.totalTokens)} detail={`${formatNumber(metrics.totals.tokenKnownRuns)} of ${formatNumber(metrics.totals.tokenEligibleRuns)} runs captured`} icon={<CircleDot className="h-3.5 w-3.5 text-[hsl(var(--app-warning))]" />} />
                  <MetricCell label="Tokens per commit" value={metrics.totals.tokensPerCommit === null ? '-' : formatCompact(metrics.totals.tokensPerCommit)} detail={`${metrics.totals.tokensPerLocAdded === null ? '-' : formatCompact(metrics.totals.tokensPerLocAdded)} per added line`} icon={<Gauge className="h-3.5 w-3.5 text-muted-foreground" />} />
                </>
              ) : chartMetric === 'tokens' ? (
                <>
                  <MetricCell label="Processed tokens" value={formatCompact(metrics.totals.totalTokens)} detail={`${formatNumber(metrics.totals.tokenCoveragePercent)}% run coverage`} icon={<CircleDot className="h-3.5 w-3.5 text-[hsl(var(--app-warning))]" />} />
                  <MetricCell label="Uncached input" value={formatCompact(metrics.totals.uncachedInputTokens)} detail="Full-price prompt and context" icon={<Hash className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />} />
                  <MetricCell label="Cached input" value={formatCompact(metrics.totals.cachedInputTokens)} detail={`${formatUsd(metrics.totals.cacheSavingsUsd)} estimated savings`} icon={<Gauge className="h-3.5 w-3.5 text-[hsl(var(--app-success))]" />} />
                  <MetricCell label="Cache writes" value={formatCompact(metrics.totals.cacheCreationInputTokens)} detail="New cache creation tokens" icon={<Code2 className="h-3.5 w-3.5 text-muted-foreground" />} />
                  <MetricCell label="Output" value={formatCompact(metrics.totals.outputTokens)} detail={`${formatCompact(metrics.totals.reasoningTokens)} reasoning`} icon={<Sparkles className="h-3.5 w-3.5 text-[hsl(var(--app-graph-summary))]" />} />
                </>
              ) : (
                <>
                  <MetricCell label="Estimated cost" value={hasKnownCost ? formatUsd(metrics.totals.estimatedCostUsd) : 'Unpriced'} detail={`${formatNumber(metrics.totals.costCoveragePercent)}% run coverage`} icon={<DollarSign className="h-3.5 w-3.5 text-[hsl(var(--app-warning))]" />} />
                  <MetricCell label="Input cost" value={formatUsd(metrics.totals.inputCostUsd)} detail="Model-rated allocation" icon={<Hash className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />} />
                  <MetricCell label="Output cost" value={formatUsd(metrics.totals.outputCostUsd)} detail="Model-rated allocation" icon={<Sparkles className="h-3.5 w-3.5 text-[hsl(var(--app-graph-summary))]" />} />
                  <MetricCell label="Cache savings" value={formatUsd(metrics.totals.cacheSavingsUsd)} detail={`${formatCompact(metrics.totals.cachedInputTokens)} cached tokens`} icon={<Gauge className="h-3.5 w-3.5 text-[hsl(var(--app-success))]" />} />
                  <MetricCell label="Unpriced tokens" value={formatCompact(metrics.totals.unpricedTokens)} detail={`${formatNumber(metrics.totals.costEligibleRuns - metrics.totals.costKnownRuns)} runs need rates`} icon={<CircleDot className="h-3.5 w-3.5 text-muted-foreground" />} />
                </>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Breakdown</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Inspect recent outcomes, model usage, or commit sources.</p>
                </div>
                <SegmentedControl
                  value={breakdownView}
                  options={[{ value: 'runs', label: 'Runs' }, { value: 'model', label: 'Model' }, { value: 'source', label: 'Source' }]}
                  onChange={setBreakdownView}
                  ariaLabel="Tracking breakdown"
                />
              </div>
              {breakdownView === 'runs' ? (
                <RecentRunsTable runs={metrics.recentRuns} />
              ) : breakdownView === 'model' ? (
                <ModelBreakdown rows={metrics.modelUsage} />
              ) : (
                <SourceBreakdown
                  agentCommits={metrics.totals.agentCommits}
                  mergeCommits={metrics.totals.mergeCommits}
                  manualCommits={metrics.totals.manualCommits}
                />
              )}
            </section>

            <section className="rounded-2xl border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel)/0.72)] p-4 shadow-[var(--app-shadow-panel)]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Brain className="h-4 w-4 text-[hsl(var(--app-accent))]" />
                    Background attention
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Private insight work stays separate from primary coding output, with its own usage trail.
                  </p>
                </div>
                <button
                  type="button"
                  className="app-focus-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.62)] px-3 text-xs font-semibold text-foreground transition-[background-color,transform] hover:bg-[hsl(var(--app-panel-strong)/0.86)] active:scale-[0.96]"
                  onClick={() => setAuditDrawerOpen(true)}
                >
                  <PanelRightOpen className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />
                  View audit
                  <span className="font-mono text-[11px] text-muted-foreground">{formatNumber(backgroundAttention.totals.auditEventCount)}</span>
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-px border-y border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-border)/0.58)] md:grid-cols-4">
                <MetricCell
                  label="Runs"
                  value={formatNumber(observedAttentionRuns)}
                  detail={`${formatNumber(backgroundAttention.totals.queuedTriggers)} queued · ${formatNumber(backgroundAttention.totals.failedTriggers)} failed`}
                  icon={<CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--app-success))]" />}
                />
                <MetricCell
                  label="Tokens"
                  value={formatCompact(backgroundAttention.totals.totalTokens)}
                  detail={`${formatCompact(backgroundAttention.totals.promptTokens)} in · ${formatCompact(backgroundAttention.totals.completionTokens)} out`}
                  icon={<CircleDot className="h-3.5 w-3.5 text-[hsl(var(--app-warning))]" />}
                />
                <MetricCell
                  label="Candidates"
                  value={formatNumber(backgroundAttention.totals.candidateCount)}
                  detail={`${formatNumber(backgroundAttention.totals.surfacedCount)} surfaced · ${formatNumber(backgroundAttention.totals.savedCount)} saved`}
                  icon={<Sparkles className="h-3.5 w-3.5 text-[hsl(var(--app-accent))]" />}
                />
                <MetricCell
                  label="Skipped"
                  value={formatNumber(backgroundAttention.totals.skippedTriggers)}
                  detail={`${formatNumber(backgroundAttention.totals.baselineEvents)} baselines · ${formatNumber(backgroundAttention.totals.archivedCount)} archived`}
                  icon={<Hash className="h-3.5 w-3.5 text-muted-foreground" />}
                />
              </div>

              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
                  <span>{formatNumber(backgroundAttention.totals.auditEventCount)} audit events in this range</span>
                  <span className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-accent))]" /> Tokens</span>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-success))]" /> Candidates</span>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[hsl(var(--app-warning))]" /> Skips/failures</span>
                  </span>
                </div>
                <BackgroundAttentionChart buckets={backgroundAttention.buckets} />
              </div>
            </section>
          </div>
        )}
      </div>

      <BackgroundAttentionAuditDrawer
        open={auditDrawerOpen}
        events={backgroundAttention.recentAuditEvents}
        onClose={() => setAuditDrawerOpen(false)}
      />
    </div>
  );
}
