// @vitest-environment jsdom
import '../../../test/setup';
import { render, screen } from '@testing-library/react';
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

const makeAssistantEntity = (): ProjectedNodeEntity => ({
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
  },
});

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
});
