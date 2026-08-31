import { describe, expect, it } from 'vitest';
import type { CommitEntity, Message } from '../stores/workspaceStore';
import type { BackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import type { LocalInsightCandidateRecord } from '../lib/agentClient';
import { buildTrackingDashboardMetrics } from './trackingDashboardMetrics';

const workspaceId = 'workspace-1';
const now = new Date('2026-05-23T12:00:00.000Z');

const message = (input: Partial<Message> & Pick<Message, 'id' | 'createdAt'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt ?? input.createdAt,
  promptTokens: input.promptTokens ?? null,
  completionTokens: input.completionTokens ?? null,
  totalTokens: input.totalTokens ?? null,
  aiLabel: input.aiLabel ?? null,
  status: input.status ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  execution_data: input.execution_data ?? null,
});

const commit = (input: Partial<CommitEntity> & Pick<CommitEntity, 'sha'>): CommitEntity => ({
  sha: input.sha,
  workspace_id: workspaceId,
  source_kind: Object.prototype.hasOwnProperty.call(input, 'source_kind') ? input.source_kind : 'agent',
  produced_by_node_id: input.produced_by_node_id ?? null,
  committed_at: input.committed_at ?? null,
  authored_at: input.authored_at ?? null,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt,
  files_changed_count: input.files_changed_count ?? null,
  total_additions: input.total_additions ?? null,
  total_deletions: input.total_deletions ?? null,
  subject: input.subject ?? null,
});

const backgroundCandidate = (
  input: Partial<LocalInsightCandidateRecord> & Pick<LocalInsightCandidateRecord, 'candidateId' | 'createdAt'>,
): LocalInsightCandidateRecord => ({
  candidateId: input.candidateId,
  workspaceId,
  parentNodeId: input.parentNodeId ?? 'assistant-parent',
  agentKind: input.agentKind ?? 'hypothesis',
  claim: input.claim ?? 'Candidate claim',
  rationale: input.rationale ?? null,
  status: input.status ?? 'validated',
  noveltyScore: input.noveltyScore ?? null,
  relevanceScore: input.relevanceScore ?? null,
  actionabilityScore: input.actionabilityScore ?? null,
  riskScore: input.riskScore ?? null,
  timingScore: input.timingScore ?? null,
  confidence: input.confidence ?? null,
  priority: input.priority ?? null,
  surfaceReason: input.surfaceReason ?? null,
  surfacedInsightId: input.surfacedInsightId ?? null,
  sourceRunNodeId: input.sourceRunNodeId ?? null,
  explorationJson: input.explorationJson ?? null,
  payload: input.payload ?? '{}',
  createdAt: input.createdAt,
  updatedAt: input.updatedAt ?? input.createdAt,
});

const attentionAudit = (
  input: Partial<BackgroundAttentionAuditEvent> & Pick<BackgroundAttentionAuditEvent, 'id' | 'createdAt' | 'outcome' | 'reason'>,
): BackgroundAttentionAuditEvent => ({
  id: input.id,
  workspaceId,
  createdAt: input.createdAt,
  outcome: input.outcome,
  reason: input.reason,
  triggerClass: input.triggerClass ?? 'light',
  parentNodeId: input.parentNodeId ?? null,
  runNodeId: input.runNodeId ?? null,
  message: input.message ?? null,
  metadata: input.metadata ?? null,
});

