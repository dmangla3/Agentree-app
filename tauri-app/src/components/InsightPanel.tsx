import { useMemo, useState, type ReactNode } from 'react';
import {
    AlertTriangle,
    Archive,
    Brain,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    CircleDot,
    Eye,
    GitBranch,
    Lightbulb,
    Search,
    ShieldAlert,
    X,
    type LucideIcon,
} from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { cn } from '../lib/utils';
import type { Insight, InsightCandidate } from '../stores/workspaceStore';
import { TokenUsagePill, formatTokenValue } from './TokenUsagePill';

interface InsightPanelProps {
    insights: Insight[];
    candidates?: InsightCandidate[];
    focusedMessageId?: string | null;
    isVisible?: boolean;
    variant?: 'dock' | 'popover';
    onToggleVisibility?: () => void;
    onViewInsight?: (insight: Insight) => void;
    onViewSource?: (parentNodeId: string) => void;
    onDismissInsight?: (insightId: string) => void;
    onPromoteToBranch?: (insight: Insight) => void;
    onRecordFeedback?: (insightId: string, action: string, context?: unknown) => void;
    className?: string;
}

type InboxTab = 'needs' | 'saved' | 'turn';

const AGENT_CONFIG: Record<string, { Icon: LucideIcon; label: string; className: string }> = {
    hypothesis: { Icon: Lightbulb, label: 'Hypothesis', className: 'text-amber-600 dark:text-amber-300' },
    doubt: { Icon: ShieldAlert, label: 'Doubt', className: 'text-amber-700 dark:text-amber-300' },
    meta: { Icon: Brain, label: 'Meta', className: 'text-slate-600 dark:text-slate-300' },
    association: { Icon: GitBranch, label: 'Connection', className: 'text-emerald-700 dark:text-emerald-300' },
    memory: { Icon: Brain, label: 'Memory', className: 'text-slate-600 dark:text-slate-300' },
    kb: { Icon: Search, label: 'Knowledge', className: 'text-slate-600 dark:text-slate-300' },
    risk: { Icon: AlertTriangle, label: 'Risk', className: 'text-red-600 dark:text-red-300' },
    opportunity: { Icon: CheckCircle2, label: 'Opportunity', className: 'text-emerald-700 dark:text-emerald-300' },
};

const SAVED_STATUSES = new Set(['validated', 'seed', 'explored']);
const ARCHIVED_STATUSES = new Set(['archived']);
const LIST_LIMIT = 20;

const percent = (value: number | null | undefined) => `${Math.round((value ?? 0) * 100)}%`;

interface BackgroundUsage {
    sourceRunNodeId?: string | null;
    triggerClass?: string | null;
    triggerReason?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    cachedInputTokens?: number | null;
    reasoningTokens?: number | null;
    totalTokens?: number | null;
    estimatedCostUsd?: number | null;
}

interface BackgroundUsageTotals {
    promptTokens: number;
    completionTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
}

const numberField = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
);

const normalizeTotalTokens = (usage: BackgroundUsage): number | null => {
    if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens;
    if (typeof usage.promptTokens === 'number' || typeof usage.completionTokens === 'number') {
        return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    }
    return null;
};

const usageFromPayload = (payload: unknown): BackgroundUsage => {
    if (!payload || typeof payload !== 'object') return {};
    const record = payload as Record<string, unknown>;
    return {
        sourceRunNodeId: typeof record.sourceRunNodeId === 'string' ? record.sourceRunNodeId : null,
        triggerClass: typeof record.triggerClass === 'string' ? record.triggerClass : null,
        triggerReason: typeof record.triggerReason === 'string' ? record.triggerReason : null,
        promptTokens: numberField(record.promptTokens),
        completionTokens: numberField(record.completionTokens),
        cachedInputTokens: numberField(record.cachedInputTokens),
        reasoningTokens: numberField(record.reasoningTokens),
        totalTokens: numberField(record.totalTokens),
        estimatedCostUsd: numberField(record.estimatedCostUsd),
    };
};

const usageFromInsight = (insight: Insight): BackgroundUsage => ({
    sourceRunNodeId: insight.sourceRunNodeId,
    triggerClass: insight.triggerClass,
    triggerReason: insight.triggerReason,
    promptTokens: insight.promptTokens,
    completionTokens: insight.completionTokens,
    cachedInputTokens: insight.cachedInputTokens,
    reasoningTokens: insight.reasoningTokens,
    totalTokens: insight.totalTokens,
    estimatedCostUsd: insight.estimatedCostUsd,
});

