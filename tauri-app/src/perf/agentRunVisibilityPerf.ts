import { recordSendFlowMark } from './sendFlow';

type VisibilityTrace = {
  flowId: string | null;
  traceId: string | null;
  firstTextReceived: boolean;
  firstTextProjected: boolean;
  firstTextVisible: boolean;
};

type TraceDetails = {
  nodeId: string;
  flowId?: string | null;
  traceId?: string | null;
  transport?: string | null;
  nativeEventTimestampMs?: number | null;
  streamSeq?: number | null;
  contentLength?: number | null;
  status?: string | null;
};

const tracesByNodeId = new Map<string, VisibilityTrace>();

const getTrace = (nodeId: string, flowId?: string | null, traceId?: string | null) => {
  const existing = tracesByNodeId.get(nodeId);
  if (existing) {
    if (flowId) existing.flowId = flowId;
    if (traceId) existing.traceId = traceId;
    return existing;
  }
  const next: VisibilityTrace = {
    flowId: flowId ?? null,
    traceId: traceId ?? null,
    firstTextReceived: false,
    firstTextProjected: false,
    firstTextVisible: false,
  };
  tracesByNodeId.set(nodeId, next);
  return next;
};

const nativeToFrontendMs = (nativeEventTimestampMs?: number | null) => {
  if (typeof nativeEventTimestampMs !== 'number' || !Number.isFinite(nativeEventTimestampMs)) return null;
  return Math.max(0, Date.now() - nativeEventTimestampMs);
};

const recordVisibilityMark = (
  markName: string,
  trace: VisibilityTrace,
  details: TraceDetails,
) => {
  const flowId = details.flowId ?? trace.flowId;
  if (!flowId) return;
  recordSendFlowMark(flowId, markName, {
    nodeId: details.nodeId,
    traceId: details.traceId ?? trace.traceId,
    detail: {
      transport: details.transport ?? null,
      streamSeq: details.streamSeq ?? null,
      contentLength: details.contentLength ?? null,
      status: details.status ?? null,
      nativeToFrontendMs: nativeToFrontendMs(details.nativeEventTimestampMs),
    },
  }, { source: 'agent-run-visibility' });
};

export const registerAgentRunVisibilityTrace = (details: TraceDetails) => {
  getTrace(details.nodeId, details.flowId, details.traceId);
};

export const clearAgentRunVisibilityTrace = (nodeId: string | null | undefined) => {
  if (!nodeId) return;
  tracesByNodeId.delete(nodeId);
};

export const recordAssistantTextReceived = (details: TraceDetails) => {
  const trace = getTrace(details.nodeId, details.flowId, details.traceId);
  if (trace.firstTextReceived) return;
  trace.firstTextReceived = true;
  recordVisibilityMark('first_assistant_text_received', trace, details);
};

export const recordAssistantTextProjected = (details: TraceDetails) => {
  const trace = getTrace(details.nodeId, details.flowId, details.traceId);
  if (trace.firstTextProjected) return;
  trace.firstTextProjected = true;
  recordVisibilityMark('first_assistant_text_projected', trace, details);
};

export const recordAssistantTextVisible = (details: TraceDetails) => {
  const trace = getTrace(details.nodeId, details.flowId, details.traceId);
  if (trace.firstTextVisible) return;
  trace.firstTextVisible = true;
  recordVisibilityMark('first_visible_text_rendered', trace, details);
};
