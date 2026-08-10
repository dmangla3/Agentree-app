import { useState, useMemo, useCallback, useEffect } from 'react';
import { subHours, subDays, startOfDay, endOfDay } from 'date-fns';
import { BranchPointer, Message } from '../../stores/workspaceStore';
import { classifyMessageNodeKind } from '../../domain/nodes';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type TimePreset = 'all' | '1h' | '5h' | '24h' | '7d' | '30d' | 'custom';
export type AgentOperator = 'any_of' | 'none_of';
export type TagOperator = 'has_any' | 'has_all' | 'has_none';
export type GroupOperator = 'and' | 'or';
export type MessageNodeType = 'user_message' | 'assistant_message' | 'commit_message';

export interface UseTagFilterResult {
    // Available filter values
    uniqueTags: string[];
    uniqueAgentIds: string[];

    // Current filter state
    timePreset: TimePreset;
    customTimeFrom: string;
    customTimeTo: string;
    selectedAgentIds: Set<string>;
    selectedFilterTags: Set<string>;
    selectedNodeTypes: Set<MessageNodeType>;
    agentOperator: AgentOperator;
    tagOperator: TagOperator;
    groupOperator: GroupOperator;
    keepAncestors: boolean;
    keepDescendants: boolean;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    matchingMessageIds: Set<string>;

    // Actions
    setTimePreset: (preset: TimePreset) => void;
    setCustomTimeFrom: (value: string) => void;
    setCustomTimeTo: (value: string) => void;
    handleAgentFilterChange: (agentId: string, checked: boolean) => void;
    handleTagFilterChange: (tag: string, checked: boolean) => void;
    handleNodeTypeFilterChange: (nodeType: MessageNodeType, checked: boolean) => void;
    setAgentOperator: (op: AgentOperator) => void;
    setTagOperator: (op: TagOperator) => void;
    setGroupOperator: (op: GroupOperator) => void;
    setKeepAncestors: (value: boolean) => void;
    setKeepDescendants: (value: boolean) => void;
    handleClearTagFilters: () => void;
    handleClearAllFilters: () => void;

    // UI helpers
    filterButtonText: string;
    activeFilterCount: number;
    matchingCount: number;
    messageNodeCount: number;
    nodeTypeCounts: Record<MessageNodeType, number>;
}

interface PersistedGraphFilterState {
    timePreset?: TimePreset;
    customTimeFrom?: string;
    customTimeTo?: string;
    selectedAgentIds?: string[];
    selectedFilterTags?: string[];
    selectedNodeTypes?: MessageNodeType[];
    agentOperator?: AgentOperator;
    tagOperator?: TagOperator;
    groupOperator?: GroupOperator;
    keepAncestors?: boolean;
    keepDescendants?: boolean;
}

const GRAPH_FILTER_STORAGE_VERSION = 1;
const DEFAULT_GRAPH_FILTER_STORAGE_KEY = `agentree.graphFilters.v${GRAPH_FILTER_STORAGE_VERSION}`;

