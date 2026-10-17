// @vitest-environment jsdom
import '../../../test/setup';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspaceProjection } from '../../../domain/workspaceProjection';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import type { Message } from '../../../stores/workspaceStore';
import type { HoverQuickReplyCreatedEvent } from '../../HoverQuickReplyActions';
import { GraphHoverProjectionContext } from '../../graph/GraphHoverProjectionContext';
import {
  getChronologicalHoverAgentMessageIds,
  GraphNodeHoverCardContent,
} from './GraphNodeHoverCardContent';

const quickReplyEventState = vi.hoisted(() => ({
  event: {
    parentMessageId: 'message-1',
    userMessageId: 'new-user',
    assistantMessageId: 'new-assistant',
  } as HoverQuickReplyCreatedEvent,
}));

vi.mock('../../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({
    entity,
    headerAccessory,
    onQuickReplyCreated,
  }: {
    entity?: ProjectedNodeEntity;
    headerAccessory?: ReactNode;
    onQuickReplyCreated?: (event: HoverQuickReplyCreatedEvent) => void;
  }) => (
    <div>
      {headerAccessory}
      <div data-testid="hovered-message">{entity?.messageId ?? 'no-message'}</div>
      <input aria-label="Mock quick reply input" />
      <button type="button" onClick={() => onQuickReplyCreated?.(quickReplyEventState.event)}>
        Emit quick reply
      </button>
    </div>
  ),
}));

const makeMessage = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? `${input.id} content`,
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  createdAt: input.createdAt ?? '2026-07-20T00:00:00.000Z',
  updatedAt: input.updatedAt ?? input.createdAt ?? '2026-07-20T00:00:00.000Z',
  depth: input.depth ?? null,
  path_ids: input.path_ids ?? null,
});

const getProjection = (messages: Message[]): WorkspaceProjection => (
  buildWorkspaceProjection({
    messages,
    summaries: [],
    focusedMessageId: null,
  })
);

const getEntity = (messages: Message[], messageId: string): ProjectedNodeEntity => {
  const projection = getProjection(messages);
  const entity = projection.entitiesByMessageId.get(messageId);
  if (!entity) throw new Error(`Missing projected entity for ${messageId}`);
  return entity;
};

function Harness({
  messages,
  initialMessageId,
}: {
  messages: Message[];
  initialMessageId: string;
}) {
  return (
    <GraphHoverProjectionContext.Provider
      value={{ messages, summaries: [], disabledSummaryIds: new Set() }}
    >
      <GraphNodeHoverCardContent entity={getEntity(messages, initialMessageId)} />
    </GraphHoverProjectionContext.Provider>
  );
}

