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
  scope_id: input.scope_id,
  context_active: input.context_active,
  execution_data: input.execution_data ?? null,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  createdAt: input.createdAt ?? isoAt(index),
  updatedAt: input.updatedAt ?? isoAt(index),
});

const scopedConversation = (): Message[] => [
  message({ id: 'user-1', role: 'user', parentId: null, scope_id: 'scope-a' }, 1),
  message({ id: 'assistant-1', role: 'assistant', parentId: 'user-1', scope_id: 'scope-a' }, 2),
  message({ id: 'user-2', role: 'user', parentId: 'assistant-1', scope_id: 'scope-b' }, 3),
  message({ id: 'assistant-2', role: 'assistant', parentId: 'user-2', scope_id: 'scope-b' }, 4),
];

describe('composer context', () => {
  it('does not filter inherited context by scope', () => {
    const selection = buildComposerContextSelection(
      'assistant-2',
      scopedConversation(),
      'scope-b',
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
      ...scopedConversation(),
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
      scopeId: 'scope-b',
      contextPolicy: 'continue',
    })).toEqual(new Set(['user-1', 'assistant-1', 'user-2', 'assistant-2']));
  });

  it('returns an empty context path for fresh context', () => {
    expect(buildComposerContextPathIds({
      parentId: 'assistant-2',
      messages: scopedConversation(),
      contextPolicy: 'fresh',
    })).toEqual(new Set());
  });

  it('starts context at the selected context start node', () => {
    expect(buildComposerContextPathIds({
      parentId: 'assistant-2',
      messages: scopedConversation(),
      contextPolicy: 'continue',
      contextStartId: 'user-2',
    })).toEqual(new Set(['user-2', 'assistant-2']));
  });

  it('merges an alternate context parent with the placement parent path', () => {
    const messages = [
      ...scopedConversation(),
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

  it('offers tool context without selecting it by default or adding extra path ids', () => {
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
    ]);
    expect(buildComposerContextPathIds({
      parentId: 'assistant-1',
      messages,
      contextPolicy: 'continue',
    })).toEqual(new Set(['user-1', 'assistant-1']));
  });
});
