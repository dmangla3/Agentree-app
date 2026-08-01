import type { AgentRunEvent } from './agentRun.types';

export type NormalizedAgentAdapterEvent = Record<string, any> & {
  raw: Record<string, any>;
};

export const normalizeAgentAdapterEvent = (event: Record<string, any>): NormalizedAgentAdapterEvent => {
  const rawType = typeof event.type === 'string' ? event.type : 'unknown';
  const type = rawType === 'stop' ? 'provider_stop' : rawType;
  const normalized: NormalizedAgentAdapterEvent = {
    ...event,
    type,
    raw: event,
  };

  if (rawType === 'stop' || rawType === 'provider_stop') {
    normalized.provider_status = event.provider_status ?? event.status ?? null;
    normalized.provider_stop_reason = event.provider_stop_reason ?? event.stop_reason ?? null;
    delete normalized.status;
    return normalized;
  }

  if (type !== 'exit' && Object.prototype.hasOwnProperty.call(normalized, 'status')) {
    normalized.payload_status = normalized.status;
    delete normalized.status;
  }

  return normalized;
};

export const normalizeAgentAdapterEventForRun = (event: Record<string, any>): AgentRunEvent => ({
  type: 'native_event',
  event: normalizeAgentAdapterEvent(event),
});