describe('GraphNodeHoverCardContent chronological navigation', () => {
  beforeEach(() => {
    quickReplyEventState.event = {
      parentMessageId: 'message-1',
      userMessageId: 'new-user',
      assistantMessageId: 'new-assistant',
    };
  });

  it('orders only agent messages by creation time with stable depth and id tie-breakers', () => {
    const messages = [
      makeMessage({ id: 'later', createdAt: '2026-07-20T00:00:02.000Z' }),
      makeMessage({ id: 'child-b', depth: 2 }),
      makeMessage({ id: 'parent', depth: 1 }),
      makeMessage({ id: 'child-a', depth: 2 }),
      makeMessage({ id: 'user-message', role: 'user', createdAt: '2026-07-19T00:00:00.000Z' }),
    ];
    const projection = getProjection(messages);

    expect(getChronologicalHoverAgentMessageIds(
      messages,
      projection.entitiesByMessageId,
    )).toEqual(['parent', 'child-a', 'child-b', 'later']);
  });

  it('keeps same-timestamp parents before children when persisted depth is absent', () => {
    const messages = [
      makeMessage({ id: 'a-child', parentId: 'z-parent' }),
      makeMessage({ id: 'z-parent' }),
    ];
    const projection = getProjection(messages);

    expect(getChronologicalHoverAgentMessageIds(
      messages,
      projection.entitiesByMessageId,
    )).toEqual(['z-parent', 'a-child']);
  });

  it('moves through agent messages chronologically while skipping user messages', () => {
    const messages = [
      makeMessage({ id: 'first', createdAt: '2026-07-20T00:00:01.000Z' }),
      makeMessage({ id: 'user-before-second', role: 'user', createdAt: '2026-07-20T00:00:01.500Z' }),
      makeMessage({ id: 'second', createdAt: '2026-07-20T00:00:02.000Z' }),
      makeMessage({ id: 'user-before-third', role: 'user', createdAt: '2026-07-20T00:00:02.500Z' }),
      makeMessage({ id: 'third', createdAt: '2026-07-20T00:00:03.000Z' }),
    ];
    render(<Harness messages={messages} initialMessageId="second" />);

    expect(screen.getByTestId('hovered-message').textContent).toBe('second');
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(document.querySelector('[data-agentree-hover-navigation-chrome="true"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show older agent message' }));
    expect(screen.getByTestId('hovered-message').textContent).toBe('first');
    expect(screen.getByText('1 / 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show newer agent message' }));
    expect(screen.getByTestId('hovered-message').textContent).toBe('second');
  });

  it('keeps a directly hovered user card visible without adding it to the agent carousel', () => {
    const messages = [
      makeMessage({ id: 'user-message', role: 'user', createdAt: '2026-07-20T00:00:01.000Z' }),
      makeMessage({ id: 'agent-message', createdAt: '2026-07-20T00:00:02.000Z' }),
    ];
    render(<Harness messages={messages} initialMessageId="user-message" />);

    expect(screen.getByTestId('hovered-message').textContent).toBe('user-message');
    expect(screen.queryByRole('button', { name: 'Show older agent message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show newer agent message' })).toBeNull();
  });

  it('accents the next arrow when a quick reply becomes chronologically adjacent', () => {
    const initialMessages = [
      makeMessage({ id: 'message-1', createdAt: '2026-07-20T00:00:01.000Z' }),
    ];
    const { rerender } = render(<Harness messages={initialMessages} initialMessageId="message-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Emit quick reply' }));

    const messagesWithReply = [
      ...initialMessages,
      makeMessage({
        id: 'new-user',
        role: 'user',
        parentId: 'message-1',
        createdAt: '2026-07-20T00:00:02.000Z',
        path_ids: ['message-1', 'new-user'],
      }),
      makeMessage({
        id: 'new-assistant',
        parentId: 'new-user',
        createdAt: '2026-07-20T00:00:02.000Z',
        path_ids: ['message-1', 'new-user', 'new-assistant'],
      }),
    ];
    rerender(<Harness messages={messagesWithReply} initialMessageId="message-1" />);

    const nextButton = screen.getByRole('button', { name: 'Show newer agent message' });
    expect(nextButton.getAttribute('data-navigation-attention')).toBe('true');
    expect(screen.queryByRole('button', { name: 'View new reply' })).toBeNull();

    fireEvent.click(nextButton);
    expect(screen.getByTestId('hovered-message').textContent).toBe('new-assistant');
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });

  it('offers a direct reply jump when chronology contains intervening messages', () => {
    const initialMessages = [
      makeMessage({ id: 'message-1', createdAt: '2026-07-20T00:00:01.000Z' }),
      makeMessage({ id: 'other-agent', createdAt: '2026-07-20T00:00:02.000Z' }),
    ];
    const { rerender } = render(<Harness messages={initialMessages} initialMessageId="message-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Emit quick reply' }));
    rerender(
      <Harness
        initialMessageId="message-1"
        messages={[
          ...initialMessages,
          makeMessage({
            id: 'new-user',
            role: 'user',
            parentId: 'message-1',
            createdAt: '2026-07-20T00:00:03.000Z',
            path_ids: ['message-1', 'new-user'],
          }),
          makeMessage({
            id: 'new-assistant',
            parentId: 'new-user',
            createdAt: '2026-07-20T00:00:04.000Z',
            path_ids: ['message-1', 'new-user', 'new-assistant'],
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View new reply' }));

    expect(screen.getByTestId('hovered-message').textContent).toBe('new-assistant');
    expect(screen.getByText('3 / 3')).toBeTruthy();
  });

  it('does not use arrow-key navigation while editing a quick reply', () => {
    const messages = [
      makeMessage({ id: 'first', createdAt: '2026-07-20T00:00:01.000Z' }),
      makeMessage({ id: 'user-between', role: 'user', createdAt: '2026-07-20T00:00:01.500Z' }),
      makeMessage({ id: 'second', createdAt: '2026-07-20T00:00:02.000Z' }),
    ];
    render(<Harness messages={messages} initialMessageId="first" />);

    fireEvent.keyDown(screen.getByLabelText('Mock quick reply input'), { key: 'ArrowRight' });
    expect(screen.getByTestId('hovered-message').textContent).toBe('first');

    const navigationRoot = document.querySelector('[data-agentree-graph-hover-navigation="chronological"]');
    fireEvent.keyDown(navigationRoot!, { key: 'ArrowRight' });
    expect(screen.getByTestId('hovered-message').textContent).toBe('second');
  });
});
