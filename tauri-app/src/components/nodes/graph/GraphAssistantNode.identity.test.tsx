// @vitest-environment jsdom
import '../../../test/setup';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphAssistantNode } from './GraphAssistantNode';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';

vi.mock('./GraphNodeWrapper', () => ({
  GraphNodeWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
      llmModel: 'openai/gpt-5.5-high',
      llmProvider: 'openai',
      aiLabel: 'Generated AI topic label',
      tags: [],
      ...(messageOverrides ?? {}),
    },
    ...entityOverrides,
  };
};

describe('GraphAssistantNode identity', () => {
  it('uses the model identity as the assistant node header and keeps the AI label separate', () => {
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

    expect(screen.getByText('GPT 5.5 High')).toBeTruthy();
    expect(screen.getByText('Generated AI topic label')).toBeTruthy();
    expect(screen.queryByText('Assistant')).toBeNull();
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
});
