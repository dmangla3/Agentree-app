export interface LeafMessageLike {
  id: string;
  parentId: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  last_event_at?: string | null;
}

export interface LeafNavigationLabelMessageLike {
  role: 'user' | 'assistant';
  content?: string | null;
  aiLabel?: string | null;
  commit?: {
    subject?: string | null;
  } | null;
}

const getMessageRecency = (message: LeafMessageLike): number => {
  const timestamp = message.last_event_at || message.updatedAt || message.createdAt;
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const cleanLeafLabel = (value: string | null | undefined): string => (
  (value || '')
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/`[^`]+`/g, '[Code]')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\s+/g, ' ')
    .trim()
);

export const getLeafMessagesByRecency = <MessageType extends LeafMessageLike>(
  messages: readonly MessageType[],
): MessageType[] => {
  const parentIds = new Set<string>();

  for (const message of messages) {
    if (message.parentId) {
      parentIds.add(message.parentId);
    }
  }

  return messages
    .filter((message) => !parentIds.has(message.id))
    .sort((left, right) => getMessageRecency(right) - getMessageRecency(left));
};

export const getLeafNavigationLabel = (
  message: LeafNavigationLabelMessageLike,
): string => {
  const fallbackLabel = message.commit
    ? 'Commit'
    : message.role === 'user'
      ? 'User message'
      : 'Assistant message';
  const label = [
    message.aiLabel,
    message.commit?.subject,
    message.content,
  ].map(cleanLeafLabel).find(Boolean) || fallbackLabel;

  return label.length > 72 ? `${label.slice(0, 69)}...` : label;
};
