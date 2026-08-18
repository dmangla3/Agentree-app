import { describe, expect, it } from 'vitest';
import { buildWorkspaceProjection } from '../domain/workspaceProjection';
import type { CommitEntity, Message, Summary } from '../stores/workspaceStore';
import {
  buildExecutionTimelineItems,
  getExecutionTimelineRelations,
  getLatestTimelineWindow,
  packExecutionTimelineItems,
  parseTimelineMs,
} from './executionTimelineModel';

const workspaceId = 'workspace-execution-timeline';
const baseMs = Date.parse('2026-05-26T10:00:00.000Z');

const isoAt = (seconds: number) => new Date(baseMs + seconds * 1000).toISOString();

const makeMessage = (
  input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>,
  seconds: number,
): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? `${input.role} ${input.id}`,
  parentId: input.parentId,
  workspaceId,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  aiLabel: input.aiLabel ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  createdAt: input.createdAt ?? isoAt(seconds),
  updatedAt: input.updatedAt ?? isoAt(seconds),
});

const buildProjection = (
  messages: Message[],
  summaries: Summary[] = [],
  commits: CommitEntity[] = [],
) => buildWorkspaceProjection({
  messages,
  summaries,
  commits,
  focusedMessageId: messages[messages.length - 1]?.id ?? null,
});

