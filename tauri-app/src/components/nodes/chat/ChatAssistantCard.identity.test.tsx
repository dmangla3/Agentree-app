// @vitest-environment jsdom
import '../../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatAssistantCard } from './ChatAssistantCard';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';

vi.mock('../../../hooks/useAgents', () => ({
  useAgents: () => ({ data: [] }),
}));

vi.mock('../../../hooks/useMessages', () => ({
  useUpdateTags: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}));

vi.mock('../../../agent-runs/agentRunManager', () => ({
  agentRunManager: {
    snapshot: vi.fn(() => null),
    watch: vi.fn(),
    unwatch: vi.fn(),
  },
}));

vi.mock('../../../perf/agentRunVisibilityPerf', () => ({
  recordAssistantTextVisible: vi.fn(),
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
    preview: 'Assistant content',
    shortLabel: 'Generated AI topic label',
    status: null,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Assistant content',
      parentId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
      agent_id: null,
      llmModel: 'openai/gpt-5.5',
      llmProvider: 'openai',
      aiLabel: 'Generated AI topic label',
      tags: [],
      ...(messageOverrides ?? {}),
    },
    ...entityOverrides,
  };
};

describe('ChatAssistantCard identity', () => {
  it('uses the model identity for the agent chip and shows the generated AI label separately', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity()}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    expect(screen.getByText('Generated AI topic label')).toBeTruthy();
  });

  it('puts the persisted failure reason on the failed status tooltip only', () => {
    const reason = "ImportError: cannot import name 'ParamSpec' from 'typing'";

    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'failed' as any,
          message: {
            status: 'failed' as any,
            execution_data: {
              failure_reason: reason,
            },
          } as any,
        })}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByTitle(`Agent Failed: ${reason}`)).toBeTruthy();
    expect(screen.queryByText('Failure reason')).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('shows only final output for completed structured runs and keeps work details in collapsed logs', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'completed' as any,
          message: {
            status: 'completed' as any,
            content: 'Final answer only.',
            execution_data: {
              timeline: [
                { type: 'message', timestamp: 1, content: 'Interim progress update.' },
                { type: 'thinking', timestamp: 2, content: 'Checking implementation details.' },
                {
                  type: 'tool_use',
                  timestamp: 3,
                  toolName: 'bash',
                  toolInput: { command: 'npm test' },
                  toolOutput: 'passed',
                  toolUseId: 'tool-1',
                },
              ],
            },
          } as any,
        })}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('Final answer only.')).toBeTruthy();
    expect(screen.queryByText('Interim progress update.')).toBeNull();
    expect(screen.queryByText('Checking implementation details.')).toBeNull();

    const workLogsButton = screen.getByRole('button', { name: /work logs/i });
    const finalOutput = screen.getByText('Final answer only.');
    expect(
      Boolean(workLogsButton.compareDocumentPosition(finalOutput) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);

    fireEvent.click(workLogsButton);

    expect(screen.getByText('Interim progress update.')).toBeTruthy();
    expect(screen.getByText('Checking implementation details.')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('keeps interleaved work visible while structured runs are active', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'running' as any,
          message: {
            status: 'running' as any,
            content: 'Current streamed output.',
            execution_data: {
              timeline: [
                { type: 'message', timestamp: 1, content: 'Live progress update.' },
                {
                  type: 'tool_use',
                  timestamp: 2,
                  toolName: 'bash',
                  toolInput: { command: 'npm test' },
                  toolUseId: 'tool-1',
                },
              ],
            },
          } as any,
        })}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('Live progress update.')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /work logs/i })).toBeNull();
  });

  it('shows a refined running cue instead of the generic working label', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'running' as any,
          message: {
            status: 'running' as any,
            content: '',
          } as any,
        })}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('Agent running')).toBeTruthy();
    expect(screen.queryByText(/^working$/i)).toBeNull();
  });

  it('shows user steering messages in the active chat assistant card', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          message: {
            content: '',
            execution_data: {
              timeline: [
                {
                  type: 'user_steer_requested',
                  timestamp: 1,
                  content: 'Actually use the cached result.',
                },
              ],
            },
          } as any,
        })}
        isFocused={false}
        isSelected={false}
        layout="chat"
        onFocus={() => {}}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />
    );

    expect(screen.getByText('User Steer')).toBeTruthy();
    expect(screen.getByText('Actually use the cached result.')).toBeTruthy();
  });
});
