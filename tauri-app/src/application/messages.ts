import type {
  Message,
  MessageHighlightAnnotation,
  MessageHighlightColor,
} from '../stores/workspaceStore';
import { agentClient } from '../lib/agentClient';
import { api } from '../lib/api';
import { isTauriEnvironment } from '../hooks/useTauriWorkspace';

export interface UpdateMessageTagsInput {
  workspaceId: string;
  messageId: string;
  tags: string[];
  action: 'add' | 'remove';
}

export type UpdateMessageHighlightInput = {
  workspaceId: string;
  messageId: string;
} & (
  | { action: 'add'; highlight: MessageHighlightAnnotation }
  | { action: 'update'; highlightId: string; color: MessageHighlightColor }
  | { action: 'delete'; highlightId: string }
);

const updateTags = async (input: UpdateMessageTagsInput): Promise<Message | null> => {
  if (isTauriEnvironment()) {
    return await agentClient.localFirstUpdateNodeTags(
      input.workspaceId,
      input.messageId,
      input.tags,
      input.action,
    ) as Message;
  }

  if (input.action === 'add') {
    const response = await api.post<Message>(`/messages/${input.messageId}/tags`, {
      tags: input.tags,
    });
    return response.data;
  }
  const responses = await Promise.all(input.tags.map((tag) =>
    api.delete<Message>(`/messages/${input.messageId}/tags/${encodeURIComponent(tag)}`)
  ));
  return responses.length > 0 ? responses[responses.length - 1].data : null;
};

const updateHighlight = async (input: UpdateMessageHighlightInput): Promise<Message | null> => {
  if (isTauriEnvironment()) {
    const highlight = input.action === 'add'
      ? input.highlight
      : { id: input.highlightId, ...(input.action === 'update' ? { color: input.color } : {}) };
    return await agentClient.localFirstUpdateNodeHighlight(
      input.workspaceId,
      input.messageId,
      input.action,
      highlight,
    ) as Message;
  }

  if (input.action === 'add') {
    const response = await api.post<Message>(`/messages/${input.messageId}/highlights`, {
      id: input.highlight.id,
      color: input.highlight.color,
      range: input.highlight.range,
    });
    return response.data;
  }
  if (input.action === 'update') {
    const response = await api.patch<Message>(
      `/messages/${input.messageId}/highlights/${encodeURIComponent(input.highlightId)}`,
      { color: input.color },
    );
    return response.data;
  }
  const response = await api.delete<Message>(
    `/messages/${input.messageId}/highlights/${encodeURIComponent(input.highlightId)}`,
  );
  return response.data;
};

const setCollapsed = async (input: {
  workspaceId: string;
  messageId: string;
  collapsed: boolean;
}): Promise<Message | null> => {
  if (isTauriEnvironment()) {
    return await agentClient.localFirstSetNodeCollapsed(
      input.workspaceId,
      input.messageId,
      input.collapsed,
    ) as Message;
  }
  const response = await api.patch<Message>(`/messages/${input.messageId}`, {
    collapsed: input.collapsed,
  });
  return response.data;
};

export const messageApplication = {
  updateTags,
  updateHighlight,
  setCollapsed,
};