describe('execution timeline model', () => {
  it('parses valid timeline timestamps and rejects invalid values', () => {
    expect(parseTimelineMs(baseMs)).toBe(baseMs);
    expect(parseTimelineMs(isoAt(3))).toBe(baseMs + 3000);
    expect(parseTimelineMs('')).toBeNull();
    expect(parseTimelineMs('not-a-date')).toBeNull();
    expect(parseTimelineMs(Number.NaN)).toBeNull();
  });

  it('extracts user markers, agent bars, and output commit markers while skipping summaries', () => {
    const user = makeMessage({ id: 'user-1', role: 'user', parentId: null, content: 'Build the timeline' }, 0);
    const assistant = makeMessage({
      id: 'assistant-1',
      role: 'assistant',
      parentId: 'user-1',
      content: 'Implemented timeline',
      aiLabel: 'Timeline popover',
      status: 'completed',
      agent_id: 'agent-1',
      output_commit_sha: 'commit111111111111',
      execution_data: {
        started_at: isoAt(2),
        ended_at: isoAt(12),
      },
    }, 1);
    const summary: Summary = {
      id: 'summary-1',
      workspaceId,
      startMessageId: user.id,
      endMessageId: assistant.id,
      content: 'A summary that should not become a dock item',
      createdAt: isoAt(20),
    };
    const commit: CommitEntity = {
      sha: 'commit111111111111',
      subject: 'Add timeline popover',
      authored_at: isoAt(13),
      source_kind: 'agent',
      produced_by_node_id: assistant.id,
    };

    const items = buildExecutionTimelineItems(buildProjection([user, assistant], [summary], [commit]), baseMs + 30_000);

    expect(items.map((item) => item.kind)).toEqual(['user_message', 'agent_run', 'commit']);
    expect(items.find((item) => item.kind === 'agent_run')).toMatchObject({
      id: 'agent:assistant-1',
      messageId: 'assistant-1',
      label: 'Timeline popover',
      startMs: baseMs + 2000,
      endMs: baseMs + 12_000,
      realEndMs: baseMs + 12_000,
      isActive: false,
    });
    expect(items.find((item) => item.kind === 'commit')).toMatchObject({
      id: 'commit:assistant-1:commit111111111111',
      messageId: 'assistant-1',
      commitSha: 'commit111111111111',
      timeMs: baseMs + 13_000,
    });
    expect(items.some((item) => item.entityId === 'summary:summary-1')).toBe(false);
  });

  it('renders active agent bars to now and marks real end as null', () => {
    const user = makeMessage({ id: 'user-1', role: 'user', parentId: null }, 0);
    const assistant = makeMessage({
      id: 'assistant-1',
      role: 'assistant',
      parentId: 'user-1',
      status: 'running',
      agent_id: 'agent-1',
      execution_data: { started_at: isoAt(5) },
    }, 5);

    const items = buildExecutionTimelineItems(buildProjection([user, assistant]), baseMs + 60_000);
    const bar = items.find((item) => item.kind === 'agent_run');

    expect(bar).toMatchObject({
      startMs: baseMs + 5000,
      endMs: baseMs + 60_000,
      realEndMs: null,
      isActive: true,
    });
  });

  it('packs overlapping bars into different lanes and reuses lanes for non-overlapping bars', () => {
    const model = packExecutionTimelineItems([
      {
        id: 'agent:a',
        kind: 'agent_run',
        entityId: 'assistant_message:a',
        messageId: 'a',
        parentMessageId: null,
        label: 'A',
        status: 'completed',
        startMs: 0,
        endMs: 10,
        realEndMs: 10,
        isActive: false,
      },
      {
        id: 'agent:b',
        kind: 'agent_run',
        entityId: 'assistant_message:b',
        messageId: 'b',
        parentMessageId: null,
        label: 'B',
        status: 'completed',
        startMs: 5,
        endMs: 15,
        realEndMs: 15,
        isActive: false,
      },
      {
        id: 'agent:c',
        kind: 'agent_run',
        entityId: 'assistant_message:c',
        messageId: 'c',
        parentMessageId: null,
        label: 'C',
        status: 'completed',
        startMs: 16,
        endMs: 20,
        realEndMs: 20,
        isActive: false,
      },
    ]);

    expect(model.laneCount).toBe(2);
    expect(model.bars.map((bar) => [bar.messageId, bar.lane])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
  });

  it('assigns user and commit markers to related lanes without increasing lane count', () => {
    const model = packExecutionTimelineItems([
      {
        id: 'agent:parent',
        kind: 'agent_run',
        entityId: 'assistant_message:parent',
        messageId: 'parent',
        parentMessageId: null,
        label: 'Parent',
        status: 'completed',
        startMs: 0,
        endMs: 10,
        realEndMs: 10,
        isActive: false,
      },
      {
        id: 'user:child',
        kind: 'user_message',
        entityId: 'user_message:child',
        messageId: 'child',
        parentMessageId: 'parent',
        label: 'Child prompt',
        timeMs: 11,
      },
      {
        id: 'commit:parent:abc',
        kind: 'commit',
        entityId: 'assistant_message:parent',
        messageId: 'parent',
        parentMessageId: null,
        label: 'Commit',
        timeMs: 12,
        commitSha: 'abc',
      },
    ]);

    expect(model.laneCount).toBe(1);
    expect(model.markers.map((marker) => [marker.messageId, marker.lane])).toEqual([
      ['child', 0],
      ['parent', 0],
    ]);
  });

  it('calculates latest viewport at the model end', () => {
    const window = getLatestTimelineWindow({
      bars: [],
      markers: [],
      laneCount: 1,
      minMs: 0,
      maxMs: 60 * 60 * 1000,
    });

    expect(window.endMs).toBe(60 * 60 * 1000);
    expect(window.startMs).toBe(48 * 60 * 1000);
  });

  it('returns direct parent and child relations for hovered timeline items', () => {
    const items = [
      {
        id: 'agent:parent',
        kind: 'agent_run' as const,
        entityId: 'assistant_message:parent',
        messageId: 'parent',
        parentMessageId: null,
        label: 'Parent',
        status: 'completed',
        startMs: 0,
        endMs: 10,
        realEndMs: 10,
        isActive: false,
      },
      {
        id: 'user:child',
        kind: 'user_message' as const,
        entityId: 'user_message:child',
        messageId: 'child',
        parentMessageId: 'parent',
        label: 'Child',
        timeMs: 11,
      },
    ];

    expect(getExecutionTimelineRelations(items, 'child').incoming.map((item) => item.messageId)).toEqual(['parent']);
    expect(getExecutionTimelineRelations(items, 'parent').outgoing.map((item) => item.messageId)).toEqual(['child']);
  });
});