const usageFromCandidate = (candidate: InsightCandidate): BackgroundUsage => {
    try {
        return {
            sourceRunNodeId: candidate.sourceRunNodeId,
            ...usageFromPayload(JSON.parse(candidate.payload)),
        };
    } catch {
        return { sourceRunNodeId: candidate.sourceRunNodeId };
    }
};

const triggerLabel = (usage: BackgroundUsage): string | null => {
    const raw = usage.triggerReason || usage.triggerClass;
    if (!raw) return null;
    return raw
        .replace(/^light_/, 'light · ')
        .replace(/_/g, ' ')
        .trim();
};

const formatCost = (value: number | null | undefined): string | null => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
};

const shortNodeId = (value: string | null | undefined): string | null => {
    if (!value) return null;
    return value.length > 10 ? `${value.slice(0, 8)}…` : value;
};

function InsightUsageMeta({ usage }: { usage: BackgroundUsage }) {
    const totalTokens = normalizeTotalTokens(usage);
    const trigger = triggerLabel(usage);
    const cost = formatCost(usage.estimatedCostUsd);
    if (!totalTokens && !trigger && !cost) return null;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <TokenUsagePill
                promptTokens={usage.promptTokens}
                completionTokens={usage.completionTokens}
                cachedInputTokens={usage.cachedInputTokens}
                reasoningTokens={usage.reasoningTokens}
                totalTokens={totalTokens}
            />
            {cost ? (
                <span className="rounded-lg border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground dark:bg-slate-800/50">
                    {cost}
                </span>
            ) : null}
            {trigger ? (
                <span className="rounded-lg border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground dark:bg-slate-800/50">
                    {trigger}
                </span>
            ) : null}
        </div>
    );
}

function AxisBadge({ label, value }: { label: string; value: number | null | undefined }) {
    return (
        <span className="rounded-full border border-slate-200 bg-white/70 px-2 py-0.5 text-[10px] font-medium tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
            {label} {percent(value)}
        </span>
    );
}

function KindPill({ kind }: { kind: string }) {
    const config = AGENT_CONFIG[kind] ?? AGENT_CONFIG.hypothesis;
    const Icon = config.Icon;
    return (
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] dark:border-slate-800 dark:bg-slate-950/60', config.className)}>
            <Icon className="h-3 w-3" strokeWidth={1.8} />
            {config.label}
        </span>
    );
}

function SourceTurnPill({ parentNodeId }: { parentNodeId?: string | null }) {
    const label = shortNodeId(parentNodeId);
    if (!label) return null;
    return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-1 font-mono text-[10px] font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            source {label}
        </span>
    );
}

