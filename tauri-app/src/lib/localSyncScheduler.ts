import { agentClient } from './agentClient';
import { getAccessToken } from './authSession';
import { recordPerfEvent } from './perfRecorder';
import { useAuthStore } from '../stores/authStore';

const DEFAULT_LOCAL_SYNC_LIMIT = 25;
const SHARE_SYNC_BATCH_LIMIT = 100;
const LOCAL_SYNC_DEBOUNCE_MS = 1_500;

type QueuedLocalSync = {
  reasons: Set<string>;
  limit: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
};

const queued: QueuedLocalSync = {
  reasons: new Set(),
  limit: DEFAULT_LOCAL_SYNC_LIMIT,
  timer: null,
  inFlight: null,
};

const getCloudSyncContext = async () => {
  const { user, desktopSession } = useAuthStore.getState();
  if (!user || !desktopSession) {
    throw new Error('Sign in to Agentree before enabling workspace sync.');
  }
  return {
    token: await getAccessToken(),
    cloudAccountId: user.id,
  };
};

const schedulePendingFlush = () => {
  if (queued.reasons.size > 0 && !queued.timer && !queued.inFlight) {
    queueLocalSyncFlush({ reason: 'pending-after-in-flight', limit: queued.limit });
  }
};

const runQueuedLocalSync = async () => {
  if (queued.inFlight) return queued.inFlight;
  if (queued.timer) {
    clearTimeout(queued.timer);
    queued.timer = null;
  }

  const reasons = Array.from(queued.reasons);
  const limit = Math.max(DEFAULT_LOCAL_SYNC_LIMIT, queued.limit);
  queued.reasons.clear();
  queued.limit = DEFAULT_LOCAL_SYNC_LIMIT;

  queued.inFlight = (async () => {
    try {
      const { token, cloudAccountId } = await getCloudSyncContext();
      const synced = await agentClient.processLocalSyncEvents(token, cloudAccountId, limit);
      recordPerfEvent('local-sync.flush.completed', {
        reason: reasons.join('+') || null,
        limit,
        synced,
      }, { source: 'localSyncScheduler' });
    } catch (error) {
      recordPerfEvent('local-sync.flush.failed', {
        reason: reasons.join('+') || null,
        limit,
        error: error instanceof Error ? error.message : String(error),
      }, { source: 'localSyncScheduler' });
    } finally {
      queued.inFlight = null;
      schedulePendingFlush();
    }
  })();

  return queued.inFlight;
};

export const queueLocalSyncFlush = (options: { reason: string; limit?: number }) => {
  queued.reasons.add(options.reason);
  queued.limit = Math.max(queued.limit, options.limit ?? DEFAULT_LOCAL_SYNC_LIMIT);
  if (queued.timer || queued.inFlight) return;

  queued.timer = setTimeout(() => {
    void runQueuedLocalSync();
  }, LOCAL_SYNC_DEBOUNCE_MS);

  recordPerfEvent('local-sync.flush.queued', {
    reason: options.reason,
    limit: queued.limit,
  }, { source: 'localSyncScheduler' });
};

/**
 * Flushes only the opted-in workspace before a public link is created. The
 * native query also checks the workspace's cloud account, so this cannot make
 * a local-only workspace deliver events by accident.
 */
export const flushWorkspaceCloudSync = async (workspaceId: string): Promise<number> => {
  if (queued.inFlight) await queued.inFlight;
  if (queued.timer) {
    clearTimeout(queued.timer);
    queued.timer = null;
  }

  let totalSynced = 0;
  queued.inFlight = (async () => {
    try {
      const { token, cloudAccountId } = await getCloudSyncContext();
      for (;;) {
        const synced = await agentClient.processLocalSyncEvents(
          token,
          cloudAccountId,
          SHARE_SYNC_BATCH_LIMIT,
          workspaceId,
          false,
        );
        totalSynced += synced;
        if (synced < SHARE_SYNC_BATCH_LIMIT) break;
      }
      recordPerfEvent('local-sync.workspace-flush.completed', {
        workspaceId,
        synced: totalSynced,
      }, { source: 'localSyncScheduler' });
    } finally {
      queued.inFlight = null;
      schedulePendingFlush();
    }
  })();
  await queued.inFlight;
  return totalSynced;
};

/** Uploads only the durable initial snapshot required before the first share. */
export const flushWorkspaceCloudBootstrap = async (workspaceId: string): Promise<number> => {
  if (queued.inFlight) await queued.inFlight;
  if (queued.timer) {
    clearTimeout(queued.timer);
    queued.timer = null;
  }

  let synced = 0;
  queued.inFlight = (async () => {
    try {
      const { token, cloudAccountId } = await getCloudSyncContext();
      synced = await agentClient.processLocalSyncEvents(
        token,
        cloudAccountId,
        1,
        workspaceId,
        true,
      );
      recordPerfEvent('local-sync.workspace-bootstrap.completed', {
        workspaceId,
        synced,
      }, { source: 'localSyncScheduler' });
    } finally {
      queued.inFlight = null;
      schedulePendingFlush();
    }
  })();
  await queued.inFlight;
  return synced;
};

export const flushQueuedLocalSyncForTest = async () => {
  await runQueuedLocalSync();
};

export const resetLocalSyncSchedulerForTest = () => {
  if (queued.timer) clearTimeout(queued.timer);
  queued.timer = null;
  queued.inFlight = null;
  queued.reasons.clear();
  queued.limit = DEFAULT_LOCAL_SYNC_LIMIT;
};
