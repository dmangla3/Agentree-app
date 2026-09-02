import { isActiveAgentStatus } from '@shared/agentStatus';
import type { WorkspaceProjection } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import { getMessageOutputCommitSha } from './graph/commitAccessors';
import { resolveNodeState } from './runStateResolver';

export type ExecutionTimelineItem =
  | {
      id: string;
      kind: 'agent_run';
      entityId: string;
      messageId: string;
      parentMessageId: string | null;
      label: string;
      status: string | null;
      startMs: number;
      endMs: number;
      realEndMs: number | null;
      isActive: boolean;
    }
  | {
      id: string;
      kind: 'user_message';
      entityId: string;
      messageId: string;
      parentMessageId: string | null;
      label: string;
      timeMs: number;
    }
  | {
      id: string;
      kind: 'commit';
      entityId: string;
      messageId: string;
      parentMessageId: string | null;
      label: string;
      timeMs: number;
      commitSha: string | null;
    };

export type PackedExecutionBar = Extract<ExecutionTimelineItem, { kind: 'agent_run' }> & {
  lane: number;
};

export type PackedExecutionMarker = Exclude<ExecutionTimelineItem, { kind: 'agent_run' }> & {
  lane: number;
};

export type ExecutionTimelineModel = {
  bars: PackedExecutionBar[];
  markers: PackedExecutionMarker[];
  laneCount: number;
  minMs: number;
  maxMs: number;
};

const terminalFallbackTimeMs = (message: Message): number | null => (
  parseTimelineMs((message.execution_data as any)?.ended_at) ??
  parseTimelineMs(message.updatedAt) ??
  parseTimelineMs(message.createdAt)
);

const contentPreview = (message: Message): string => {
  const source = message.aiLabel?.trim() || message.content?.trim() || '';
  if (!source) return message.role === 'user' ? 'User message' : 'Assistant run';
  return source
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/\s+/g, ' ')
    .trim();
};

const getTimelineLabel = (
  entity: WorkspaceProjection['entities'][number],
  message: Message,
  override?: string | null,
): string => {
  const value = override?.trim() || entity.shortLabel?.trim() || entity.preview?.trim() || contentPreview(message);
  return value || (message.role === 'user' ? 'User message' : 'Assistant run');
};

const getCommitTimeMs = (
  projection: WorkspaceProjection,
  message: Message,
  commitSha: string | null,
  agentRealEndMs: number | null,
): number => {
  const projectedCommit = commitSha ? projection.commitBySha.get(commitSha) ?? null : null;
  return (
    parseTimelineMs(projectedCommit?.commit.authored_at) ??
    parseTimelineMs(projectedCommit?.commit.committed_at) ??
    parseTimelineMs((message.execution_data as any)?.meta?.git_authored_at) ??
    parseTimelineMs((message.execution_data as any)?.meta?.git_committed_at) ??
    agentRealEndMs ??
    parseTimelineMs(message.updatedAt) ??
    parseTimelineMs(message.createdAt) ??
    Date.now()
  );
};

const getCommitLabel = (
  projection: WorkspaceProjection,
  message: Message,
  commitSha: string | null,
): string => {
  const projectedCommit = commitSha ? projection.commitBySha.get(commitSha) ?? null : null;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, unknown>;
  const metaCommitMessage = typeof meta.commit_message === 'string' ? meta.commit_message : null;
  return (
    projectedCommit?.subject?.trim() ||
    metaCommitMessage?.trim() ||
    message.aiLabel?.trim() ||
    message.content?.trim() ||
    (commitSha ? `Commit ${commitSha.slice(0, 8)}` : 'Commit')
  ).replace(/\s+/g, ' ');
};

export function parseTimelineMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isTimelineActiveStatus(status: unknown): boolean {
  return isActiveAgentStatus(status);
}