const readPersistedGraphFilterState = (storageKey: string): PersistedGraphFilterState => {
    if (typeof window === 'undefined') return {};

    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const writePersistedGraphFilterState = (storageKey: string, state: PersistedGraphFilterState) => {
    if (typeof window === 'undefined') return;

    try {
        window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
        // Ignore quota/privacy failures; filters still work for the current session.
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════

export function useTagFilter(
    messages: Message[],
    _branchPointers: BranchPointer[] = [],
    storageKey: string = DEFAULT_GRAPH_FILTER_STORAGE_KEY,
): UseTagFilterResult {
    const [persistedStorageKey, setPersistedStorageKey] = useState(storageKey);
    const [initialState, setInitialState] = useState<PersistedGraphFilterState>(() => readPersistedGraphFilterState(storageKey));
    const [timePreset, setTimePreset] = useState<TimePreset>(() => initialState.timePreset ?? 'all');
    const [customTimeFrom, setCustomTimeFrom] = useState(() => initialState.customTimeFrom ?? '');
    const [customTimeTo, setCustomTimeTo] = useState(() => initialState.customTimeTo ?? '');
    const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set(initialState.selectedAgentIds ?? []));
    const [selectedFilterTags, setSelectedFilterTags] = useState<Set<string>>(() => new Set(initialState.selectedFilterTags ?? []));
    const [selectedNodeTypes, setSelectedNodeTypes] = useState<Set<MessageNodeType>>(() => new Set(initialState.selectedNodeTypes ?? []));
    const [agentOperator, setAgentOperator] = useState<AgentOperator>(() => initialState.agentOperator ?? 'any_of');
    const [tagOperator, setTagOperator] = useState<TagOperator>(() => initialState.tagOperator ?? 'has_any');
    const [groupOperator, setGroupOperator] = useState<GroupOperator>(() => initialState.groupOperator ?? 'and');
    const [keepAncestors, setKeepAncestors] = useState(() => initialState.keepAncestors ?? true);
    const [keepDescendants, setKeepDescendants] = useState(() => initialState.keepDescendants ?? true);

    useEffect(() => {
        if (storageKey === persistedStorageKey) return;
        const nextState = readPersistedGraphFilterState(storageKey);
        setPersistedStorageKey(storageKey);
        setInitialState(nextState);
        setTimePreset(nextState.timePreset ?? 'all');
        setCustomTimeFrom(nextState.customTimeFrom ?? '');
        setCustomTimeTo(nextState.customTimeTo ?? '');
        setSelectedAgentIds(new Set(nextState.selectedAgentIds ?? []));
        setSelectedFilterTags(new Set(nextState.selectedFilterTags ?? []));
        setSelectedNodeTypes(new Set(nextState.selectedNodeTypes ?? []));
        setAgentOperator(nextState.agentOperator ?? 'any_of');
        setTagOperator(nextState.tagOperator ?? 'has_any');
        setGroupOperator(nextState.groupOperator ?? 'and');
        setKeepAncestors(nextState.keepAncestors ?? true);
        setKeepDescendants(nextState.keepDescendants ?? true);
    }, [persistedStorageKey, storageKey]);

    const assistantMessages = useMemo(
        () => messages.filter((msg: Message) => msg.role === 'assistant'),
        [messages]
    );
    const messageMap = useMemo(
        () => new Map(messages.map((message) => [message.id, message])),
        [messages]
    );
    const nodeTypeByMessageId = useMemo(() => {
        const result = new Map<string, MessageNodeType>();
        messages.forEach((message) => {
            result.set(message.id, classifyMessageNodeKind(message, messageMap));
        });
        return result;
    }, [messageMap, messages]);
    const nodeTypeCounts = useMemo<Record<MessageNodeType, number>>(() => {
        const counts: Record<MessageNodeType, number> = {
            user_message: 0,
            assistant_message: 0,
            commit_message: 0,
        };
        nodeTypeByMessageId.forEach((nodeType) => {
            counts[nodeType] += 1;
        });
        return counts;
    }, [nodeTypeByMessageId]);

    const uniqueAgentIds = useMemo(() => {
        const ids = new Set<string>();
        assistantMessages.forEach((msg) => {
            if (msg.agent_id) ids.add(msg.agent_id);
        });
        return Array.from(ids).sort((a, b) => a.localeCompare(b));
    }, [assistantMessages]);

    // Calculate unique tags from messages
    const uniqueTags = useMemo(() => {
        const tagsSet = new Set<string>();
        assistantMessages.forEach((msg: Message) => {
            if (Array.isArray(msg.tags)) {
                msg.tags.forEach((tag: string) => tagsSet.add(tag));
            }
        });
        return Array.from(tagsSet).sort((a: string, b: string) => a.localeCompare(b));
    }, [assistantMessages]);

    const evaluateTimeMatch = useCallback((createdAt: string): boolean => {
        if (timePreset === 'all') return true;
        const timestamp = new Date(createdAt).getTime();
        if (!Number.isFinite(timestamp)) return false;

        const now = new Date();
        let from = -Infinity;
        let to = now.getTime();

        if (timePreset === '1h') from = subHours(now, 1).getTime();
        if (timePreset === '5h') from = subHours(now, 5).getTime();
        if (timePreset === '24h') from = subHours(now, 24).getTime();
        if (timePreset === '7d') from = subDays(now, 7).getTime();
        if (timePreset === '30d') from = subDays(now, 30).getTime();

        if (timePreset === 'custom') {
            if (customTimeFrom) from = startOfDay(new Date(customTimeFrom)).getTime();
            if (customTimeTo) to = endOfDay(new Date(customTimeTo)).getTime();
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return false;
        }

        return timestamp >= from && timestamp <= to;
    }, [customTimeFrom, customTimeTo, timePreset]);

    const evaluateAgentMatch = useCallback((agentId: string | null | undefined): boolean => {
        if (selectedAgentIds.size === 0) return true;
        const isSelected = !!agentId && selectedAgentIds.has(agentId);
        if (agentOperator === 'any_of') return isSelected;
        return !isSelected;
    }, [agentOperator, selectedAgentIds]);

    const evaluateTagMatch = useCallback((tags: string[] | null | undefined): boolean => {
        if (selectedFilterTags.size === 0) return true;
        const messageTags = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
        const selectedTags = Array.from(selectedFilterTags).map((tag) => tag.toLowerCase());

        if (tagOperator === 'has_any') {
            return selectedTags.some((tag) => messageTags.has(tag));
        }
        if (tagOperator === 'has_all') {
            return selectedTags.every((tag) => messageTags.has(tag));
        }
        return selectedTags.every((tag) => !messageTags.has(tag));
    }, [selectedFilterTags, tagOperator]);
    const evaluateNodeTypeMatch = useCallback((nodeType: MessageNodeType): boolean => {
        if (selectedNodeTypes.size === 0) return true;
        return selectedNodeTypes.has(nodeType);
    }, [selectedNodeTypes]);

    const hasTimeFilter = useMemo(() => {
        if (timePreset === 'all') return false;
        if (timePreset !== 'custom') return true;
        return !!customTimeFrom || !!customTimeTo;
    }, [customTimeFrom, customTimeTo, timePreset]);

    const hasNodeTypeFilter = selectedNodeTypes.size > 0;
    const hasAgentFilter = selectedAgentIds.size > 0;
    const hasTagFilter = selectedFilterTags.size > 0;
    const activeFilterCount =
        Number(hasTimeFilter) +
        Number(hasNodeTypeFilter) +
        Number(hasAgentFilter) +
        Number(hasTagFilter);
    const messageNodeCount = messages.length;

    // Calculate filter state and matching IDs
    const { filterActive, matchingMessageIds } = useMemo(() => {
        const isActive = activeFilterCount > 0;
        const matchingIds = new Set<string>();

        messages.forEach((msg: Message) => {
            if (!isActive) {
                matchingIds.add(msg.id);
                return;
            }

            const clauseResults: boolean[] = [];
            if (hasTimeFilter) clauseResults.push(evaluateTimeMatch(msg.createdAt));
            if (hasNodeTypeFilter) clauseResults.push(evaluateNodeTypeMatch(nodeTypeByMessageId.get(msg.id) ?? 'assistant_message'));
            if (hasAgentFilter) clauseResults.push(evaluateAgentMatch(msg.agent_id));
            if (hasTagFilter) clauseResults.push(evaluateTagMatch(msg.tags));

            if (clauseResults.length === 0) {
                matchingIds.add(msg.id);
                return;
            }

            const isMatch = groupOperator === 'and'
                ? clauseResults.every(Boolean)
                : clauseResults.some(Boolean);

            if (isMatch) matchingIds.add(msg.id);
        });

        return { filterActive: isActive, matchingMessageIds: matchingIds };
    }, [
        activeFilterCount,
        evaluateAgentMatch,
        evaluateNodeTypeMatch,
        evaluateTagMatch,
        evaluateTimeMatch,
        groupOperator,
        hasAgentFilter,
        hasNodeTypeFilter,
        hasTagFilter,
        hasTimeFilter,
        messages,
        nodeTypeByMessageId,
    ]);

    useEffect(() => {
        writePersistedGraphFilterState(persistedStorageKey, {
            timePreset,
            customTimeFrom,
            customTimeTo,
            selectedAgentIds: Array.from(selectedAgentIds),
            selectedFilterTags: Array.from(selectedFilterTags),
            selectedNodeTypes: Array.from(selectedNodeTypes),
            agentOperator,
            tagOperator,
            groupOperator,
            keepAncestors,
            keepDescendants,
        });
    }, [
        agentOperator,
        customTimeFrom,
        customTimeTo,
        groupOperator,
        keepAncestors,
        keepDescendants,
        persistedStorageKey,
        selectedAgentIds,
        selectedFilterTags,
        selectedNodeTypes,
        tagOperator,
        timePreset,
    ]);

    // Handlers
    const handleAgentFilterChange = useCallback((agentId: string, checked: boolean) => {
        setSelectedAgentIds((prev: Set<string>) => {
            const next = new Set(prev);
            if (checked) {
                next.add(agentId);
            } else {
                next.delete(agentId);
            }
            return next;
        });
    }, []);

    const handleTagFilterChange = useCallback((tag: string, checked: boolean) => {
        setSelectedFilterTags((prev: Set<string>) => {
            const next = new Set(prev);
            if (checked) {
                next.add(tag);
            } else {
                next.delete(tag);
            }
            return next;
        });
    }, []);
    const handleNodeTypeFilterChange = useCallback((nodeType: MessageNodeType, checked: boolean) => {
        setSelectedNodeTypes((prev: Set<MessageNodeType>) => {
            const next = new Set(prev);
            if (checked) {
                next.add(nodeType);
            } else {
                next.delete(nodeType);
            }
            return next;
        });
    }, []);

    const handleClearTagFilters = useCallback(() => {
        setSelectedFilterTags(new Set());
    }, []);

    const handleClearAllFilters = useCallback(() => {
        setTimePreset('all');
        setCustomTimeFrom('');
        setCustomTimeTo('');
        setSelectedAgentIds(new Set());
        setSelectedFilterTags(new Set());
        setSelectedNodeTypes(new Set());
        setAgentOperator('any_of');
        setTagOperator('has_any');
        setGroupOperator('and');
        setKeepAncestors(true);
        setKeepDescendants(true);
    }, []);

    // UI helper
    const filterButtonText = filterActive
        ? `Filters (${activeFilterCount})`
        : 'Filters';

    return {
        uniqueTags,
        uniqueAgentIds,
        timePreset,
        customTimeFrom,
        customTimeTo,
        selectedAgentIds,
        selectedFilterTags,
        selectedNodeTypes,
        agentOperator,
        tagOperator,
        groupOperator,
        keepAncestors,
        keepDescendants,
        filterActive,
        hasNodeTypeFilter,
        matchingMessageIds,
        setTimePreset,
        setCustomTimeFrom,
        setCustomTimeTo,
        handleAgentFilterChange,
        handleTagFilterChange,
        handleNodeTypeFilterChange,
        setAgentOperator,
        setTagOperator,
        setGroupOperator,
        setKeepAncestors,
        setKeepDescendants,
        handleClearTagFilters,
        handleClearAllFilters,
        filterButtonText,
        activeFilterCount,
        matchingCount: matchingMessageIds.size,
        messageNodeCount,
        nodeTypeCounts,
    };
}
