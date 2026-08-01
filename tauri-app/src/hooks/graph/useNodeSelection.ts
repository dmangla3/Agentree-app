import { useState, useCallback, useMemo, useRef } from 'react';
import { Node } from '@xyflow/react';
import { Message } from '../../stores/workspaceStore';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface UseNodeSelectionResult {
    // Selection state
    selectedNodeIds: Set<string>;

    // Action menu state
    showActionMenu: boolean;
    actionMenuPosition: { x: number; y: number };
    selectedCount: number;
    canViewDiff: boolean;
    canGenerateSummary: boolean;
    canMerge: boolean;
    isSelectionGestureActive: boolean;

    // Summary dialog state
    isSummaryDialogOpen: boolean;
    summarySelectionStart: string | null;
    summarySelectionEnd: string | null;

    // Handlers
    onSelectionChange: (params: { nodes: Node[] }) => void;
    onSelectionStart: () => void;
    onSelectionEnd: () => void;
    replaceSelection: (messageIds: Iterable<string>, nodes?: Node[]) => void;
    toggleSelection: (messageId: string, multi: boolean, node?: Node | null) => void;
    handleSummarize: () => void;
    handleMerge: () => void;
    closeSummaryDialog: () => void;
    clearSelection: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════

export function useNodeSelection(messages: Message[]): UseNodeSelectionResult {
    const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
    const [isSelectionGestureActive, setIsSelectionGestureActive] = useState(false);
    const selectionGestureActiveRef = useRef(false);
    const draftSelectionIdsRef = useRef<string[]>([]);
    const draftSelectedNodesRef = useRef<Node[]>([]);

    // Action menu state (floating menu)
    const [showActionMenu, setShowActionMenu] = useState(false);
    const [actionMenuPosition, setActionMenuPosition] = useState({ x: 0, y: 0 });

    // Summary dialog state
    const [isSummaryDialogOpen, setIsSummaryDialogOpen] = useState(false);
    const [summarySelectionStart, setSummarySelectionStart] = useState<string | null>(null);
    const [summarySelectionEnd, setSummarySelectionEnd] = useState<string | null>(null);

    const selectedNodeIds = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds]);
    const selectedCount = selectedNodeIds.size;
    const selectedIdsArray = useMemo(() => Array.from(selectedNodeIds), [selectedNodeIds]);

    const getLinearSelection = useCallback(() => {
        if (selectedIdsArray.length < 2) return { isLinear: false, sortedIds: [] as string[] };
        const selectedMessages = selectedIdsArray
            .map((id) => messages.find((m) => m.id === id))
            .filter((m): m is Message => !!m);
        if (selectedMessages.length !== selectedIdsArray.length) return { isLinear: false, sortedIds: [] };

        const sorted = [...selectedMessages].sort((a, b) => {
            if (a.depth !== null && b.depth !== null && a.depth !== undefined && b.depth !== undefined) {
                return (a.depth ?? 0) - (b.depth ?? 0);
            }
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        const newestNodeId = sorted[sorted.length - 1]?.id;
        let currentId: string | null = newestNodeId ?? null;
        const ancestorIds = new Set<string>();

        while (currentId) {
            ancestorIds.add(currentId);
            const msg = messages.find((m) => m.id === currentId);
            currentId = msg?.parentId ?? null;
        }

        const allOnSameBranch = sorted.every((node) => ancestorIds.has(node.id));
        return { isLinear: allOnSameBranch, sortedIds: sorted.map((m) => m.id) };
    }, [messages, selectedIdsArray]);

    const linearSelection = useMemo(() => getLinearSelection(), [getLinearSelection]);
    const canViewDiff = selectedCount === 2;
    const canGenerateSummary = selectedCount >= 2 && linearSelection.isLinear;
    const canMerge = selectedCount >= 2;

    // Handle ReactFlow selection change
    const updateActionMenu = useCallback((selectedNodes: Node[]) => {
        if (selectedNodes.length >= 1) {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (const node of selectedNodes) {
                const width = node.width || 80;
                const height = node.height || 60;

                minX = Math.min(minX, node.position.x);
                minY = Math.min(minY, node.position.y);
                maxX = Math.max(maxX, node.position.x + width);
                maxY = Math.max(maxY, node.position.y + height);
            }

            const viewportTop = 60;
            const menuY = minY > viewportTop + 50 ? minY - 10 : maxY + 10;
            setActionMenuPosition({
                x: (minX + maxX) / 2,
                y: menuY,
            });
            setShowActionMenu(true);
            return;
        }

        setShowActionMenu(false);
    }, []);

    const extractSelectionId = useCallback((node: Node): string | null => {
        const data = node.data as any;
        if (data?.entity?.messageId) return data.entity.messageId;
        if (data?.entity?.summary?.id) return data.entity.summary.id;
        return null;
    }, []);

    const areSelectionsEqual = useCallback((left: string[], right: string[]) => {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }, []);

    const normalizeSelectionIds = useCallback((messageIds: Iterable<string>) => {
        const unique = Array.from(new Set(messageIds));
        unique.sort();
        return unique;
    }, []);

    const commitSelection = useCallback((messageIds: Iterable<string>, nodes: Node[] = []) => {
        const normalizedIds = normalizeSelectionIds(messageIds);
        setSelectedMessageIds((previous) => areSelectionsEqual(previous, normalizedIds) ? previous : normalizedIds);
        updateActionMenu(nodes);
    }, [areSelectionsEqual, normalizeSelectionIds, updateActionMenu]);

    const replaceSelection = useCallback((messageIds: Iterable<string>, nodes: Node[] = []) => {
        commitSelection(messageIds, nodes);
    }, [commitSelection]);

    const toggleSelection = useCallback((messageId: string, multi: boolean, node?: Node | null) => {
        const selectedNodes = node ? [node] : [];
        setSelectedMessageIds((previous) => {
            const nextIds = new Set(previous);
            if (multi) {
                if (nextIds.has(messageId)) {
                    nextIds.delete(messageId);
                } else {
                    nextIds.add(messageId);
                }
            } else {
                nextIds.clear();
                nextIds.add(messageId);
            }

            const normalizedIds = normalizeSelectionIds(nextIds);
            return areSelectionsEqual(previous, normalizedIds) ? previous : normalizedIds;
        });
        updateActionMenu(selectedNodes);
    }, [areSelectionsEqual, normalizeSelectionIds, updateActionMenu]);

    const onSelectionChange = useCallback(({ nodes }: { nodes: Node[] }) => {
        const selectedLlmNodes = nodes.filter((node) => (
            node.type === 'user_message' ||
            node.type === 'assistant_message' ||
            node.type === 'commit_message' ||
            node.type === 'summary_block'
        ));
        const llmNodeIds = selectedLlmNodes
            .map((node) => extractSelectionId(node))
            .filter((id): id is string => !!id);

        if (selectionGestureActiveRef.current) {
            draftSelectionIdsRef.current = normalizeSelectionIds(llmNodeIds);
            draftSelectedNodesRef.current = selectedLlmNodes;
            return;
        }

        replaceSelection(llmNodeIds, selectedLlmNodes);
    }, [extractSelectionId, normalizeSelectionIds, replaceSelection]);

    const onSelectionStart = useCallback(() => {
        selectionGestureActiveRef.current = true;
        setIsSelectionGestureActive(true);
        draftSelectionIdsRef.current = selectedIdsArray;
        draftSelectedNodesRef.current = [];
    }, [selectedIdsArray]);

    const onSelectionEnd = useCallback(() => {
        selectionGestureActiveRef.current = false;
        setIsSelectionGestureActive(false);
        replaceSelection(draftSelectionIdsRef.current, draftSelectedNodesRef.current);
    }, [replaceSelection]);

    // Handle summarize button click
    const handleSummarize = useCallback(() => {
        const { isLinear, sortedIds } = getLinearSelection();
        if (isLinear && sortedIds.length >= 2) {
            let startId = sortedIds[0];
            const endId = sortedIds[sortedIds.length - 1];

            // Check if start node is an assistant message and include its parent (User message)
            const startMsg = messages.find(m => m.id === startId);
            if (startMsg && startMsg.role === 'assistant' && startMsg.parentId) {
                if (import.meta.env.DEV) {
                    console.log(`[useNodeSelection] Start node is assistant. Including parent: ${startMsg.parentId}`);
                }
                startId = startMsg.parentId;
            }

            setSummarySelectionStart(startId);
            setSummarySelectionEnd(endId);
            setIsSummaryDialogOpen(true);
            setShowActionMenu(false);
            setSelectedMessageIds([]);
        }
    }, [getLinearSelection, messages]);

    // Handle merge button click
    const handleMerge = useCallback(() => {
        // Return selected IDs for merge - the IntegrationWorkspace will be opened by the component
        setShowActionMenu(false);
    }, []);

    // Close summary dialog
    const closeSummaryDialog = useCallback(() => {
        setIsSummaryDialogOpen(false);
        setSummarySelectionStart(null);
        setSummarySelectionEnd(null);
    }, []);

    // Clear selection (properly triggers state update instead of direct mutation)
    const clearSelection = useCallback(() => {
        selectionGestureActiveRef.current = false;
        setIsSelectionGestureActive(false);
        draftSelectionIdsRef.current = [];
        draftSelectedNodesRef.current = [];
        setSelectedMessageIds([]);
        setShowActionMenu(false);
    }, []);

    return {
        selectedNodeIds,
        showActionMenu,
        actionMenuPosition,
        selectedCount,
        canViewDiff,
        canGenerateSummary,
        canMerge,
        isSelectionGestureActive,
        isSummaryDialogOpen,
        summarySelectionStart,
        summarySelectionEnd,
        onSelectionChange,
        onSelectionStart,
        onSelectionEnd,
        replaceSelection,
        toggleSelection,
        handleSummarize,
        handleMerge,
        closeSummaryDialog,
        clearSelection,
    };
}