function AttentionItemFrame({
    kind,
    title,
    status,
    parentNodeId,
    usage,
    expanded,
    onToggle,
    children,
    actions,
}: {
    kind: string;
    title: string;
    status?: string | null;
    parentNodeId?: string | null;
    usage: BackgroundUsage;
    expanded: boolean;
    onToggle: () => void;
    children?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <article className="rounded-2xl border border-slate-200/80 bg-white/88 p-3.5 shadow-[0_16px_40px_-34px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-slate-800/88 dark:bg-slate-950/82 dark:shadow-[0_18px_42px_-34px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <button
                type="button"
                className="flex w-full items-start gap-3 text-left"
                onClick={onToggle}
            >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-950/24 dark:text-amber-200">
                    <Brain className="h-4 w-4" strokeWidth={1.8} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <KindPill kind={kind} />
                        {status ? (
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                                {status}
                            </span>
                        ) : null}
                        <SourceTurnPill parentNodeId={parentNodeId} />
                    </div>
                    <p className="text-sm font-medium leading-5 text-slate-950 dark:text-slate-50">{title}</p>
                    <div className="mt-2">
                        <InsightUsageMeta usage={usage} />
                    </div>
                </div>
                <span className="mt-1 shrink-0 text-slate-400">
                    {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </span>
            </button>
            {expanded ? (
                <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                    {children}
                    {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
                </div>
            ) : null}
        </article>
    );
}

function SurfacedCard({
    insight,
    expanded,
    onToggle,
    onView,
    onDismiss,
    onPromote,
}: {
    insight: Insight;
    expanded: boolean;
    onToggle: () => void;
    onView: () => void;
    onDismiss: () => void;
    onPromote: () => void;
}) {
    return (
        <AttentionItemFrame
            kind={insight.agentType}
            title={insight.content}
            parentNodeId={insight.parentNodeId}
            usage={usageFromInsight(insight)}
            expanded={expanded}
            onToggle={onToggle}
        >
            <div className="flex flex-wrap gap-1.5">
                <AxisBadge label="novel" value={insight.validationResults?.novelty} />
                <AxisBadge label="relevant" value={insight.validationResults?.relevance} />
                <AxisBadge label="action" value={insight.validationResults?.actionability} />
                <AxisBadge label="timing" value={insight.validationResults?.timing} />
                <AxisBadge label="risk" value={insight.validationResults?.risk} />
            </div>
            {insight.surfaceReason ? (
                <p className="rounded-xl bg-amber-50/82 px-3 py-2 text-xs leading-5 text-amber-950 dark:bg-amber-950/24 dark:text-amber-100">
                    {insight.surfaceReason}
                </p>
            ) : null}
            {insight.fullExploration ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-slate-900/58 dark:text-slate-300">
                    {insight.fullExploration}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onView}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" />
                    View turn
                </Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onPromote}>
                    <GitBranch className="mr-1.5 h-3.5 w-3.5" />
                    Promote
                </Button>
                <Button variant="ghost" size="sm" className="h-8 text-xs text-slate-500 hover:text-red-600" onClick={onDismiss}>
                    Dismiss
                </Button>
            </div>
        </AttentionItemFrame>
    );
}

function CandidateCard({
    candidate,
    expanded,
    onToggle,
    onViewSource,
}: {
    candidate: InsightCandidate;
    expanded: boolean;
    onToggle: () => void;
    onViewSource?: (parentNodeId: string) => void;
}) {
    const usage = usageFromCandidate(candidate);
    const exploration = useMemo(() => {
        if (!candidate.explorationJson) return null;
        try {
            return JSON.parse(candidate.explorationJson) as { analysis?: string; raw?: unknown };
        } catch {
            return { analysis: candidate.explorationJson };
        }
    }, [candidate.explorationJson]);

    return (
        <AttentionItemFrame
            kind={candidate.agentKind}
            title={candidate.claim}
            status={candidate.status}
            parentNodeId={candidate.parentNodeId}
            usage={usage}
            expanded={expanded}
            onToggle={onToggle}
        >
            <div className="flex flex-wrap gap-1.5">
                <AxisBadge label="novel" value={candidate.noveltyScore} />
                <AxisBadge label="relevant" value={candidate.relevanceScore} />
                <AxisBadge label="action" value={candidate.actionabilityScore} />
                <AxisBadge label="timing" value={candidate.timingScore} />
                <AxisBadge label="risk" value={candidate.riskScore} />
                <AxisBadge label="conf" value={candidate.confidence} />
            </div>
            {candidate.surfaceReason ? (
                <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{candidate.surfaceReason}</p>
            ) : null}
            {candidate.rationale ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-slate-900/58 dark:text-slate-300">
                    {candidate.rationale}
                </p>
            ) : null}
            {exploration?.analysis ? (
                <p className="rounded-xl bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
                    {exploration.analysis}
                </p>
            ) : null}
            {candidate.parentNodeId ? (
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onViewSource?.(candidate.parentNodeId)}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" />
                    View turn
                </Button>
            ) : null}
        </AttentionItemFrame>
    );
}

function EmptyInbox({ label }: { label: string }) {
    return (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/80 bg-white/52 px-6 text-center dark:border-slate-700/80 dark:bg-slate-950/35">
            <CircleDot className="h-7 w-7 text-slate-400" strokeWidth={1.7} />
            <div className="mt-3 text-sm font-semibold text-slate-950 dark:text-slate-50">{label}</div>
            <p className="mt-2 max-w-[28ch] text-sm leading-6 text-slate-500 dark:text-slate-400">
                Background attention stays quiet until something clears the bar.
            </p>
        </div>
    );
}

