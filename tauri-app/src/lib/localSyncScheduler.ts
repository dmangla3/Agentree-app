import { agentClient } from './agentClient';
import { getAccessToken } from './authSession';
import { recordPerfEvent } from './perfRecorder';
import { useAuthStore } from '../stores/authStore';

const DEFAULT_LOCAL_SYNC_LIMIT = 25;
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

const isCloudSyncAvailable = () => {
  const { user, desktopSession } = useAuthStore.getState();
  return Boolean(user && desktopSession);
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
      if (!isCloudSyncAvailable()) {
        recordPerfEvent('local-sync.flush.skipped', {
          reason: reasons.join('+') || null,
          limit,
          skipReason: 'cloud_not_connected',
        }, { source: 'localSyncScheduler' });
        return;
      }
      const token = await getAccessToken();
      const cloudAccountId = useAuthStore.getState().user?.id;
      if (!cloudAccountId) {
        recordPerfEvent('local-sync.flush.skipped', {
          reason: reasons.join('+') || null,
          limit,
          skipReason: 'cloud_account_missing',
        }, { source: 'localSyncScheduler' });
        return;
      }
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
      if (queued.reasons.size > 0) {
        queueLocalSyncFlush({ reason: 'pending-after-in-flight', limit: queued.limit });
      }
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

export const flushQueuedLocalSyncForTest = async () => {
  await runQueuedLocalSync();
};

export const resetLocalSyncSchedulerForTest = () => {
  if (queued.timer) {
    clearTimeout(queued.timer);
  }
  queued.timer = null;
  queued.inFlight = null;
  queued.reasons.clear();
  queued.limit = DEFAULT_LOCAL_SYNC_LIMIT;
};
