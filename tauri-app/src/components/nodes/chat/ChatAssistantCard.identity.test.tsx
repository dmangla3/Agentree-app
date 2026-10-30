// @vitest-environment jsdom
import '../../../test/setup';
import type { ReactNode } from 'react';
import { fireEvent, render as renderWithoutTooltips, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatAssistantCard } from './ChatAssistantCard';
import { ChatUserCard } from './ChatUserCard';
import { AgentreeSurfaceProvider, publicShareCapabilities } from '../../graph/surfaceCapabilities';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import { LOGIN_PROFILES_NAVIGATION_EVENT } from '../../../lib/loginNavigationEvents';
import { TooltipProvider } from '../../../../@/components/ui/tooltip';

const render = (ui: ReactNode) => renderWithoutTooltips(
  <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
);

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
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByLabelText('Model used: GPT 5.5. Reasoning effort: High.')).toBeTruthy();
  });

  it('shows the assistant base commit chip with the full commit in its accessible label', () => {
    const baseCommitSha = 'abcdef1234567890abcdef1234567890abcdef12';

    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          message: {
            base_commit_sha: baseCommitSha,
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

    expect(screen.getByText('abcdef12')).toBeTruthy();
    expect(screen.getByLabelText(`Base commit: ${baseCommitSha}`)).toBeTruthy();
    expect(screen.getByTitle(`Copy commit SHA: ${baseCommitSha}`)).toBeTruthy();
  });

  it('groups assistant header metadata and explains each element with informational tooltips', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const baseCommitSha = 'eea7a34e1234567890abcdef1234567890abcdef';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'cancelled' as any,
          toolCallCount: 22,
          commitCount: 3,
          message: {
            id: 'dd9348a7-9bdc-4adb-89aa-179d9b0b125b',
            status: 'cancelled' as any,
            base_commit_sha: baseCommitSha,
            aiLabel: 'Plan review',
            tags: ['docs'],
            execution_data: {
              meta: { provider_reasoning_effort: 'high' },
              usage: {
                input_tokens: 40_400,
                output_tokens: 583,
                cached_input_tokens: 34_200,
                reasoning_tokens: 1_250,
                total_tokens: 40_900,
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

    const usage = screen.getByLabelText('Token usage');

    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByLabelText('22 tool calls')).toBeNull();
    expect(screen.getByLabelText('3 commits created by this agent run')).toBeTruthy();
    expect(screen.getByText('eea7a34e')).toBeTruthy();
    expect(screen.getByText('dd9348a7')).toBeTruthy();
    expect(screen.getByText('Plan review')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(usage.textContent).toContain('40.4k');
    expect(usage.textContent).toContain('583');
    expect(usage.textContent).toContain('34.2k');
    expect(usage.textContent).toContain('1.3k');
    expect(usage.textContent).toContain('40.9k');
    expect(screen.getByLabelText('40,400 input tokens')).toBeTruthy();
    expect(screen.getByLabelText('40,900 total tokens')).toBeTruthy();

    fireEvent.focus(screen.getByLabelText('Model used: GPT 5.5. Reasoning effort: High.'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(
      'Model used: GPT 5.5 · Reasoning effort: High',
    ));
    fireEvent.blur(screen.getByLabelText('Model used: GPT 5.5. Reasoning effort: High.'));

    fireEvent.focus(screen.getByLabelText(`Base commit: ${baseCommitSha}`));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(
      "This base commit was used to create the agent's worktree.",
    ));
    fireEvent.blur(screen.getByLabelText(`Base commit: ${baseCommitSha}`));

    fireEvent.focus(screen.getByLabelText('Agent status: Cancelled'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Agent status: Cancelled'));
    fireEvent.blur(screen.getByLabelText('Agent status: Cancelled'));

    fireEvent.focus(screen.getByLabelText('Message ID: dd9348a7-9bdc-4adb-89aa-179d9b0b125b'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(
      'Unique ID for this message. Pass it to any agent to reference this message.',
    ));
    fireEvent.blur(screen.getByLabelText('Message ID: dd9348a7-9bdc-4adb-89aa-179d9b0b125b'));

    fireEvent.focus(screen.getByLabelText('AI-generated summary: Plan review'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('AI-generated summary of this message.'));
    fireEvent.blur(screen.getByLabelText('AI-generated summary: Plan review'));

    fireEvent.focus(screen.getByLabelText('40,400 input tokens'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(
      'Input tokens: 40,400 sent as context for this response.',
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Copy message ID' }));
    expect(writeText).toHaveBeenCalledWith('dd9348a7-9bdc-4adb-89aa-179d9b0b125b');
    expect(screen.getByTitle(`Copy commit SHA: ${baseCommitSha}`)).toBeTruthy();
  });

  it('keeps partial assistant output and shows the failure reason separately', () => {
    const reason = "ImportError: cannot import name 'ParamSpec' from 'typing'";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

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

    expect(screen.getByLabelText('Agent status: Failed')).toBeTruthy();
    expect(screen.getByText('Assistant content')).toBeTruthy();
    expect(screen.getByText('Run failed')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Runtime Health' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy assistant response' }));
    expect(writeText).toHaveBeenCalledWith(`Assistant content\n\nFailure: ${reason}`);
  });

  it('opens Runtime Health from a managed runtime failure', () => {
    const navigationIntent = vi.fn();
    window.addEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, navigationIntent);

    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'failed' as any,
          message: {
            status: 'failed' as any,
            execution_data: {
              failure_reason: "Agentree's managed Codex runtime could not be installed.",
              meta: {
                provider_error_code: 'codex_cli_missing',
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

    fireEvent.click(screen.getByRole('button', { name: 'Open Runtime Health' }));

    expect(navigationIntent).toHaveBeenCalledOnce();
    expect((navigationIntent.mock.calls[0][0] as CustomEvent).detail).toEqual({
      target: 'runtime-health',
    });
    window.removeEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, navigationIntent);
  });

  it('replaces a raw provider error payload with its human-readable failure reason', () => {
    const reason = "The 'gpt-5-nano' model is not supported with a ChatGPT account.";
    const rawProviderError = JSON.stringify({
      error: { message: reason },
      willRetry: false,
    });

    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'failed' as any,
          message: {
            status: 'failed' as any,
            content: rawProviderError,
            execution_data: {
              failure_reason: rawProviderError,
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

    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText(rawProviderError)).toBeNull();
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

  it('keeps failed-run activity in collapsed logs beside the visible failure summary', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'failed' as any,
          message: {
            status: 'failed' as any,
            content: 'Last safe update.',
            execution_data: {
              failure_reason: 'Provider disconnected.',
              timeline: [
                { type: 'message', timestamp: 1, content: 'Last safe update.' },
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

    expect(screen.getByText('Provider disconnected.')).toBeTruthy();
    expect(screen.getByText('Last safe update.')).toBeTruthy();
    expect(screen.queryByText('Run npm test')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /work logs/i }));
    expect(screen.getByText('Run npm test')).toBeTruthy();
  });

  it('keeps public-share work logs collapsed until the viewer opens them', () => {
    render(
      <AgentreeSurfaceProvider surfaceMode="public-share" capabilities={publicShareCapabilities}>
        <ChatAssistantCard
          entity={makeAssistantEntity({
            status: 'completed' as any,
            message: {
              status: 'completed' as any,
              content: 'Shared final answer.',
              execution_data: {
                timeline: [
                  { type: 'thinking', timestamp: 1, content: 'Private work detail.' },
                  { type: 'message', timestamp: 2, content: 'Shared final answer.' },
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
      </AgentreeSurfaceProvider>
    );

    const workLogsButton = screen.getByRole('button', { name: /work logs/i });
    expect(workLogsButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Private work detail.')).toBeNull();

    fireEvent.click(workLogsButton);

    expect(workLogsButton.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Private work detail.')).toBeTruthy();
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

  it('shows and copies the user message ID', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ChatUserCard
        entity={makeUserEntity({
          messageId: 'user-message-123',
          message: {
            id: 'user-message-123',
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

    expect(screen.getByText('user-mes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy message ID' }));

    expect(writeText).toHaveBeenCalledWith('user-message-123');
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

  it('preserves provider-native tool names while formatting expandable details generically', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'completed' as any,
          message: {
            status: 'completed' as any,
            content: 'Research complete.',
            execution_data: {
              timeline: [
                {
                  type: 'tool_use',
                  timestamp: 1,
                  toolName: 'webSearch',
                  toolInput: {
                    action: { type: 'search', queries: ['Agentree docs', 'Agentree GitHub'] },
                  },
                  toolUseId: 'search-1',
                },
                {
                  type: 'tool_result',
                  timestamp: 2,
                  toolName: 'webSearch',
                  toolOutput: { status: 'completed', query: 'Agentree docs' },
                  toolUseId: 'search-1',
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

    fireEvent.click(screen.getByRole('button', { name: /work logs/i }));
    expect(screen.getByText('webSearch')).toBeTruthy();
    expect(screen.getByText(/Agentree docs/)).toBeTruthy();
    expect(screen.queryByText('Web search')).toBeNull();
    expect(screen.queryByText(/\{"action"/)).toBeNull();

    fireEvent.click(screen.getByText('webSearch').closest('[role="button"]')!);
    expect(screen.getByText('Request')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getAllByText(/queries/i).length).toBeGreaterThan(0);
  });

  it('collapses adjacent command and search calls into expandable groups with exact names underneath', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'completed' as any,
          message: {
            status: 'completed' as any,
            content: 'Work complete.',
            execution_data: {
              timeline: [
                { type: 'tool_use', timestamp: 1, toolName: 'commandExecution', toolUseId: 'cmd-1', toolInput: { command: 'pnpm test' }, toolOutput: 'passed' },
                { type: 'tool_use', timestamp: 2, toolName: 'Bash', toolUseId: 'cmd-2', toolInput: { command: 'pnpm build' }, toolOutput: 'built' },
                { type: 'tool_use', timestamp: 3, toolName: 'webSearch', toolUseId: 'search-1', toolInput: { query: 'Agentree' }, toolOutput: [] },
                { type: 'tool_use', timestamp: 4, toolName: 'Grep', toolUseId: 'search-2', toolInput: { pattern: 'TimelineRow' }, toolOutput: '2 matches' },
                { type: 'tool_use', timestamp: 5, toolName: 'ToolSearch', toolUseId: 'search-3', toolInput: { query: 'calendar' }, toolOutput: [] },
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

    fireEvent.click(screen.getByRole('button', { name: /work logs/i }));
    expect(screen.getByRole('button', { name: /Ran 2 commands/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /3 searches/i })).toBeTruthy();
    expect(screen.queryByText('commandExecution')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ran 2 commands/i }));
    expect(screen.getByText('commandExecution')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();

    fireEvent.click(screen.getByText('commandExecution').closest('[role="button"]')!);
    expect(screen.getByText('Request')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getAllByText(/pnpm test/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /3 searches/i }));
    expect(screen.getByText('webSearch')).toBeTruthy();
    expect(screen.getByText('Grep')).toBeTruthy();
    expect(screen.getByText('ToolSearch')).toBeTruthy();
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

  it('renders active tool-only timelines inline after loaded content and before the running cue', () => {
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
    const thinking = screen.getByText('Inspecting the runtime.');
    const tool = screen.getByText('Run npm test');
    const error = screen.getByText('Retrying after transient failure.');
    const runningCue = screen.getByText('Writing response');
    expect(content.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinking.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.compareDocumentPosition(runningCue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /work logs/i })).toBeNull();
    expect(screen.queryByText(/Actions/i)).toBeNull();
  });

  it('shows user steering messages in the active chat assistant card', () => {
    render(
      <ChatAssistantCard
        entity={makeAssistantEntity({
          status: 'running' as any,
          message: {
            status: 'running' as any,
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
