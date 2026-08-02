export interface LeafMessageLike {
  id: string;
  parentId: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  last_event_at?: string | null;
}

const getMessageRecency = (message: LeafMessageLike): number => {
  const timestamp = message.last_event_at || message.updatedAt || message.createdAt;
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

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
