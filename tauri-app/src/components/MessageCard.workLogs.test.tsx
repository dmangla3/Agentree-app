// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageCard } from './MessageCard';
import type { Message } from '../stores/workspaceStore';

vi.mock('../hooks/useMessages', () => ({
  useMessages: () => ({ data: [] }),
  useSummaries: () => ({ data: [] }),
  useUpdateTags: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
  useAddComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../hooks/useBranches', () => ({
  useBranches: () => ({ data: [] }),
}));

vi.mock('../hooks/useNodeEvents', () => ({
  useNodeEvents: () => ({ data: { events: [] } }),
}));

vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ data: [] }),
}));

vi.mock('./OpenNodeButton', () => ({
  OpenNodeButton: () => null,
}));

vi.mock('../stores/workspaceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/workspaceStore')>();
  const useWorkspaceStore = (selector: any) => selector({
    disabledSummaryIds: [],
    focusedMessageId: null,
  });
  return {
    ...actual,
    useWorkspaceStore,
  };
});

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content: 'Final answer only.',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-05-16T00:00:00.000Z',
  updatedAt: '2026-05-16T00:00:00.000Z',
  attachments: [],
  annotations: [],
  tags: [],
  status: 'completed' as any,
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
      { type: 'message', timestamp: 4, content: 'Final answer only.' },
    ],
  },
  ...overrides,
} as Message);

describe('MessageCard work logs', () => {
  it('shows final output for completed structured runs and moves execution detail into collapsed work logs', () => {
    render(
      <MessageCard
        message={makeMessage()}
        workspaceId="workspace-1"
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
    expect(screen.getAllByText('Final answer only.')).toHaveLength(1);
  });
});
