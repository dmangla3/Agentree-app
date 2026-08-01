import type { AgentRunEvent, AgentRunSnapshot } from './agentRun.types';

const DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_AGENT_RUN_DEBUG || '').toLowerCase());

const eventName = (event: AgentRunEvent) => event.type;

export const logAgentRunTransition = (
  previous: AgentRunSnapshot,
  next: AgentRunSnapshot,
  event: AgentRunEvent,
  effects: string[],
) => {
  if (!DEBUG_ENABLED) return;
  if (
    previous.status === next.status &&
    previous.phase === next.phase &&
    previous.lastSeq === next.lastSeq &&
    previous.content.length === next.content.length &&
    previous.timeline.length === next.timeline.length
  ) {
    return;
  }
  console.log('[AgentRunActor]', {
    nodeId: next.nodeId,
    runId: next.runId,
    seq: next.lastSeq,
    event: eventName(event),
    from: { status: previous.status, phase: previous.phase },
    to: { status: next.status, phase: next.phase },
    effects,
  });
};
