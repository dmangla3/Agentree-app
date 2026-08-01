import { useMemo } from 'react';
import { reconstructContext } from '../lib/contextUtils';
import type { Message } from '../stores/workspaceStore';

const estimateTokens = (text: string) => Math.ceil((text || '').length / 4);

const computeContextActivityMap = (ancestors: Message[]): Map<string, boolean> => {
    const activityById = new Map<string, boolean>();
    if (!ancestors.length) return activityById;
    const assistantByParentId = new Map<string, Message>();
    const inactiveAssistantIds = new Set<string>();

    for (const message of ancestors) {
        if (message.role === 'assistant') {
            if (message.parentId) {
                assistantByParentId.set(message.parentId, message);
            }
            if (message.context_active === false) {
                inactiveAssistantIds.add(message.id);
            }
        }
    }

    for (const message of ancestors) {
        let isActive = true;
        if (message.context_active === false) {
            isActive = false;
        }
        if (message.role === 'user') {
            const childAssistant = assistantByParentId.get(message.id);
            if (childAssistant && inactiveAssistantIds.has(childAssistant.id)) {
                isActive = false;
            }
        }
        activityById.set(message.id, isActive);
    }

    return activityById;
};

interface ContextNodeEntry {
    id: string;
    role: Message['role'];
    label: string;
    active: boolean;
    tokens: number;
    createdAt: string;
    scopeId: string | null;
}

export function useAncestorContextStats(
    parentId: string | null,
    messages: Message[],
    scopeId: string | null = null
) {
    return useMemo(() => {
        if (!parentId) return { active: 0, total: 0, tokens: 0, nodes: [] as ContextNodeEntry[] };
        const ancestors = reconstructContext(parentId, messages);
        if (!ancestors.length) return { active: 0, total: 0, tokens: 0, nodes: [] as ContextNodeEntry[] };

        const scopedAncestors = scopeId
            ? ancestors.filter((message) => (message.scope_id || null) === scopeId)
            : ancestors;
        const activityById = computeContextActivityMap(scopedAncestors);
        const activeAncestors = scopedAncestors.filter((message) => activityById.get(message.id) === true);
        const tokens = activeAncestors.reduce((sum, message) => {
            if (typeof message.totalTokens === 'number' && message.totalTokens > 0) {
                return sum + message.totalTokens;
            }
            const content = message.processedContent ?? message.content ?? '';
            return sum + estimateTokens(content);
        }, 0);

        const nodes: ContextNodeEntry[] = scopedAncestors.map((message) => {
            const raw = (message.aiLabel && message.aiLabel.trim())
                ? message.aiLabel
                : (message.processedContent ?? message.content ?? '');
            const normalized = raw.replace(/\s+/g, ' ').trim();
            const label = normalized.length > 72
                ? `${normalized.slice(0, 69)}...`
                : (normalized || `${message.role} node`);
            const tokens = (typeof message.totalTokens === 'number' && message.totalTokens > 0)
                ? message.totalTokens
                : estimateTokens(message.processedContent ?? message.content ?? '');
            return {
                id: message.id,
                role: message.role,
                label,
                active: activityById.get(message.id) === true,
                tokens,
                createdAt: message.createdAt,
                scopeId: message.scope_id ?? null,
            };
        });

        return {
            active: activeAncestors.length,
            total: scopedAncestors.length,
            tokens,
            nodes,
        };
    }, [parentId, messages, scopeId]);
}
