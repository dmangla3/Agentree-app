import { isActiveFlowRunStatus } from './flowRun.machine';
import { flowRunManager } from './flowRunManager';
import type { FlowRunSnapshot } from './flowRun.types';

type FlowRunTaggedNode = {
  id?: string | null;
  execution_data?: Record<string, any> | null;
} | null | undefined;

export interface ActiveFlowCancelTarget {
  flowRunId: string;
  flowId: string;
  activeNodeIds: string[];
  snapshot: FlowRunSnapshot;
}

export function readNodeFlowRunId(node: FlowRunTaggedNode): string | null {
  const executionData = node?.execution_data ?? null;
  const direct = cleanString(executionData?.flow_run_id);
  if (direct) return direct;
  const meta = executionData?.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  return cleanString((meta as Record<string, unknown>).flow_run_id);
}

export function resolveActiveFlowCancelTarget(input: {
  nodeId?: string | null;
  node?: FlowRunTaggedNode;
  projection?: FlowRunTaggedNode;
}): ActiveFlowCancelTarget | null {
  const nodeId = input.nodeId ?? input.projection?.id ?? input.node?.id ?? null;
  const snapshotByNode = nodeId ? flowRunManager.snapshotForNode(nodeId) : null;
  const snapshot = snapshotByNode ?? resolveSnapshotByTaggedNode(input.projection) ?? resolveSnapshotByTaggedNode(input.node);
  if (!snapshot || !isActiveFlowRunStatus(snapshot.status)) return null;
  if (nodeId && !snapshot.launchedNodeIds.includes(nodeId) && !snapshot.activeNodeIds.includes(nodeId)) return null;
  return {
    flowRunId: snapshot.flowRunId,
    flowId: snapshot.flowId,
    activeNodeIds: snapshot.activeNodeIds,
    snapshot,
  };
}

function resolveSnapshotByTaggedNode(node: FlowRunTaggedNode): FlowRunSnapshot | null {
  const flowRunId = readNodeFlowRunId(node);
  return flowRunId ? flowRunManager.snapshot(flowRunId) : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
