// @vitest-environment jsdom
import '../../../test/setup';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphAssistantNode } from './GraphAssistantNode';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import { useRunStatusStore } from '../../../stores/runStatusStore';

vi.mock('./GraphNodeWrapper', () => ({
  GraphNodeWrapper: ({
    children,
    hoverHydrationEnabled,
    onFocus,
  }: {
    children: ReactNode;
    hoverHydrationEnabled?: boolean;
    onFocus?: () => void;
  }) => (
    <div
      data-hover-hydration-enabled={String(Boolean(hoverHydrationEnabled))}
      onClick={onFocus}
    >
      {children}
    </div>
  ),
}));

const makeAssistantEntity = (overrides: Partial<ProjectedNodeEntity> = {}): ProjectedNodeEntity => {
  const { message: messageOverrides, ...entityOverrides } = overrides;
  return {
    entityId: 'message:assistant-1',
    kind: 'assistant_message',
    messageId: 'assistant-1',
    focusMessageId: 'assistant-1',
    turnGroupId: 'turn-1',
    sortTs: 1,
    preview: 'Implemented the fix.',
    shortLabel: 'Generated AI topic label',
    status: null,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Implemented the fix.',
      parentId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
      agent_id: null,
      llmModel: 'openai/gpt-5.5',
      llmProvider: 'openai',
      aiLabel: 'Generated AI topic label',
      tags: [],
      execution_data: {
        meta: {
          provider_reasoning_effort: 'high',
        },
      },
      ...(messageOverrides ?? {}),
    },
    ...entityOverrides,
  };
};

describe('GraphAssistantNode identity', () => {
  afterEach(() => {
    useRunStatusStore.getState().clearAllRunStatus();
  });

  it('uses the model identity as the assistant node header without a secondary AI label', () => {
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity()}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Implemented the fix.')).toBeTruthy();
    expect(screen.queryByText('Generated AI topic label')).toBeNull();
    expect(screen.queryByText('Assistant')).toBeNull();
  });

  it('shows the Codex icon for Codex assistant nodes', () => {
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity({
          message: {
            llmProvider: 'codex',
            llmModel: 'gpt-5.5-high',
          },
        } as any)}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByLabelText('Codex icon')).toBeTruthy();
  });

  it('shows the Claude icon for Claude assistant nodes', () => {
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity({
          message: {
            llmProvider: 'claude',
            llmModel: 'claude-sonnet-4-6',
          },
        } as any)}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByLabelText('Claude icon')).toBeTruthy();
  });

  it('keeps the generic assistant icon for unknown providers', () => {
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity()}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByLabelText('Assistant icon')).toBeTruthy();
  });

  it('includes the persisted failure reason in the status tooltip', () => {
    const reason = "ImportError: cannot import name 'ParamSpec' from 'typing'";
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity({
          status: 'failed',
          message: {
            execution_data: {
              failure_reason: reason,
            },
          },
        } as any)}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByTitle(`Agent Failed: ${reason}`)).toBeTruthy();
  });

  it('enables hover hydration from live run status when persisted status is completed', () => {
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
    });

    const { container } = render(
      <GraphAssistantNode
        nodeId="assistant-1"
        entity={makeAssistantEntity({
          status: 'completed',
          message: {
            status: 'completed',
          },
        } as any)}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(container.firstElementChild?.getAttribute('data-hover-hydration-enabled')).toBe('true');
  });

  it('shows a polished hover-progress cue while the assistant is running', () => {
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity({
          preview: 'Assistant message',
          status: 'running',
          message: {
            status: 'running',
          },
        } as any)}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('Assistant is working.')).toBeTruthy();
    expect(screen.getByText('Please hover to check progress.')).toBeTruthy();
    expect(screen.queryByText('Assistant message')).toBeNull();
  });

  it('opens each visible attached thread without focusing the owning assistant', () => {
    const onFocus = vi.fn();
    const onOpenThread = vi.fn();
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity()}
        attachedThreads={[
          {
            linkMessageId: 'link-1',
            threadRootId: 'thread-1',
            title: 'Check layout',
            status: null,
            statusNodeId: null,
          },
          {
            linkMessageId: 'link-2',
            threadRootId: 'thread-2',
            title: 'Review filtering',
            status: 'completed',
            statusNodeId: 'thread-2-assistant',
          },
        ]}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={onFocus}
        onOpenThread={onOpenThread}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open attached thread: Check layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open attached thread: Check layout' }));

    expect(onOpenThread).toHaveBeenCalledWith('thread-1');
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('shows three attached thread buttons and opens remaining threads from +N overflow', () => {
    const onOpenThread = vi.fn();
    const attachedThreads = Array.from({ length: 5 }, (_, index) => ({
      linkMessageId: `link-${index + 1}`,
      threadRootId: `thread-${index + 1}`,
      title: `Thread ${index + 1}`,
      status: null,
      statusNodeId: null,
    }));
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity()}
        attachedThreads={attachedThreads}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onOpenThread={onOpenThread}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getAllByRole('button', { name: /Open attached thread:/ })).toHaveLength(3);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Show 2 more attached threads' }));
    fireEvent.click(screen.getByText('Thread 5'));

    expect(onOpenThread).toHaveBeenCalledWith('thread-5');
  });

  it('shows live status for an attached thread when its assistant is running', () => {
    useRunStatusStore.getState().setRunStatus('thread-assistant', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
    });
    render(
      <GraphAssistantNode
        entity={makeAssistantEntity()}
        attachedThreads={[{
          linkMessageId: 'link-1',
          threadRootId: 'thread-1',
          title: 'Live child',
          status: 'pending',
          statusNodeId: 'thread-assistant',
        }]}
        isFocused={false}
        isSelected={false}
        layout="graph"
        onFocus={() => {}}
        onOpenThread={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByTitle('Thread Running')).toBeTruthy();
  });

});
