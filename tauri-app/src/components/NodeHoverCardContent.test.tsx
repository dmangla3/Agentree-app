// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeHoverCardContent } from './NodeHoverCardContent';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import type { Message } from '../stores/workspaceStore';
import { QUICK_REPLY_KEEP_HOVER_OPEN_EVENT } from '../lib/quickReply';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quickReplyMocks = vi.hoisted(() => ({
  sendQuickReply: vi.fn(),
}));

vi.mock('./NodePreviewRenderer', () => ({
  NodePreviewRenderer: ({ entity }: { entity?: ProjectedNodeEntity }) => (
    <div>hover body: {entity?.preview}</div>
  ),
}));

vi.mock('../hooks/useHeadlessQuickReply', () => ({
  useHeadlessQuickReply: () => ({
    sendQuickReply: quickReplyMocks.sendQuickReply,
    isSending: false,
    error: null,
  }),
}));

const makeMessage = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? `${input.id} content`,
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  createdAt: input.createdAt ?? '2026-05-16T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-16T00:00:00.000Z',
});

const makeProjection = (messages: Message[] = []): WorkspaceProjection => ({
  messages,
  summaries: [],
  messageMap: new Map(messages.map((message) => [message.id, message])),
  summaryMap: new Map(),
  entities: [],
  entitiesById: new Map(),
  entitiesByMessageId: new Map(),
  entitiesBySummaryId: new Map(),
  childEntityIdsByParentEntityId: new Map(),
  commitEntityIdsByAssistantEntityId: new Map(),
  commitBySha: new Map(),
  commitLaneRows: [],
  layoutDerivedCommitGroups: [],
  groupIdByCommitSha: new Map(),
  threadRootIds: [],
  threadRootIdByMessageId: new Map(),
  rootMessageIdByThreadRootId: new Map(),
  turnGroups: [],
  turnGroupById: new Map(),
  originMessage: null,
  originMessageId: null,
  branchPathMessageIds: new Set(),
  focusRoute: { baseNodeId: null, messageIds: [], edges: [] },
  timelineItems: [],
  chatItems: [],
});

const makeEntity = (kind: ProjectedNodeEntity['kind']): ProjectedNodeEntity => ({
  entityId: `${kind}:entity-1`,
  kind,
  messageId: 'message-1',
  focusMessageId: 'message-1',
  turnGroupId: 'turn-1',
  sortTs: 1,
  preview: `${kind} preview`,
  shortLabel: 'label',
  status: null,
  message: makeMessage({ id: 'message-1', content: `${kind} preview` }),
});

describe('NodeHoverCardContent', () => {
  beforeEach(() => {
    quickReplyMocks.sendQuickReply.mockReset();
    quickReplyMocks.sendQuickReply.mockResolvedValue({});
  });

  it('does not show Reply for commit hover cards', () => {
    render(<NodeHoverCardContent entity={makeEntity('commit_message')} projection={makeProjection()} />);

    expect(screen.getByText('hover body: commit_message preview')).toBeTruthy();
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('keeps Reply for non-commit hover cards', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    expect(screen.getByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.getByText('Quick Reply')).toBeTruthy();
  });

  it('uses app theme surfaces for the hovercard shell', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const shell = document.querySelector('[data-agentree-node-hover-card="true"]') as HTMLElement;

    expect(shell.className).toContain('bg-[hsl(var(--app-panel)/0.96)]');
    expect(shell.className).toContain('border-[hsl(var(--app-border)/0.76)]');
    expect(shell.className).not.toContain('rgba(255,255,255');
    expect(shell.className).not.toContain('linear-gradient(180deg,rgba');
  });

  it('uses the app action color when ready to send', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const input = screen.getByLabelText('Quick reply prompt');
    const button = screen.getByRole('button', { name: 'Quick Reply' });

    expect(button.className).not.toContain('bg-[hsl(var(--app-accent))]');

    fireEvent.change(input, { target: { value: 'Looks good' } });

    expect(button.className).toContain('bg-[hsl(var(--app-accent))]');
    expect(button.className).toContain('border-[hsl(var(--app-accent)/0.48)]');
    expect(button.className).toContain('text-white');
    expect(button.className).not.toContain('bg-foreground');
    expect(button.className).not.toContain('dark:bg-[hsl(var(--app-bg-muted))]');
    expect(button.className).not.toContain('dark:bg-white');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not bubble quick reply input events into graph node focus handlers', () => {
    const onClick = vi.fn();
    const onMouseDown = vi.fn();
    const onPointerDown = vi.fn();
    const onFocus = vi.fn();

    render(
      <div
        onClick={onClick}
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
        onFocus={onFocus}
      >
        <NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />
      </div>
    );

    const input = screen.getByLabelText('Quick reply prompt');
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.click(input);

    expect(onClick).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('hides quick reply for running hover cards', () => {
    render(
      <NodeHoverCardContent
        entity={{ ...makeEntity('assistant_message'), status: 'running' as any }}
        projection={makeProjection()}
      />
    );

    expect(screen.getByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.queryByText('Quick Reply')).toBeNull();
    expect(screen.queryByLabelText('Quick reply prompt')).toBeNull();
  });

  it('directly sends a quick reply without opening the floating composer', async () => {
    const user = userEvent.setup();
    const keepOpenListener = vi.fn();
    window.addEventListener(QUICK_REPLY_KEEP_HOVER_OPEN_EVENT, keepOpenListener);
    const messages = [
      makeMessage({ id: 'ancestor', output_commit_sha: 'ancestor-output-sha' }),
      makeMessage({ id: 'message-1', role: 'user', parentId: 'ancestor', base_commit_sha: 'stale-parent-base' }),
    ];
    render(<NodeHoverCardContent entity={makeEntity('user_message')} projection={makeProjection(messages)} />);

    const input = screen.getByLabelText('Quick reply prompt') as HTMLInputElement;
    await user.type(input, 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Quick Reply' }));

    expect(quickReplyMocks.sendQuickReply).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      replyParentId: 'message-1',
      prompt: 'Ship it',
      messages,
    });
    expect(keepOpenListener).toHaveBeenCalledWith(expect.objectContaining({
      detail: { messageId: 'message-1' },
    }));
    await waitFor(() => {
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(input);
    });
    window.removeEventListener(QUICK_REPLY_KEEP_HOVER_OPEN_EVENT, keepOpenListener);
  });

  it('uses the neutral node preview renderer instead of importing chat rendering directly', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/NodeHoverCardContent.tsx'), 'utf8');

    expect(source).toContain("import { NodePreviewRenderer } from './NodePreviewRenderer';");
    expect(source).not.toContain("import { ChatNodeDispatcher } from './nodes/chat/ChatNodeDispatcher';");
  });
});
