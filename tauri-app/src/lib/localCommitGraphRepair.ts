import type { QueryClient } from '@tanstack/react-query';
import { agentClient } from './agentClient';
import { scheduleLocalCommitGraphRefreshWhenGraphIdle } from './graphInteractionGate';
import { getElapsedSinceAppStartMs, recordPerfEvent } from './perfRecorder';

/**
 * Background reconciliation for the local commit graph.
 *
 * `repairLocalCommitGraph` backfills the parent closure of commits whose
 * ancestors are referenced but missing locally (e.g. external commits). It used
 * to run inline inside the `['local-commit-graph']` query function, which meant
 * the graph could not render until a potentially multi-second git/DB pass
 * finished. We now read cached data immediately and run repair here in the
 * background.
 *
 * The native command returns the number of commits it imported, so we only
 * trigger a re-read when something actually changed — avoiding redundant React
 * work for the (common) no-op case. Calls are single-flighted per
 * workspace+repo so overlapping triggers coalesce instead of stacking git work.
 */

type RepairKey = string;

const keyFor = (workspaceId: string, repoPath: string): RepairKey => `${workspaceId}::${repoPath}`;

const inflight = new Map<RepairKey, Promise<void>>();
const rerunRequested = new Set<RepairKey>();

export const ensureLocalCommitGraphRepaired = (
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  repoPath: string | null | undefined,
  options: { reason?: string; gitRef?: string | null } = {},
): void => {
  if (!workspaceId || !repoPath || !agentClient.hasRuntime()) return;

  const key = keyFor(workspaceId, repoPath);
  if (inflight.has(key)) {
    // A repair is already running; remember that inputs may have changed so we
    // run exactly one more pass once it settles.
    rerunRequested.add(key);
    return;
  }

  const startedAt = performance.now();
  const run = agentClient
    .repairLocalCommitGraph(workspaceId, repoPath, options.gitRef ?? null)
    .then((repairedCount) => {
      recordPerfEvent('query.local-commit-graph.repair.background', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        reason: options.reason ?? null,
        repairedCount,
      }, {
        source: 'localCommitGraphRepair',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });

      // Only re-read (and re-render) when repair actually imported commits.
      if (repairedCount > 0) {
        void scheduleLocalCommitGraphRefreshWhenGraphIdle(queryClient, workspaceId, {
          reason: options.reason ? `repair:${options.reason}` : 'repair',
        });
      }
    })
    .catch((error) => {
      recordPerfEvent('query.local-commit-graph.repair.background-failed', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        reason: options.reason ?? null,
        error: error instanceof Error ? error.message : String(error),
      }, {
        source: 'localCommitGraphRepair',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
    })
    .finally(() => {
      inflight.delete(key);
      if (rerunRequested.delete(key)) {
        ensureLocalCommitGraphRepaired(queryClient, workspaceId, repoPath, options);
      }
    });

  inflight.set(key, run);
};

export const resetLocalCommitGraphRepairForTest = (): void => {
  inflight.clear();
  rerunRequested.clear();
};