export function InsightPanel({
    insights,
    candidates = [],
    focusedMessageId = null,
    isVisible = false,
    variant = 'dock',
    onToggleVisibility,
    onViewInsight,
    onViewSource,
    onDismissInsight,
    onPromoteToBranch,
    onRecordFeedback,
    className,
}: InsightPanelProps) {
    const [activeTab, setActiveTab] = useState<InboxTab>('needs');
    const [expandedInsightId, setExpandedInsightId] = useState<string | null>(null);
    const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);

    const surfacedCandidateIds = useMemo(() => (
        new Set(insights.map((insight) => insight.candidateId ?? insight.id))
    ), [insights]);
    const savedCandidates = useMemo(() => candidates.filter((candidate) => (
        !surfacedCandidateIds.has(candidate.candidateId)
        && SAVED_STATUSES.has(candidate.status)
    )), [candidates, surfacedCandidateIds]);
    const archivedCandidates = useMemo(() => candidates.filter((candidate) => (
        !surfacedCandidateIds.has(candidate.candidateId)
        && ARCHIVED_STATUSES.has(candidate.status)
    )), [candidates, surfacedCandidateIds]);
    const turnInsights = useMemo(() => (
        focusedMessageId ? insights.filter((insight) => insight.parentNodeId === focusedMessageId) : []
    ), [focusedMessageId, insights]);
    const turnCandidates = useMemo(() => (
        focusedMessageId
            ? candidates.filter((candidate) => (
                candidate.parentNodeId === focusedMessageId
                && !surfacedCandidateIds.has(candidate.candidateId)
                && candidate.status !== 'dismissed'
            ))
            : []
    ), [candidates, focusedMessageId, surfacedCandidateIds]);

    const usageSummary = useMemo(() => {
        const byRun = new Map<string, BackgroundUsage>();
        for (const insight of insights) {
            const usage = usageFromInsight(insight);
            const key = usage.sourceRunNodeId || insight.id;
            byRun.set(key, usage);
        }
        for (const candidate of candidates) {
            const usage = usageFromCandidate(candidate);
            const key = usage.sourceRunNodeId || candidate.candidateId;
            if (!byRun.has(key)) byRun.set(key, usage);
        }
        const totals = Array.from(byRun.values()).reduce<BackgroundUsageTotals>((acc, usage) => ({
            promptTokens: acc.promptTokens + (usage.promptTokens ?? 0),
            completionTokens: acc.completionTokens + (usage.completionTokens ?? 0),
            cachedInputTokens: acc.cachedInputTokens + (usage.cachedInputTokens ?? 0),
            reasoningTokens: acc.reasoningTokens + (usage.reasoningTokens ?? 0),
            totalTokens: acc.totalTokens + (normalizeTotalTokens(usage) ?? 0),
        }), {
            promptTokens: 0,
            completionTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        });
        return { runCount: byRun.size, totals };
    }, [candidates, insights]);

    const turnCount = turnInsights.length + turnCandidates.length;
    const selectedTab: InboxTab = activeTab === 'turn' && !focusedMessageId ? 'needs' : activeTab;
    const activeCount = selectedTab === 'needs'
        ? insights.length
        : selectedTab === 'saved'
            ? savedCandidates.length
            : turnCount;
    const visibleLimit = selectedTab === 'turn' ? LIST_LIMIT : LIST_LIMIT;

    const handleExpandInsight = (insight: Insight, source: string) => {
        const next = expandedInsightId === insight.id ? null : insight.id;
        setExpandedInsightId(next);
        if (next) onRecordFeedback?.(insight.id, 'expanded', { source });
    };

    const renderInsightList = (items: Insight[], source: string) => (
        <div className="space-y-3">
            {items.slice(0, visibleLimit).map((insight) => (
                <SurfacedCard
                    key={insight.id}
                    insight={insight}
                    expanded={expandedInsightId === insight.id}
                    onToggle={() => handleExpandInsight(insight, source)}
                    onView={() => {
                        onRecordFeedback?.(insight.id, 'seen', { source: 'attention-inbox' });
                        onViewInsight?.(insight);
                    }}
                    onDismiss={() => onDismissInsight?.(insight.id)}
                    onPromote={() => {
                        onRecordFeedback?.(insight.id, 'promoted', { source: 'attention-inbox' });
                        onPromoteToBranch?.(insight);
                    }}
                />
            ))}
        </div>
    );

    const renderCandidateList = (items: InsightCandidate[], source: string) => (
        <div className="space-y-3">
            {items.slice(0, visibleLimit).map((candidate) => (
                <CandidateCard
                    key={candidate.candidateId}
                    candidate={candidate}
                    expanded={expandedCandidateId === candidate.candidateId}
                    onToggle={() => {
                        const next = expandedCandidateId === candidate.candidateId ? null : candidate.candidateId;
                        setExpandedCandidateId(next);
                        if (next) onRecordFeedback?.(candidate.candidateId, 'expanded', { source });
                    }}
                    onViewSource={onViewSource}
                />
            ))}
        </div>
    );

    if (!isVisible) return null;

    return (
        <aside className={cn(
            variant === 'dock'
                ? 'absolute bottom-4 right-4 top-20 z-50 flex w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[1.4rem] border border-slate-200/82 bg-slate-50/94 shadow-[0_24px_80px_-42px_rgba(15,23,42,0.62),inset_0_1px_0_rgba(255,255,255,0.74)] backdrop-blur-xl dark:border-slate-800/88 dark:bg-slate-950/94 dark:shadow-[0_24px_82px_-42px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.04)]'
                : 'flex h-full w-full flex-col overflow-hidden bg-transparent',
            className,
        )}>
            <header className="border-b border-slate-200/72 bg-white/62 px-4 py-4 dark:border-slate-800/82 dark:bg-slate-950/48">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-950/28 dark:text-amber-200">
                                <Brain className="h-4 w-4" strokeWidth={1.8} />
                            </div>
                            <div>
                                <div className="text-sm font-semibold text-slate-950 dark:text-slate-50">Attention Inbox</div>
                                <div className="mt-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">Workspace-level observations</div>
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="app-focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-[background-color,color,transform] hover:bg-slate-100 hover:text-slate-950 active:scale-[0.96] dark:hover:bg-slate-900 dark:hover:text-slate-50"
                        onClick={onToggleVisibility}
                        aria-label="Close Attention Inbox"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="mt-4 grid grid-cols-[1fr_1.15fr] gap-2">
                    <div className="rounded-2xl border border-slate-200/78 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-950/60">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Items</div>
                        <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-950 dark:text-slate-50">
                            {insights.length}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{savedCandidates.length} saved · {archivedCandidates.length} explored</div>
                    </div>
                    <div className="rounded-2xl border border-slate-200/78 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-950/60">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Background usage</div>
                        <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-950 dark:text-slate-50">
                            {usageSummary.runCount}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{formatTokenValue(usageSummary.totals.totalTokens) ?? '0'} tokens</div>
                    </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-1 rounded-2xl border border-slate-200/72 bg-slate-100/70 p-1 dark:border-slate-800 dark:bg-slate-900/64">
                    {[
                        { id: 'needs' as const, label: 'Needs', count: insights.length },
                        { id: 'saved' as const, label: 'Saved', count: savedCandidates.length },
                        { id: 'turn' as const, label: 'This turn', count: turnCount, disabled: !focusedMessageId },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            disabled={tab.disabled}
                            className={cn(
                                'app-focus-ring h-9 rounded-xl px-2 text-xs font-semibold transition-[background-color,color,box-shadow,transform] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45',
                                selectedTab === tab.id
                                    ? 'bg-white text-slate-950 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_0_0_1px_rgba(148,163,184,0.28)] dark:bg-slate-950 dark:text-slate-50'
                                    : 'text-slate-500 hover:bg-white/52 hover:text-slate-800 dark:hover:bg-slate-950/48 dark:hover:text-slate-100',
                            )}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                            <span className="ml-1 font-mono tabular-nums">{tab.count}</span>
                        </button>
                    ))}
                </div>
            </header>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-medium">
                        Showing {Math.min(activeCount, visibleLimit)} of {activeCount}
                    </span>
                    {selectedTab === 'saved' && archivedCandidates.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                            <Archive className="h-3.5 w-3.5" />
                            {archivedCandidates.length} explored separately
                        </span>
                    ) : null}
                </div>

                {selectedTab === 'needs' ? (
                    insights.length > 0 ? renderInsightList(insights, 'attention-inbox-needs') : <EmptyInbox label="No items need attention" />
                ) : selectedTab === 'saved' ? (
                    savedCandidates.length > 0 ? renderCandidateList(savedCandidates, 'attention-inbox-saved') : <EmptyInbox label="Nothing saved for later" />
                ) : turnCount > 0 ? (
                    <div className="space-y-3">
                        {turnInsights.length > 0 ? renderInsightList(turnInsights, 'attention-inbox-turn') : null}
                        {turnCandidates.length > 0 ? renderCandidateList(turnCandidates, 'attention-inbox-turn') : null}
                    </div>
                ) : (
                    <EmptyInbox label="No attention from this turn" />
                )}
            </div>
        </aside>
    );
}

export default InsightPanel;
