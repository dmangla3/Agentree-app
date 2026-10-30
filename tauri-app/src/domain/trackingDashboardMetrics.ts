import { isTerminalAgentStatus } from '@shared/agentStatus';
import type { CommitEntity, Message } from '../stores/workspaceStore';
import type { BackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import type { LocalInsightCandidateRecord } from '../lib/agentClient';
import {
  priceModelUsage,
  unavailablePricingSnapshot,
  type PricingSnapshot,
  type UsageCostSource,
} from './modelPricing';

export type TrackingRange = '7d' | '30d' | 'all';

export interface TrackingBucket {
  key: string;
  label: string;
  commitCount: number;
  locAdded: number;
  locDeleted: number;
  netLoc: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  costUsd: number;
  cacheSavingsUsd: number;
}

export interface BackgroundAttentionBucket {
  key: string;
  label: string;
  runCount: number;
  candidateCount: number;
  surfacedCount: number;
  savedCount: number;
  archivedCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  queuedTriggers: number;
  ranTriggers: number;
  skippedTriggers: number;
  failedTriggers: number;
  baselineEvents: number;
}

export interface TrackingRunRow {
  nodeId: string;
  label: string;
  status: Message['status'] | null;
  createdAt: string;
  commitCount: number;
  locAdded: number;
  locDeleted: number;
  netLoc: number;
  totalTokens: number;
  provider: string | null;
  model: string | null;
  costUsd: number;
  costSource: UsageCostSource;
}

export interface TrackingModelUsageRow {
  key: string;
  provider: string | null;
  model: string;
  runCount: number;
  pricedRunCount: number;
  unpricedRunCount: number;
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  costShare: number;
}

export interface BackgroundAttentionTotals {
  runCount: number;
  candidateCount: number;
  surfacedCount: number;
  savedCount: number;
  archivedCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  auditEventCount: number;
  queuedTriggers: number;
  ranTriggers: number;
  skippedTriggers: number;
  failedTriggers: number;
  baselineEvents: number;
}

export interface BackgroundAttentionMetrics {
  totals: BackgroundAttentionTotals;
  buckets: BackgroundAttentionBucket[];
  recentAuditEvents: BackgroundAttentionAuditEvent[];
}

export interface TrackingTotals {
  commits: number;
  agentCommits: number;
  mergeCommits: number;
  manualCommits: number;
  externalCommits: number;
  locAdded: number;
  locDeleted: number;
  netLoc: number;
  locKnownCommits: number;
  locCoveragePercent: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokenEligibleRuns: number;
  tokenKnownRuns: number;
  tokenCoveragePercent: number;
  tokensPerCommit: number | null;
  tokensPerLocAdded: number | null;
  estimatedCostUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheSavingsUsd: number;
  costEligibleRuns: number;
  costKnownRuns: number;
  costCoveragePercent: number;
  unpricedTokens: number;
  providerReportedRuns: number;
  modelPricedRuns: number;
}

export interface TrackingPricingSummary {
  status: PricingSnapshot['status'];
  source: string;
  fetchedAt: string | null;
  knownModels: number;
}

export interface TrackingDashboardMetrics {
  range: TrackingRange;
  startedAt: string | null;
  endedAt: string;
  totals: TrackingTotals;
  buckets: TrackingBucket[];
  recentRuns: TrackingRunRow[];
  modelUsage: TrackingModelUsageRow[];
  pricing: TrackingPricingSummary;
  backgroundAttention: BackgroundAttentionMetrics;
}

interface BuildTrackingDashboardMetricsInput {
  now?: Date;
  range: TrackingRange;
  messages: Message[];
  commits: CommitEntity[];
  backgroundAttentionCandidates?: LocalInsightCandidateRecord[];
  backgroundAttentionAuditEvents?: BackgroundAttentionAuditEvent[];
  pricing?: PricingSnapshot;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasUsage: boolean;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  provider: string | null;
  model: string | null;
  providerReportedCostUsd: number | null;
  hasTokenBreakdown: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const safeDateMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const safeJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const commitDateMs = (commit: CommitEntity): number | null =>
  safeDateMs(commit.committed_at) ?? safeDateMs(commit.authored_at) ?? safeDateMs(commit.createdAt) ?? safeDateMs(commit.updatedAt);

const messageDateMs = (message: Message): number | null =>
  safeDateMs(message.createdAt) ?? safeDateMs(message.updatedAt);

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

const formatBucketLabel = (key: string): string => {
  const date = new Date(`${key}T00:00:00.000Z`);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const getRangeStart = (now: Date, range: TrackingRange): Date | null => {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : 30;
  const start = startOfUtcDay(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
};

const isWithinRange = (time: number | null, startedAt: Date | null, endedAt: Date): boolean => {
  if (time === null) return false;
  if (time > endedAt.getTime()) return false;
  return startedAt ? time >= startedAt.getTime() : true;
};

const commitHasKnownLoc = (commit: CommitEntity): boolean =>
  toFiniteNumber(commit.total_additions) !== null || toFiniteNumber(commit.total_deletions) !== null;

const isProductivityCommit = (commit: CommitEntity): boolean =>
  commit.source_kind === 'agent' || commit.source_kind === 'merge' || commit.source_kind === 'manual';

const extractUsageObject = (message: Message): Record<string, unknown> => {
  const executionData = message.execution_data;
  if (!executionData || typeof executionData !== 'object') return {};
  const usage = (executionData as { usage?: unknown }).usage;
  return usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
};

const cleanString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const extractAgentIdentity = (agentId: string | null | undefined): { provider: string | null; model: string | null } => {
  const raw = cleanString(agentId);
  if (!raw) return { provider: null, model: null };
  if (raw.startsWith('opencode:')) {
    const [encodedModel] = raw.slice('opencode:'.length).split(':');
    try {
      return { provider: 'opencode', model: cleanString(decodeURIComponent(encodedModel ?? '')) };
    } catch {
      return { provider: 'opencode', model: cleanString(encodedModel) };
    }
  }

  const [provider, model] = raw.split(':');
  return {
    provider: cleanString(provider),
    model: cleanString(model) ?? (raw.includes(':') ? null : raw),
  };
};

const extractExecutionMeta = (message: Message): Record<string, unknown> => {
  const executionData = message.execution_data;
  if (!executionData || typeof executionData !== 'object') return {};
  const meta = (executionData as { meta?: unknown }).meta;
  return meta && typeof meta === 'object' ? meta as Record<string, unknown> : {};
};

const extractTerminalStatus = (message: Message): Message['status'] | null => {
  const executionData = message.execution_data;
  if (!executionData || typeof executionData !== 'object') return null;
  const status = (executionData as Record<string, unknown>).last_terminal_status;
  if (typeof status !== 'string') return null;
  const normalized = status.trim();
  return isTerminalAgentStatus(normalized) ? normalized as Message['status'] : null;
};

const extractTokenUsage = (message: Message): TokenUsage => {
  const usage = extractUsageObject(message);
  const observedInputTokens =
    toFiniteNumber(message.promptTokens) ??
    toFiniteNumber(usage.input_tokens) ??
    toFiniteNumber(usage.prompt_tokens) ??
    toFiniteNumber(usage.promptTokens);
  const rawInputTokens = observedInputTokens ?? 0;
  const observedOutputTokens =
    toFiniteNumber(message.completionTokens) ??
    toFiniteNumber(usage.output_tokens) ??
    toFiniteNumber(usage.completion_tokens) ??
    toFiniteNumber(usage.completionTokens);
  const rawOutputTokens = observedOutputTokens ?? 0;
  const cachedInputTokens =
    toFiniteNumber(usage.cached_input_tokens) ??
    toFiniteNumber(usage.cache_read_input_tokens) ??
    toFiniteNumber(usage.cachedInputTokens) ??
    0;
  const cacheCreationInputTokens =
    toFiniteNumber(usage.cache_creation_input_tokens) ??
    toFiniteNumber(usage.cacheCreationInputTokens) ??
    0;
  const reasoningTokens =
    toFiniteNumber(usage.reasoning_tokens) ??
    toFiniteNumber(usage.reasoning_output_tokens) ??
    toFiniteNumber(usage.reasoningTokens) ??
    0;
  const meta = extractExecutionMeta(message);
  const agentIdentity = extractAgentIdentity(message.agent_id);
  const provider = cleanString(message.llmProvider)
    ?? cleanString(meta.provider)
    ?? cleanString(meta.provider_kind)
    ?? agentIdentity.provider;
  const model = cleanString(message.llmModel)
    ?? cleanString(meta.provider_model)
    ?? cleanString(meta.llmModel)
    ?? cleanString(meta.model)
    ?? agentIdentity.model;
  const claudeStyleInput = provider?.toLowerCase() === 'claude'
    || provider?.toLowerCase() === 'anthropic';
  const uncachedInputTokens = claudeStyleInput
    ? rawInputTokens
    : Math.max(0, rawInputTokens - cachedInputTokens - cacheCreationInputTokens);
  // OpenCode reports reasoning beside output. Codex reports reasoning as a
  // subset of output, so only the former needs to be folded into billable output.
  const outputTokens = rawOutputTokens + (usage.reasoning_tokens === undefined ? 0 : reasoningTokens);
  const promptTokens = uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens;
  const completionTokens = outputTokens;
  const directTotal =
    toFiniteNumber(message.totalTokens) ??
    toFiniteNumber(usage.total_tokens) ??
    toFiniteNumber(usage.totalTokens);
  const componentTotal = promptTokens + completionTokens;
  const hasUsage = directTotal !== null || componentTotal > 0;
  const totalTokens = directTotal === null ? componentTotal : Math.max(directTotal, componentTotal);
  const providerReportedCostUsd =
    toFiniteNumber(usage.cost_usd) ??
    toFiniteNumber(usage.costUsd) ??
    toFiniteNumber(meta.opencode_cost_usd) ??
    null;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    hasUsage,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningTokens,
    provider,
    model,
    providerReportedCostUsd,
    hasTokenBreakdown: observedInputTokens !== null
      || observedOutputTokens !== null
      || cachedInputTokens > 0
      || cacheCreationInputTokens > 0,
  };
};

const priceTokenUsage = (pricing: PricingSnapshot, usage: TokenUsage) => priceModelUsage(
  pricing.rates,
  usage.hasTokenBreakdown ? usage.model ?? '' : '',
  {
    uncachedInputTokens: usage.uncachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
  },
  usage.providerReportedCostUsd,
);

const createBucket = (key: string): TrackingBucket => ({
  key,
  label: formatBucketLabel(key),
  commitCount: 0,
  locAdded: 0,
  locDeleted: 0,
  netLoc: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  inputCostUsd: 0,
  outputCostUsd: 0,
  costUsd: 0,
  cacheSavingsUsd: 0,
});

const createBackgroundAttentionBucket = (key: string): BackgroundAttentionBucket => ({
  key,
  label: formatBucketLabel(key),
  runCount: 0,
  candidateCount: 0,
  surfacedCount: 0,
  savedCount: 0,
  archivedCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  queuedTriggers: 0,
  ranTriggers: 0,
  skippedTriggers: 0,
  failedTriggers: 0,
  baselineEvents: 0,
});

const candidateDateMs = (candidate: LocalInsightCandidateRecord): number | null =>
  safeDateMs(candidate.createdAt) ?? safeDateMs(candidate.updatedAt);

const auditEventDateMs = (event: BackgroundAttentionAuditEvent): number | null =>
  safeDateMs(event.createdAt);

const isCandidateSurfaced = (candidate: LocalInsightCandidateRecord): boolean => (
  candidate.status === 'surfaced'
  || candidate.status === 'promoted'
  || Boolean(candidate.surfacedInsightId)
);

const isCandidateArchived = (candidate: LocalInsightCandidateRecord): boolean => (
  candidate.status === 'archived'
  || candidate.status === 'dismissed'
);

const extractCandidateUsage = (candidate: LocalInsightCandidateRecord): TokenUsage & { sourceRunNodeId: string | null } => {
  const payload = safeJsonObject(candidate.payload);
  const promptTokens = toFiniteNumber(payload.promptTokens) ?? toFiniteNumber(payload.prompt_tokens) ?? 0;
  const completionTokens = toFiniteNumber(payload.completionTokens) ?? toFiniteNumber(payload.completion_tokens) ?? 0;
  const directTotal = toFiniteNumber(payload.totalTokens) ?? toFiniteNumber(payload.total_tokens);
  const totalTokens = directTotal ?? promptTokens + completionTokens;
  const hasUsage = directTotal !== null || promptTokens > 0 || completionTokens > 0;
  const payloadRunId = typeof payload.sourceRunNodeId === 'string' ? payload.sourceRunNodeId : null;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    hasUsage,
    sourceRunNodeId: candidate.sourceRunNodeId ?? payloadRunId,
  };
};

const buildBackgroundAttentionBuckets = (
  now: Date,
  startedAt: Date | null,
  candidates: LocalInsightCandidateRecord[],
  auditEvents: BackgroundAttentionAuditEvent[],
): BackgroundAttentionBucket[] => {
  const bucketMap = new Map<string, BackgroundAttentionBucket>();

  if (startedAt) {
    for (let time = startedAt.getTime(); time <= startOfUtcDay(now).getTime(); time += DAY_MS) {
      const key = dateKey(new Date(time));
      bucketMap.set(key, createBackgroundAttentionBucket(key));
    }
  }

  const getBucket = (time: number | null): BackgroundAttentionBucket | null => {
    if (time === null) return null;
    const key = dateKey(new Date(time));
    let bucket = bucketMap.get(key);
    if (!bucket) {
      bucket = createBackgroundAttentionBucket(key);
      bucketMap.set(key, bucket);
    }
    return bucket;
  };

  const runUsageByKey = new Map<string, {
    time: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    hasUsage: boolean;
  }>();

  for (const candidate of candidates) {
    const bucket = getBucket(candidateDateMs(candidate));
    if (!bucket) continue;
    bucket.candidateCount += 1;
    if (isCandidateSurfaced(candidate)) bucket.surfacedCount += 1;
    else if (isCandidateArchived(candidate)) bucket.archivedCount += 1;
    else bucket.savedCount += 1;

    const usage = extractCandidateUsage(candidate);
    const runKey = usage.sourceRunNodeId ?? candidate.candidateId;
    const existing = runUsageByKey.get(runKey);
    if (!existing || usage.totalTokens > existing.totalTokens) {
      runUsageByKey.set(runKey, {
        time: candidateDateMs(candidate),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        hasUsage: usage.hasUsage,
      });
    }
  }

  for (const runUsage of runUsageByKey.values()) {
    const bucket = getBucket(runUsage.time);
    if (!bucket) continue;
    bucket.runCount += 1;
    if (runUsage.hasUsage) {
      bucket.promptTokens += runUsage.promptTokens;
      bucket.completionTokens += runUsage.completionTokens;
      bucket.totalTokens += runUsage.totalTokens;
    }
  }

  for (const event of auditEvents) {
    const bucket = getBucket(auditEventDateMs(event));
    if (!bucket) continue;
    if (event.outcome === 'queued') bucket.queuedTriggers += 1;
    else if (event.outcome === 'ran') bucket.ranTriggers += 1;
    else if (event.outcome === 'skipped') bucket.skippedTriggers += 1;
    else if (event.outcome === 'failed') bucket.failedTriggers += 1;
    else if (event.outcome === 'baseline') bucket.baselineEvents += 1;
  }

  return Array.from(bucketMap.values()).sort((left, right) => left.key.localeCompare(right.key));
};

const buildBackgroundAttentionMetrics = (
  now: Date,
  startedAt: Date | null,
  endedAt: Date,
  candidates: LocalInsightCandidateRecord[],
  auditEvents: BackgroundAttentionAuditEvent[],
): BackgroundAttentionMetrics => {
  const rangeCandidates = candidates.filter((candidate) => (
    isWithinRange(candidateDateMs(candidate), startedAt, endedAt)
  ));
  const rangeAuditEvents = auditEvents.filter((event) => (
    isWithinRange(auditEventDateMs(event), startedAt, endedAt)
  ));
  const buckets = buildBackgroundAttentionBuckets(now, startedAt, rangeCandidates, rangeAuditEvents);
  const totals: BackgroundAttentionTotals = {
    runCount: 0,
    candidateCount: 0,
    surfacedCount: 0,
    savedCount: 0,
    archivedCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    auditEventCount: rangeAuditEvents.length,
    queuedTriggers: 0,
    ranTriggers: 0,
    skippedTriggers: 0,
    failedTriggers: 0,
    baselineEvents: 0,
  };

  for (const bucket of buckets) {
    totals.runCount += bucket.runCount;
    totals.candidateCount += bucket.candidateCount;
    totals.surfacedCount += bucket.surfacedCount;
    totals.savedCount += bucket.savedCount;
    totals.archivedCount += bucket.archivedCount;
    totals.promptTokens += bucket.promptTokens;
    totals.completionTokens += bucket.completionTokens;
    totals.totalTokens += bucket.totalTokens;
    totals.queuedTriggers += bucket.queuedTriggers;
    totals.ranTriggers += bucket.ranTriggers;
    totals.skippedTriggers += bucket.skippedTriggers;
    totals.failedTriggers += bucket.failedTriggers;
    totals.baselineEvents += bucket.baselineEvents;
  }

  return {
    totals,
    buckets,
    recentAuditEvents: [...rangeAuditEvents]
      .sort((left, right) => (auditEventDateMs(right) ?? 0) - (auditEventDateMs(left) ?? 0))
      .slice(0, 80),
  };
};

const buildBuckets = (
  now: Date,
  startedAt: Date | null,
  commits: CommitEntity[],
  messages: Message[],
  pricing: PricingSnapshot,
): TrackingBucket[] => {
  const bucketMap = new Map<string, TrackingBucket>();

  if (startedAt) {
    for (let time = startedAt.getTime(); time <= startOfUtcDay(now).getTime(); time += DAY_MS) {
      const key = dateKey(new Date(time));
      bucketMap.set(key, createBucket(key));
    }
  }

  const getBucket = (time: number | null): TrackingBucket | null => {
    if (time === null) return null;
    const key = dateKey(new Date(time));
    let bucket = bucketMap.get(key);
    if (!bucket) {
      bucket = createBucket(key);
      bucketMap.set(key, bucket);
    }
    return bucket;
  };

  for (const commit of commits) {
    const bucket = getBucket(commitDateMs(commit));
    if (!bucket) continue;
    const additions = toFiniteNumber(commit.total_additions) ?? 0;
    const deletions = toFiniteNumber(commit.total_deletions) ?? 0;
    bucket.commitCount += 1;
    bucket.locAdded += additions;
    bucket.locDeleted += deletions;
    bucket.netLoc += additions - deletions;
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const usage = extractTokenUsage(message);
    if (!usage.hasUsage) continue;
    const bucket = getBucket(messageDateMs(message));
    if (!bucket) continue;
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    bucket.totalTokens += usage.totalTokens;
    const priced = priceTokenUsage(pricing, usage);
    bucket.inputCostUsd += priced.inputCostUsd ?? 0;
    bucket.outputCostUsd += priced.outputCostUsd ?? 0;
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += priced.cacheSavingsUsd;
  }

  return Array.from(bucketMap.values()).sort((left, right) => left.key.localeCompare(right.key));
};

const previewLabel = (message: Message): string => {
  const preferred = message.aiLabel?.trim();
  if (preferred) return preferred;
  const content = message.content.replace(/\s+/g, ' ').trim();
  if (!content) return 'Assistant run';
  return content.length > 64 ? `${content.slice(0, 61)}...` : content;
};

export const buildTrackingDashboardMetrics = ({
  now = new Date(),
  range,
  messages,
  commits,
  backgroundAttentionCandidates = [],
  backgroundAttentionAuditEvents = [],
  pricing = unavailablePricingSnapshot(),
}: BuildTrackingDashboardMetricsInput): TrackingDashboardMetrics => {
  const startedAtDate = getRangeStart(now, range);
  const endedAtDate = now;
  const uniqueCommits = new Map<string, CommitEntity>();

  for (const commit of commits) {
    if (!commit.sha || uniqueCommits.has(commit.sha)) continue;
    if (!isProductivityCommit(commit)) continue;
    if (!isWithinRange(commitDateMs(commit), startedAtDate, endedAtDate)) continue;
    uniqueCommits.set(commit.sha, commit);
  }

  const rangeCommits = Array.from(uniqueCommits.values()).sort((left, right) => {
    return (commitDateMs(left) ?? 0) - (commitDateMs(right) ?? 0);
  });
  const rangeMessages = messages.filter((message) => isWithinRange(messageDateMs(message), startedAtDate, endedAtDate));
  const assistantMessages = rangeMessages
    .filter((message) => message.role === 'assistant')
    .sort((left, right) => (messageDateMs(right) ?? 0) - (messageDateMs(left) ?? 0));

  const totals: TrackingTotals = {
    commits: rangeCommits.length,
    agentCommits: 0,
    mergeCommits: 0,
    manualCommits: 0,
    externalCommits: 0,
    locAdded: 0,
    locDeleted: 0,
    netLoc: 0,
    locKnownCommits: 0,
    locCoveragePercent: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    tokenEligibleRuns: assistantMessages.length,
    tokenKnownRuns: 0,
    tokenCoveragePercent: 0,
    tokensPerCommit: null,
    tokensPerLocAdded: null,
    estimatedCostUsd: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheSavingsUsd: 0,
    costEligibleRuns: 0,
    costKnownRuns: 0,
    costCoveragePercent: 0,
    unpricedTokens: 0,
    providerReportedRuns: 0,
    modelPricedRuns: 0,
  };

  for (const commit of rangeCommits) {
    const sourceKind = commit.source_kind ?? 'external';
    if (sourceKind === 'agent') totals.agentCommits += 1;
    else if (sourceKind === 'merge') totals.mergeCommits += 1;
    else if (sourceKind === 'manual') totals.manualCommits += 1;
    else totals.externalCommits += 1;

    const additions = toFiniteNumber(commit.total_additions) ?? 0;
    const deletions = toFiniteNumber(commit.total_deletions) ?? 0;
    totals.locAdded += additions;
    totals.locDeleted += deletions;
    totals.netLoc += additions - deletions;
    if (commitHasKnownLoc(commit)) totals.locKnownCommits += 1;
  }

  for (const message of assistantMessages) {
    const usage = extractTokenUsage(message);
    if (!usage.hasUsage) continue;
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.totalTokens += usage.totalTokens;
    totals.uncachedInputTokens += usage.uncachedInputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningTokens += usage.reasoningTokens;
    totals.tokenKnownRuns += 1;
    totals.costEligibleRuns += 1;
    const priced = priceTokenUsage(pricing, usage);
    if (priced.costSource === 'unpriced') {
      totals.unpricedTokens += usage.totalTokens;
    } else {
      totals.costKnownRuns += 1;
      totals.estimatedCostUsd += priced.costUsd;
      totals.inputCostUsd += priced.inputCostUsd ?? 0;
      totals.outputCostUsd += priced.outputCostUsd ?? 0;
      totals.cacheSavingsUsd += priced.cacheSavingsUsd;
      if (priced.costSource === 'providerReported') totals.providerReportedRuns += 1;
      else totals.modelPricedRuns += 1;
    }
  }

  totals.locCoveragePercent = totals.commits > 0 ? Math.round((totals.locKnownCommits / totals.commits) * 100) : 0;
  totals.tokenCoveragePercent = totals.tokenEligibleRuns > 0 ? Math.round((totals.tokenKnownRuns / totals.tokenEligibleRuns) * 100) : 0;
  totals.costCoveragePercent = totals.costEligibleRuns > 0 ? Math.round((totals.costKnownRuns / totals.costEligibleRuns) * 100) : 0;
  totals.tokensPerCommit = totals.commits > 0 ? Math.round(totals.totalTokens / totals.commits) : null;
  totals.tokensPerLocAdded = totals.locAdded > 0 ? Math.round(totals.totalTokens / totals.locAdded) : null;

  const commitsByNode = new Map<string, CommitEntity[]>();
  const commitsBySha = new Map(rangeCommits.map((commit) => [commit.sha, commit]));
  for (const commit of rangeCommits) {
    const nodeId = commit.produced_by_node_id;
    if (!nodeId) continue;
    const nodeCommits = commitsByNode.get(nodeId) ?? [];
    nodeCommits.push(commit);
    commitsByNode.set(nodeId, nodeCommits);
  }

  const recentRuns = assistantMessages.slice(0, 12).map((message): TrackingRunRow => {
    const directCommits = commitsByNode.get(message.id) ?? [];
    const outputCommit = message.output_commit_sha ? commitsBySha.get(message.output_commit_sha) : undefined;
    const runCommits = new Map<string, CommitEntity>();
    for (const commit of directCommits) runCommits.set(commit.sha, commit);
    if (outputCommit) runCommits.set(outputCommit.sha, outputCommit);
    const usage = extractTokenUsage(message);
    let locAdded = 0;
    let locDeleted = 0;
    for (const commit of runCommits.values()) {
      locAdded += toFiniteNumber(commit.total_additions) ?? 0;
      locDeleted += toFiniteNumber(commit.total_deletions) ?? 0;
    }
    const priced = priceTokenUsage(pricing, usage);
    return {
      nodeId: message.id,
      label: previewLabel(message),
      status: extractTerminalStatus(message) ?? message.status ?? null,
      createdAt: message.createdAt,
      commitCount: runCommits.size,
      locAdded,
      locDeleted,
      netLoc: locAdded - locDeleted,
      totalTokens: usage.hasUsage ? usage.totalTokens : 0,
      provider: usage.provider,
      model: usage.model,
      costUsd: priced.costUsd,
      costSource: usage.hasUsage ? priced.costSource : 'unpriced',
    };
  });

  const modelUsageMap = new Map<string, TrackingModelUsageRow>();
  for (const message of assistantMessages) {
    const usage = extractTokenUsage(message);
    if (!usage.hasUsage) continue;
    const model = usage.model ?? 'Unknown model';
    const provider = usage.provider;
    const key = `${provider?.toLowerCase() ?? 'unknown'}:${model.toLowerCase()}`;
    const priced = priceTokenUsage(pricing, usage);
    const row = modelUsageMap.get(key) ?? {
      key,
      provider,
      model,
      runCount: 0,
      pricedRunCount: 0,
      unpricedRunCount: 0,
      totalTokens: 0,
      costUsd: 0,
      cacheSavingsUsd: 0,
      costShare: 0,
    };
    row.runCount += 1;
    row.totalTokens += usage.totalTokens;
    if (priced.costSource === 'unpriced') row.unpricedRunCount += 1;
    else {
      row.pricedRunCount += 1;
      row.costUsd += priced.costUsd;
      row.cacheSavingsUsd += priced.cacheSavingsUsd;
    }
    modelUsageMap.set(key, row);
  }

  const modelUsage = Array.from(modelUsageMap.values())
    .map((row) => ({
      ...row,
      costShare: totals.estimatedCostUsd > 0 ? row.costUsd / totals.estimatedCostUsd : 0,
    }))
    .sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens);

  return {
    range,
    startedAt: startedAtDate?.toISOString() ?? null,
    endedAt: endedAtDate.toISOString(),
    totals,
    buckets: buildBuckets(now, startedAtDate, rangeCommits, rangeMessages, pricing),
    recentRuns,
    modelUsage,
    pricing: {
      status: pricing.status,
      source: pricing.source,
      fetchedAt: pricing.fetchedAt,
      knownModels: pricing.knownModels,
    },
    backgroundAttention: buildBackgroundAttentionMetrics(
      now,
      startedAtDate,
      endedAtDate,
      backgroundAttentionCandidates,
      backgroundAttentionAuditEvents,
    ),
  };
};
