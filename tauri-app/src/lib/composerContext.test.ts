import { describe, expect, it } from 'vitest';
import { buildComposerContextPathIds, buildComposerContextSelection } from './composerContext';
import type { Message } from '../stores/workspaceStore';

const workspaceId = 'composer-context-test';
const isoAt = (index: number) => new Date(Date.UTC(2026, 4, 11, 10, 0, index)).toISOString();

const message = (
  input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>,
  index: number,
): Message => ({
  id: input.id,
  role: input.role,
  parentId: input.parentId,
  content: input.content ?? input.id,
  processedContent: input.processedContent,
  workspaceId,
  context_active: input.context_active,
  execution_data: input.execution_data ?? null,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const conversation = (): Message[] => [
  message({ id: 'user-1', role: 'user', parentId: null }, 1),
  message({ id: 'assistant-1', role: 'assistant', parentId: 'user-1' }, 2),
  message({ id: 'user-2', role: 'user', parentId: 'assistant-1' }, 3),
  message({ id: 'assistant-2', role: 'assistant', parentId: 'user-2' }, 4),
];

describe('composer context', () => {
  it('keeps inherited context across the full ancestor path', () => {
    const selection = buildComposerContextSelection(
      'assistant-2',
      conversation(),
    );

    expect(selection.defaultSelectedIds).toEqual([
      'user-1:user',
      'assistant-1:assistant',
      'user-2:user',
      'assistant-2:assistant',
    ]);
  });

  it('builds context path ids from the same active messages that default context will pass', () => {
    const messages = [
      ...conversation(),
      message({
        id: 'user-3',
        role: 'user',
        parentId: 'assistant-2',
        context_active: false,
      }, 5),
      message({
        id: 'assistant-3',
        role: 'assistant',
        parentId: 'user-3',
        context_active: false,
      }, 6),
    ];

    expect(buildComposerContextPathIds({
      parentId: 'assistant-3',
      messages,
      contextPolicy: 'continue',
    })).toEqual(new Set(['user-1', 'assistant-1', 'user-2', 'assistant-2']));
  });

  it('returns an empty context path for fresh context', () => {
    expect(buildComposerContextPathIds({
      parentId: 'assistant-2',
      messages: conversation(),
      contextPolicy: 'fresh',
    })).toEqual(new Set());
  });

  it('starts context at the selected context start node', () => {
    expect(buildComposerContextPathIds({
      parentId: 'assistant-2',
      messages: conversation(),
      contextPolicy: 'continue',
      contextStartId: 'user-2',
    })).toEqual(new Set(['user-2', 'assistant-2']));
  });

  it('merges an alternate context parent with the placement parent path', () => {
    const messages = [
      ...conversation(),
      message({ id: 'user-branch', role: 'user', parentId: 'assistant-1' }, 5),
      message({ id: 'assistant-branch', role: 'assistant', parentId: 'user-branch' }, 6),
    ];

    expect(buildComposerContextPathIds({
      parentId: 'assistant-branch',
      messages,
      contextParentId: 'assistant-2',
      contextPolicy: 'continue',
    })).toEqual(new Set([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
      'user-branch',
      'assistant-branch',
    ]));
  });

  it('selects bounded recent tool context by default without adding extra path ids', () => {
    const messages = [
      message({ id: 'user-1', role: 'user', parentId: null }, 1),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        execution_data: {
          timeline: [
            { type: 'tool_use', toolUseId: 'tool-1', toolName: 'read_file', toolInput: { path: 'a.ts' } },
            { type: 'tool_result', toolUseId: 'tool-1', toolName: 'read_file', toolOutput: 'content' },
          ],
        },
      }, 2),
    ];

    const selection = buildComposerContextSelection('assistant-1', messages);

    expect(selection.entries.map((entry) => entry.id)).toEqual([
      'user-1:user',
      'assistant-1:assistant',
      'assistant-1:tool',
    ]);
    expect(selection.defaultSelectedIds).toEqual([
      'user-1:user',
      'assistant-1:assistant',
      'assistant-1:tool',
    ]);
    expect(buildComposerContextPathIds({
      parentId: 'assistant-1',
      messages,
      contextPolicy: 'continue',
    })).toEqual(new Set(['user-1', 'assistant-1']));
  });

  it('does not select oversized tool context by default', () => {
    const largeToolOutput = 'x'.repeat(24001);
    const messages = [
      message({ id: 'user-1', role: 'user', parentId: null }, 1),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        execution_data: {
          timeline: [
            { type: 'tool_use', toolUseId: 'tool-1', toolName: 'read_file', toolInput: { path: 'large.ts' } },
            { type: 'tool_result', toolUseId: 'tool-1', toolName: 'read_file', toolOutput: largeToolOutput },
          ],
        },
      }, 2),
    ];

    const selection = buildComposerContextSelection('assistant-1', messages);

    expect(selection.defaultSelectedIds).toEqual([
      'user-1:user',
      'assistant-1:assistant',
    ]);
  });
});
