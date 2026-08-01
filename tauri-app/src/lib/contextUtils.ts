import { Message } from '../stores/workspaceStore';

/**
 * Reconstructs the linear workspace history for a specific message node.
 * Uses path_ids for O(1) retrieval if available, otherwise falls back to parent traversal.
 * 
 * @param targetMessageId The ID of the message to get context for
 * @param messages Array of all messages in the workspace
 * @returns Array of messages from root to target, sorted by depth/time
 */
export function reconstructContext(targetMessageId: string, messages: Message[]): Message[] {
    if (!targetMessageId || !messages || messages.length === 0) return [];

    const messageMap = new Map(messages.map(m => [m.id, m]));
    const targetMessage = messageMap.get(targetMessageId);

    if (!targetMessage) return [];

    // Method 1: Use Materialized Path (O(path_length))
    if (targetMessage.path_ids && targetMessage.path_ids.length > 0) {
        return targetMessage.path_ids
            .map(id => messageMap.get(id))
            .filter((m): m is Message => !!m)
            .sort((a, b) => {
                // Sort by depth if available, otherwise createdAt
                if (a.depth !== undefined && b.depth !== undefined && a.depth !== null && b.depth !== null) {
                    return a.depth - b.depth;
                }
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });
    }

    // Method 2: Fallback Parent Traversal (O(depth))
    const history: Message[] = [];
    let current: Message | undefined = targetMessage;

    while (current) {
        history.unshift(current);
        if (!current.parentId) break;
        current = messageMap.get(current.parentId);
    }

    return history;
}
