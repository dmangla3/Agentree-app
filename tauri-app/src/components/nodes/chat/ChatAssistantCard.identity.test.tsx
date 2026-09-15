// @vitest-environment jsdom
import '../../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatAssistantCard } from './ChatAssistantCard';
import { ChatUserCard } from './ChatUserCard';
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

vi.mock('../../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ data: [] }),
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

const makeUserEntity = (overrides: Partial<ProjectedNodeEntity> = {}): ProjectedNodeEntity => {
  const { message: messageOverrides, ...entityOverrides } = overrides;
  return {
    entityId: 'message:user-1',
    kind: 'user_message',
    messageId: 'user-1',
    focusMessageId: 'user-1',
    turnGroupId: 'turn-1',
    sortTs: 1,
    preview: 'User content',
    shortLabel: 'User content',
    status: null,
    message: {
      id: 'user-1',
      role: 'user',
      content: 'User content',
      parentId: null,
      workspaceId: 'workspace-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
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
        entity={makeAssistantEntity({
          message: {
            execution_data: {
              meta: {
                provider_reasoning_effort: 'high',
              },
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

    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    // The reasoning effort renders in its own span that escapes the chip's
    // uppercase styling, so it displays as "High" rather than "HIGH".
    expect(screen.getByText('High').className).toContain('normal-case');
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
                { type: 'user_steer_requested', timestamp: 2.5, content: 'stop' },
                {
                  type: 'tool_use',
                  timestamp: 3,
                  toolName: 'bash',
                  toolInput: { command: 'npm test' },
                  toolOutput: 'passed',
                  toolUseId: 'tool-1',
                },
                { type: 'message', timestamp: 4, content: 'Final answer only.' },
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
    expect(screen.queryByText('stop')).toBeNull();

    const workLogsButton = screen.getByRole('button', { name: /work logs/i });
    const finalOutput = screen.getByText('Final answer only.');
    expect(
      Boolean(workLogsButton.compareDocumentPosition(finalOutput) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);

    fireEvent.click(workLogsButton);

    expect(screen.getByText('Interim progress update.')).toBeTruthy();
    expect(screen.getByText('Checking implementation details.')).toBeTruthy();
    expect(screen.getByText('User Steer')).toBeTruthy();
    expect(screen.getByText('stop')).toBeTruthy();
    expect(screen.getByText('Run npm test')).toBeTruthy();
    expect(screen.getAllByText('Final answer only.')).toHaveLength(1);
  });

  it('copies only the final assistant output for completed structured runs', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

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

    fireEvent.click(screen.getByRole('button', { name: 'Copy assistant response' }));

    expect(writeText).toHaveBeenCalledWith('Final answer only.');
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Interim progress update.'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Checking implementation details.'));
  });

  it('copies the user message content from a user chat card', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatUserCard
        entity={makeUserEntity({
          message: {
            content: 'Run the formatter before testing.',
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

    fireEvent.click(screen.getByRole('button', { name: 'Copy user message' }));

    expect(writeText).toHaveBeenCalledWith('Run the formatter before testing.');
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
    expect(screen.getByText('Run npm test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /work logs/i })).toBeNull();
  });

  it('renders live message-only timeline rows as separate chunks before falling back to flat content', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'running' as any,
          message: {
            status: 'running' as any,
            content: 'First progress update.Second progress update.',
            execution_data: {
              timeline: [
                { type: 'message', timestamp: 1, content: 'First progress update.' },
                { type: 'message', timestamp: 2, content: 'Second progress update.' },
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

    expect(screen.getByText('First progress update.')).toBeTruthy();
    expect(screen.getByText('Second progress update.')).toBeTruthy();
    expect(screen.queryByText('First progress update.Second progress update.')).toBeNull();
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

  it('routes active tool-only timelines through open work logs before content and the running cue', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'running' as any,
          message: {
            status: 'running' as any,
            content: 'Current streamed output.',
            execution_data: {
              timeline: [
                { type: 'thinking', timestamp: 1, content: 'Inspecting the runtime.' },
                {
                  type: 'tool_use',
                  timestamp: 2,
                  toolName: 'bash',
                  toolInput: { command: 'npm test' },
                  toolUseId: 'tool-1',
                },
                { type: 'error', timestamp: 3, content: 'Retrying after transient failure.' },
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

    const content = screen.getByText('Current streamed output.');
    const workLogs = screen.getByRole('button', { name: /work logs/i });
    const runningCue = screen.getByText('Writing response');
    expect(workLogs.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(workLogs.compareDocumentPosition(runningCue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Actions/i)).toBeNull();
    expect(screen.getByText('Inspecting the runtime.')).toBeTruthy();
    expect(screen.getByText('Run npm test')).toBeTruthy();
    expect(screen.getByText('Retrying after transient failure.')).toBeTruthy();
  });

  it('uses theme foreground tokens for the running cue label', () => {
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

    expect(screen.getByText('Agent running').className).toContain('text-foreground');
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