describe('buildTrackingDashboardMetrics', () => {
  it('deduplicates commits and totals known LOC stats for the selected range', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      messages: [],
      commits: [
        commit({
          sha: 'aaa',
          source_kind: 'agent',
          committed_at: '2026-05-22T10:00:00.000Z',
          files_changed_count: 2,
          total_additions: 120,
          total_deletions: 35,
        }),
        commit({
          sha: 'aaa',
          source_kind: 'agent',
          committed_at: '2026-05-22T10:00:00.000Z',
          total_additions: 999,
          total_deletions: 999,
        }),
        commit({
          sha: 'bbb',
          source_kind: 'merge',
          committed_at: '2026-05-20T10:00:00.000Z',
          files_changed_count: 1,
          total_additions: 30,
          total_deletions: 5,
        }),
        commit({
          sha: 'old',
          committed_at: '2026-04-20T10:00:00.000Z',
          total_additions: 500,
          total_deletions: 100,
        }),
      ],
    });

    expect(metrics.totals.commits).toBe(2);
    expect(metrics.totals.agentCommits).toBe(1);
    expect(metrics.totals.mergeCommits).toBe(1);
    expect(metrics.totals.locAdded).toBe(150);
    expect(metrics.totals.locDeleted).toBe(40);
    expect(metrics.totals.netLoc).toBe(110);
    expect(metrics.totals.locKnownCommits).toBe(2);
  });

  it('excludes external commits from dashboard productivity metrics', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      messages: [
        message({
          id: 'assistant-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          output_commit_sha: 'agent-commit',
        }),
        message({
          id: 'assistant-2',
          createdAt: '2026-05-23T09:00:00.000Z',
          output_commit_sha: 'external-commit',
        }),
      ],
      commits: [
        commit({
          sha: 'agent-commit',
          source_kind: 'agent',
          produced_by_node_id: 'assistant-1',
          committed_at: '2026-05-23T08:10:00.000Z',
          files_changed_count: 2,
          total_additions: 30,
          total_deletions: 5,
        }),
        commit({
          sha: 'external-commit',
          source_kind: 'external',
          produced_by_node_id: 'assistant-2',
          committed_at: '2026-05-23T09:10:00.000Z',
          files_changed_count: 100,
          total_additions: 1000,
          total_deletions: 250,
        }),
      ],
    });

    const today = metrics.buckets[metrics.buckets.length - 1];
    const externalRun = metrics.recentRuns.find((run) => run.nodeId === 'assistant-2');

    expect(metrics.totals.commits).toBe(1);
    expect(metrics.totals.externalCommits).toBe(0);
    expect(metrics.totals.locAdded).toBe(30);
    expect(metrics.totals.locDeleted).toBe(5);
    expect(metrics.totals.netLoc).toBe(25);
    expect(metrics.totals.locKnownCommits).toBe(1);
    expect(today.commitCount).toBe(1);
    expect(today.locAdded).toBe(30);
    expect(today.locDeleted).toBe(5);
    expect(externalRun).toMatchObject({
      commitCount: 0,
      locAdded: 0,
      locDeleted: 0,
      netLoc: 0,
    });
  });

  it('excludes commits without a productivity source kind from calculations', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      messages: [
        message({
          id: 'assistant-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          output_commit_sha: 'unknown-commit',
        }),
      ],
      commits: [
        commit({
          sha: 'unknown-commit',
          source_kind: 'unknown',
          produced_by_node_id: 'assistant-1',
          committed_at: '2026-05-23T08:10:00.000Z',
          files_changed_count: 4,
          total_additions: 400,
          total_deletions: 100,
        }),
        commit({
          sha: 'missing-source-commit',
          source_kind: null,
          committed_at: '2026-05-23T09:10:00.000Z',
          files_changed_count: 2,
          total_additions: 200,
          total_deletions: 50,
        }),
      ],
    });

    const today = metrics.buckets[metrics.buckets.length - 1];
    const run = metrics.recentRuns.find((row) => row.nodeId === 'assistant-1');

    expect(metrics.totals.commits).toBe(0);
    expect(metrics.totals.externalCommits).toBe(0);
    expect(metrics.totals.locAdded).toBe(0);
    expect(metrics.totals.locDeleted).toBe(0);
    expect(metrics.totals.netLoc).toBe(0);
    expect(metrics.totals.locKnownCommits).toBe(0);
    expect(today.commitCount).toBe(0);
    expect(today.locAdded).toBe(0);
    expect(today.locDeleted).toBe(0);
    expect(run).toMatchObject({
      commitCount: 0,
      locAdded: 0,
      locDeleted: 0,
      netLoc: 0,
    });
  });

  it('extracts token usage from message columns and execution_data usage fallbacks', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      commits: [],
      messages: [
        message({
          id: 'assistant-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 160,
        }),
        message({
          id: 'assistant-2',
          createdAt: '2026-05-22T08:00:00.000Z',
          execution_data: {
            usage: {
              input_tokens: 40,
              output_tokens: 10,
            },
          },
        }),
        message({
          id: 'user-1',
          role: 'user',
          createdAt: '2026-05-22T08:00:00.000Z',
          totalTokens: 999,
        }),
      ],
    });

    expect(metrics.totals.promptTokens).toBe(140);
    expect(metrics.totals.completionTokens).toBe(60);
    expect(metrics.totals.totalTokens).toBe(210);
    expect(metrics.totals.tokenKnownRuns).toBe(2);
    expect(metrics.totals.tokenCoveragePercent).toBe(100);
  });

  it('builds daily buckets and recent run rows for the tracking charts', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      messages: [
        message({
          id: 'assistant-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          aiLabel: 'Implement tracking dashboard',
          status: 'completed',
          totalTokens: 220,
          output_commit_sha: 'aaa',
        }),
      ],
      commits: [
        commit({
          sha: 'aaa',
          produced_by_node_id: 'assistant-1',
          committed_at: '2026-05-23T08:10:00.000Z',
          total_additions: 55,
          total_deletions: 12,
        }),
      ],
    });

    const today = metrics.buckets[metrics.buckets.length - 1];
    expect(today).toMatchObject({
      label: 'May 23',
      commitCount: 1,
      locAdded: 55,
      locDeleted: 12,
      totalTokens: 220,
    });
    expect(metrics.recentRuns[0]).toMatchObject({
      nodeId: 'assistant-1',
      label: 'Implement tracking dashboard',
      status: 'completed',
      commitCount: 1,
      locAdded: 55,
      locDeleted: 12,
      totalTokens: 220,
    });
  });

  it('uses terminal execution status for recent run rows when message status is stale', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      commits: [],
      messages: [
        message({
          id: 'assistant-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          status: 'pending',
          execution_data: {
            last_terminal_status: 'completed',
          },
        }),
      ],
    });

    expect(metrics.recentRuns[0].status).toBe('completed');
  });

  it('deduplicates background attention token usage per run and counts audit outcomes', () => {
    const metrics = buildTrackingDashboardMetrics({
      now,
      range: '7d',
      commits: [],
      messages: [],
      backgroundAttentionCandidates: [
        backgroundCandidate({
          candidateId: 'candidate-1',
          createdAt: '2026-05-23T08:00:00.000Z',
          status: 'surfaced',
          surfacedInsightId: 'candidate-1',
          sourceRunNodeId: 'run-1',
          payload: JSON.stringify({
            sourceRunNodeId: 'run-1',
            promptTokens: 1800,
            completionTokens: 220,
            totalTokens: 2020,
          }),
        }),
        backgroundCandidate({
          candidateId: 'candidate-2',
          createdAt: '2026-05-23T08:01:00.000Z',
          status: 'validated',
          sourceRunNodeId: 'run-1',
          payload: JSON.stringify({
            sourceRunNodeId: 'run-1',
            promptTokens: 1800,
            completionTokens: 220,
            totalTokens: 2020,
          }),
        }),
        backgroundCandidate({
          candidateId: 'candidate-3',
          createdAt: '2026-05-22T08:00:00.000Z',
          status: 'archived',
          sourceRunNodeId: 'run-2',
          payload: JSON.stringify({
            sourceRunNodeId: 'run-2',
            promptTokens: 400,
            completionTokens: 80,
          }),
        }),
      ],
      backgroundAttentionAuditEvents: [
        attentionAudit({
          id: 'audit-1',
          createdAt: '2026-05-23T08:02:00.000Z',
          outcome: 'ran',
          reason: 'run_completed',
          runNodeId: 'run-1',
        }),
        attentionAudit({
          id: 'audit-2',
          createdAt: '2026-05-22T08:02:00.000Z',
          outcome: 'skipped',
          reason: 'already_processed',
        }),
      ],
    });

    const today = metrics.backgroundAttention.buckets[metrics.backgroundAttention.buckets.length - 1];

    expect(metrics.backgroundAttention.totals.runCount).toBe(2);
    expect(metrics.backgroundAttention.totals.candidateCount).toBe(3);
    expect(metrics.backgroundAttention.totals.surfacedCount).toBe(1);
    expect(metrics.backgroundAttention.totals.savedCount).toBe(1);
    expect(metrics.backgroundAttention.totals.archivedCount).toBe(1);
    expect(metrics.backgroundAttention.totals.promptTokens).toBe(2200);
    expect(metrics.backgroundAttention.totals.completionTokens).toBe(300);
    expect(metrics.backgroundAttention.totals.totalTokens).toBe(2500);
    expect(metrics.backgroundAttention.totals.ranTriggers).toBe(1);
    expect(metrics.backgroundAttention.totals.skippedTriggers).toBe(1);
    expect(today).toMatchObject({
      runCount: 1,
      candidateCount: 2,
      surfacedCount: 1,
      savedCount: 1,
      totalTokens: 2020,
      ranTriggers: 1,
    });
  });
});
