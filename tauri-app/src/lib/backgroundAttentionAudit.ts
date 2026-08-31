export type BackgroundAttentionAuditOutcome = 'baseline' | 'queued' | 'ran' | 'skipped' | 'failed';

export interface BackgroundAttentionAuditEvent {
  id: string;
  workspaceId: string;
  createdAt: string;
  outcome: BackgroundAttentionAuditOutcome;
  reason: string;
  triggerClass?: string | null;
  parentNodeId?: string | null;
  runNodeId?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const BACKGROUND_ATTENTION_AUDIT_UPDATED = 'agentree:background-attention-audit-updated';

const storageKey = (workspaceId: string) => `agentree.backgroundAttention.audit.v1.${workspaceId}`;
const MAX_EVENTS = 300;

const randomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const readBackgroundAttentionAuditEvents = (
  workspaceId: string | null | undefined,
  limit = MAX_EVENTS,
): BackgroundAttentionAuditEvent[] => {
  if (!workspaceId || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event): event is BackgroundAttentionAuditEvent => (
        event
        && typeof event.id === 'string'
        && typeof event.workspaceId === 'string'
        && typeof event.createdAt === 'string'
        && typeof event.outcome === 'string'
        && typeof event.reason === 'string'
      ))
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
};

export const appendBackgroundAttentionAuditEvent = (
  event: Omit<BackgroundAttentionAuditEvent, 'id' | 'createdAt'> & Partial<Pick<BackgroundAttentionAuditEvent, 'id' | 'createdAt'>>,
) => {
  if (!event.workspaceId || typeof window === 'undefined') return;
  try {
    const existing = readBackgroundAttentionAuditEvents(event.workspaceId, MAX_EVENTS).reverse();
    const next: BackgroundAttentionAuditEvent = {
      id: event.id ?? randomId(),
      createdAt: event.createdAt ?? new Date().toISOString(),
      workspaceId: event.workspaceId,
      outcome: event.outcome,
      reason: event.reason,
      triggerClass: event.triggerClass ?? null,
      parentNodeId: event.parentNodeId ?? null,
      runNodeId: event.runNodeId ?? null,
      message: event.message ?? null,
      metadata: event.metadata ?? null,
    };
    window.localStorage.setItem(storageKey(event.workspaceId), JSON.stringify([...existing, next].slice(-MAX_EVENTS)));
    window.dispatchEvent(new CustomEvent(BACKGROUND_ATTENTION_AUDIT_UPDATED, {
      detail: { workspaceId: event.workspaceId },
    }));
  } catch {
    // Audit telemetry must never block the trigger path.
  }
};

export const subscribeBackgroundAttentionAuditEvents = (
  workspaceId: string | null | undefined,
  listener: () => void,
): (() => void) => {
  if (!workspaceId || typeof window === 'undefined') return () => undefined;
  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
    if (detail?.workspaceId === workspaceId) listener();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey(workspaceId)) listener();
  };
  window.addEventListener(BACKGROUND_ATTENTION_AUDIT_UPDATED, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(BACKGROUND_ATTENTION_AUDIT_UPDATED, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
};
