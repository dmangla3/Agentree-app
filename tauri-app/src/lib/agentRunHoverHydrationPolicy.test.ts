import { describe, expect, it } from 'vitest';
import { resolveAgentRunHoverStatus, shouldHydrateAgentRunHover } from './agentRunHoverHydrationPolicy';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: 'persisted content',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  status: 'completed',
  createdAt: '2026-05-29T00:00:00.000Z',
  updatedAt: '2026-05-29T00:00:01.000Z',
  ...overrides,
});

const entity = (overrides: Partial<ProjectedNodeEntity> = {}): ProjectedNodeEntity => ({
  entityId: 'entity:assistant-1',
  kind: 'assistant_message',
  messageId: 'assistant-1',
  focusMessageId: 'assistant-1',
  message: message(),
  preview: 'persisted content',
  shortLabel: 'Assistant',
  status: 'completed',
  ...overrides,
} as ProjectedNodeEntity);

describe('shouldHydrateAgentRunHover', () => {
  it('resolves live run status before projected and persisted status', () => {
    const completedEntity = entity();

    expect(resolveAgentRunHoverStatus(completedEntity, 'running')).toBe('running');
    expect(shouldHydrateAgentRunHover(completedEntity, 'running')).toBe(true);
  });

  it('does not hydrate when live status is terminal even if projected status is stale active', () => {
    const runningEntity = entity({
      status: 'running',
      message: message({ status: 'running' }),
    });

    expect(resolveAgentRunHoverStatus(runningEntity, 'completed')).toBe('completed');
    expect(shouldHydrateAgentRunHover(runningEntity, 'completed')).toBe(false);
  });

  it('hydrates active assistant nodes', () => {
    expect(shouldHydrateAgentRunHover(entity({
      status: 'running',
      message: message({ status: 'running' }),
    }))).toBe(true);
  });

  it('does not hydrate persisted completed assistant nodes', () => {
    expect(shouldHydrateAgentRunHover(entity())).toBe(false);
  });

  it('does not hydrate inert persisted assistant nodes without a live status', () => {
    expect(shouldHydrateAgentRunHover(entity({
      status: null,
      message: message({ status: null }),
    }))).toBe(false);
  });

  it('hydrates projected assistant nodes when no persisted message is available', () => {
    expect(shouldHydrateAgentRunHover(entity({
      message: undefined,
    }))).toBe(true);
  });

  it('does not hydrate user or commit hover entities', () => {
    expect(shouldHydrateAgentRunHover(entity({
      kind: 'user_message',
      message: message({ role: 'user', status: null }),
      status: null,
    }))).toBe(false);
    expect(shouldHydrateAgentRunHover(entity({
      kind: 'commit_message',
      status: 'completed',
    }))).toBe(false);
  });
});