export function buildExecutionTimelineItems(
  projection: WorkspaceProjection,
  nowMs = Date.now(),
): ExecutionTimelineItem[] {
  const items: ExecutionTimelineItem[] = [];

  for (const timelineItem of projection.listItems) {
    const entity = projection.entitiesById.get(timelineItem.entityId);
    if (!entity || entity.kind === 'summary_block' || !entity.messageId || !entity.message) continue;

    const message = entity.message;
    if (entity.kind === 'user_message') {
      const timeMs = parseTimelineMs(message.createdAt) ?? entity.sortTs;
      items.push({
        id: `user:${message.id}`,
        kind: 'user_message',
        entityId: entity.entityId,
        messageId: message.id,
        parentMessageId: message.parentId ?? null,
        label: getTimelineLabel(entity, message),
        timeMs,
      });
      continue;
    }

    if (entity.kind === 'commit_message') {
      const commitSha = getMessageOutputCommitSha(message);
      const timeMs = getCommitTimeMs(projection, message, commitSha, null);
      items.push({
        id: `commit:${message.id}:${commitSha ?? 'message'}`,
        kind: 'commit',
        entityId: entity.entityId,
        messageId: message.id,
        parentMessageId: message.parentId ?? null,
        label: getCommitLabel(projection, message, commitSha),
        timeMs,
        commitSha,
      });
      continue;
    }

    if (entity.kind !== 'assistant_message') continue;

    const status = resolveNodeState(message, null).status ?? entity.status ?? message.status ?? null;
    const startMs = parseTimelineMs((message.execution_data as any)?.started_at) ??
      parseTimelineMs(message.createdAt) ??
      entity.sortTs;
    const active = isTimelineActiveStatus(status);
    const resolvedRealEndMs = active ? null : terminalFallbackTimeMs(message);
    const endMs = Math.max(startMs + 1, resolvedRealEndMs ?? nowMs);

    items.push({
      id: `agent:${message.id}`,
      kind: 'agent_run',
      entityId: entity.entityId,
      messageId: message.id,
      parentMessageId: message.parentId ?? null,
      label: getTimelineLabel(entity, message, message.aiLabel),
      status: status ? String(status) : null,
      startMs,
      endMs,
      realEndMs: resolvedRealEndMs,
      isActive: active || resolvedRealEndMs === null,
    });

    const outputCommitSha = getMessageOutputCommitSha(message);
    if (outputCommitSha) {
      items.push({
        id: `commit:${message.id}:${outputCommitSha}`,
        kind: 'commit',
        entityId: entity.entityId,
        messageId: message.id,
        parentMessageId: message.parentId ?? null,
        label: getCommitLabel(projection, message, outputCommitSha),
        timeMs: getCommitTimeMs(projection, message, outputCommitSha, resolvedRealEndMs),
        commitSha: outputCommitSha,
      });
    }
  }

  return items.sort((left, right) => {
    const leftMs = left.kind === 'agent_run' ? left.startMs : left.timeMs;
    const rightMs = right.kind === 'agent_run' ? right.startMs : right.timeMs;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return left.id.localeCompare(right.id);
  });
}

export function packExecutionTimelineItems(items: ExecutionTimelineItem[]): ExecutionTimelineModel {
  const bars = items
    .filter((item): item is Extract<ExecutionTimelineItem, { kind: 'agent_run' }> => item.kind === 'agent_run')
    .map((item) => ({ ...item, lane: 0 }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));

  const laneEndMs: number[] = [];
  for (const bar of bars) {
    const lane = laneEndMs.findIndex((endMs) => endMs <= bar.startMs);
    bar.lane = lane === -1 ? laneEndMs.length : lane;
    laneEndMs[bar.lane] = Math.max(bar.endMs, bar.startMs + 1);
  }

  const laneByMessageId = new Map(bars.map((bar) => [bar.messageId, bar.lane]));
  const markers = items
    .filter((item): item is Exclude<ExecutionTimelineItem, { kind: 'agent_run' }> => item.kind !== 'agent_run')
    .map((item) => ({
      ...item,
      lane: laneByMessageId.get(item.messageId) ?? (item.parentMessageId ? laneByMessageId.get(item.parentMessageId) ?? 0 : 0),
    }))
    .sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));

  const times = [
    ...bars.flatMap((bar) => [bar.startMs, bar.endMs]),
    ...markers.map((marker) => marker.timeMs),
  ];
  const fallbackMinMs = Date.now();
  const minMs = times.length > 0 ? Math.min(...times) : fallbackMinMs;
  const maxMs = times.length > 0 ? Math.max(...times) : fallbackMinMs + 1;

  return {
    bars,
    markers,
    laneCount: Math.max(1, laneEndMs.length),
    minMs: Number.isFinite(minMs) ? minMs : fallbackMinMs,
    maxMs: Number.isFinite(maxMs) ? Math.max(maxMs, minMs + 1) : fallbackMinMs + 1,
  };
}

export function buildExecutionTimelineModel(
  projection: WorkspaceProjection,
  nowMs = Date.now(),
): ExecutionTimelineModel {
  return packExecutionTimelineItems(buildExecutionTimelineItems(projection, nowMs));
}

export function getLatestTimelineWindow(model: ExecutionTimelineModel): { startMs: number; endMs: number } {
  const total = Math.max(1, model.maxMs - model.minMs);
  const minWindow = 5 * 60 * 1000;
  const targetWindow = total <= minWindow ? total : Math.max(minWindow, Math.min(total, total * 0.2));
  return {
    startMs: Math.max(model.minMs, model.maxMs - targetWindow),
    endMs: model.maxMs,
  };
}

export function getExecutionTimelineRelations(items: ExecutionTimelineItem[], messageId: string) {
  const parent = items.find((item) => item.messageId === messageId)?.parentMessageId ?? null;
  const incoming = parent ? items.filter((item) => item.messageId === parent) : [];
  const outgoing = items.filter((item) => item.parentMessageId === messageId);
  return { incoming, outgoing };
}
