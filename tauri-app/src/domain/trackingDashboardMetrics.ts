import { isTerminalAgentStatus } from '@shared/agentStatus';
import type { CommitEntity, Message } from '../stores/workspaceStore';
import type { BackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import type { LocalInsightCandidateRecord } from '../lib/agentClient';

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
  tokenEligibleRuns: number;
  tokenKnownRuns: number;
  tokenCoveragePercent: number;
  tokensPerCommit: number | null;
  tokensPerLocAdded: number | null;
}

export interface TrackingDashboardMetrics {
  range: TrackingRange;
  startedAt: string | null;
  endedAt: string;
  totals: TrackingTotals;
  buckets: TrackingBucket[];
  recentRuns: TrackingRunRow[];
  backgroundAttention: BackgroundAttentionMetrics;
}

interface BuildTrackingDashboardMetricsInput {
  now?: Date;
  range: TrackingRange;
  messages: Message[];
  commits: CommitEntity[];
  backgroundAttentionCandidates?: LocalInsightCandidateRecord[];
  backgroundAttentionAuditEvents?: BackgroundAttentionAuditEvent[];
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasUsage: boolean;
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
  const promptTokens =
    toFiniteNumber(message.promptTokens) ??
    toFiniteNumber(usage.input_tokens) ??
    toFiniteNumber(usage.prompt_tokens) ??
    toFiniteNumber(usage.promptTokens) ??
    0;
  const completionTokens =
    toFiniteNumber(message.completionTokens) ??
    toFiniteNumber(usage.output_tokens) ??
    toFiniteNumber(usage.completion_tokens) ??
    toFiniteNumber(usage.completionTokens) ??
    0;
  const directTotal =
    toFiniteNumber(message.totalTokens) ??
    toFiniteNumber(usage.total_tokens) ??
    toFiniteNumber(usage.totalTokens);
  const hasUsage = directTotal !== null || promptTokens > 0 || completionTokens > 0;
  const totalTokens = directTotal ?? promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    hasUsage,
  };
};

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

const buildBuckets = (now: Date, startedAt: Date | null, commits: CommitEntity[], messages: Message[]): TrackingBucket[] => {
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
    tokenEligibleRuns: assistantMessages.length,
    tokenKnownRuns: 0,
    tokenCoveragePercent: 0,
    tokensPerCommit: null,
    tokensPerLocAdded: null,
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
    totals.tokenKnownRuns += 1;
  }

  totals.locCoveragePercent = totals.commits > 0 ? Math.round((totals.locKnownCommits / totals.commits) * 100) : 0;
  totals.tokenCoveragePercent = totals.tokenEligibleRuns > 0 ? Math.round((totals.tokenKnownRuns / totals.tokenEligibleRuns) * 100) : 0;
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
    };
  });

  return {
    range,
    startedAt: startedAtDate?.toISOString() ?? null,
    endedAt: endedAtDate.toISOString(),
    totals,
    buckets: buildBuckets(now, startedAtDate, rangeCommits, rangeMessages),
    recentRuns,
    backgroundAttention: buildBackgroundAttentionMetrics(
      now,
      startedAtDate,
      endedAtDate,
      backgroundAttentionCandidates,
      backgroundAttentionAuditEvents,
    ),
  };
};
