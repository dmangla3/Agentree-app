import type { Message } from '../stores/workspaceStore';
import { reconstructContext } from './contextUtils';
import { isFirstClassCommitMessage } from './graph/turnUtils';
import { buildArtifactContextText, getMessageArtifacts, type ArtifactRef } from './artifacts';

export type ComposerContextEntryKind = 'user' | 'assistant' | 'tool' | 'artifact';

export interface ComposerContextEntry {
    id: string;
    turnId: string;
    turnIndex: number;
    kind: ComposerContextEntryKind;
    label: string;
    summary: string;
    content: string;
    tokens: number;
    defaultSelected: boolean;
    createdAt: string;
    artifacts?: ArtifactRef[];
}

export interface ComposerContextTurn {
    id: string;
    index: number;
    entries: ComposerContextEntry[];
}

export interface ComposerContextSelection {
    turns: ComposerContextTurn[];
    entries: ComposerContextEntry[];
    defaultSelectedIds: string[];
    defaultSelectedTokenEstimate: number;
}

export interface ComposerContextManifestBlock {
    id: string;
    turnIndex: number;
    kind: ComposerContextEntryKind;
    volatile: boolean;
    content: string;
    tokens: number;
    artifacts?: ArtifactRef[];
}

export interface ComposerContextManifest {
    version: 'v1';
    blocks: ComposerContextManifestBlock[];
    stableBlocks: ComposerContextManifestBlock[];
    volatileBlocks: ComposerContextManifestBlock[];
    stablePrefixText: string;
    volatileTailText: string;
    contextText: string;
    artifactInputs: ArtifactRef[];
    manifestHash: string;
    stablePrefixHash: string;
    volatileTailHash: string;
}

export interface ComposerContextPathParams {
    parentId: string | null;
    messages: Message[];
    contextParentId?: string | null;
    contextPolicy?: 'continue' | 'fresh';
    contextStartId?: string | null;
}

const estimateTokens = (text: string) => Math.ceil((text || '').length / 4);
const DEFAULT_TOOL_CONTEXT_TOKEN_BUDGET = 8000;
const DEFAULT_TOOL_CONTEXT_MAX_ENTRY_TOKENS = 6000;

const normalizeText = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();

const truncateText = (value: string, maxLength: number) =>
    value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : value;

const normalizePromptText = (value: string) => (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripVolatileToolFields = (value: string) => (value || '')
    .split('\n')
    .filter((line) => !/^Duration:\s*\d+ms$/i.test(line.trim()))
    .join('\n')
    .trim();

const fnv1aHash = (input: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

const computeContextActivityMap = (ancestors: Message[]): Map<string, boolean> => {
    const activityById = new Map<string, boolean>();
    const assistantByParentId = new Map<string, Message>();
    const inactiveAssistantIds = new Set<string>();

    for (const message of ancestors) {
        if (message.role !== 'assistant') continue;
        if (message.parentId) assistantByParentId.set(message.parentId, message);
        if (message.context_active === false) inactiveAssistantIds.add(message.id);
    }

    for (const message of ancestors) {
        let isActive = message.context_active !== false;
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

const buildComposerContextMessages = ({
    parentId,
    messages,
    contextParentId = null,
    contextPolicy = 'continue',
    contextStartId = null,
}: ComposerContextPathParams): Message[] => {
    if (!parentId || contextPolicy === 'fresh') return [];

    const primaryAncestors = reconstructContext(parentId, messages);
    const contextAncestors = contextParentId && contextParentId !== parentId
        ? reconstructContext(contextParentId, messages)
        : [];
    const seenAncestorIds = new Set<string>();
    const ancestors = [...contextAncestors, ...primaryAncestors].filter((message) => {
        if (seenAncestorIds.has(message.id)) return false;
        seenAncestorIds.add(message.id);
        return true;
    });
    if (!ancestors.length) return [];

    const startIndex = contextStartId
        ? ancestors.findIndex((message) => message.id === contextStartId)
        : -1;
    const rangedAncestors = startIndex >= 0
        ? ancestors.slice(startIndex)
        : ancestors;
    const messageMap = new Map(messages.map((message) => [message.id, message]));
    return rangedAncestors.filter((message) => !isFirstClassCommitMessage(message, { messageMap }));
};

export function buildComposerContextPathIds(params: ComposerContextPathParams): Set<string> {
    const contextMessages = buildComposerContextMessages(params);
    const activityById = computeContextActivityMap(contextMessages);
    return new Set(
        contextMessages
            .filter((message) => activityById.get(message.id) === true)
            .map((message) => message.id)
    );
}

const getTimelineEvents = (message: Message): any[] => {
    const timeline = (message.execution_data as { timeline?: any[] } | null | undefined)?.timeline;
    return Array.isArray(timeline) ? timeline : [];
};

const extractToolName = (event: any): string => event?.toolName || event?.tool || event?.tool_name || event?.name || 'tool';

const extractToolInput = (event: any): unknown =>
    event?.toolInput ?? event?.input ?? event?.tool_input ?? event?.parameters ?? undefined;

const extractToolOutput = (event: any): unknown =>
    event?.toolOutput ?? event?.output ?? event?.tool_output ?? event?.result ?? event?.content ?? event?.message ?? event?.error ?? undefined;

const formatPayload = (value: unknown): string => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

type MergedToolEvent = {
    toolName: string;
    input?: unknown;
    output?: unknown;
    durationMs?: number;
    isError?: boolean;
};

const mergeTimelineToolEvents = (events: any[]): MergedToolEvent[] => {
    const merged = new Map<string, MergedToolEvent>();
    let fallbackIndex = 0;

    for (const event of events) {
        if (!event) continue;
        const toolName = extractToolName(event);
        const key = event?.toolUseId || event?.tool_use_id || event?.id || `${toolName}:${fallbackIndex++}`;
        const current = merged.get(key) || { toolName };

        if (event.type === 'tool_use') {
            const input = extractToolInput(event);
            if (input !== undefined) current.input = input;
        }

        if (event.type === 'tool_result' || event.type === 'tool_error') {
            const output = extractToolOutput(event);
            if (output !== undefined) current.output = output;
            if (event?.durationMs || event?.duration_ms) {
                current.durationMs = Number(event.durationMs ?? event.duration_ms);
            }
            if (event.type === 'tool_error' || event?.isError || event?.error) {
                current.isError = true;
            }
        }

        merged.set(key, current);
    }

    return Array.from(merged.values());
};

const formatToolContext = (event: MergedToolEvent): string => {
    const toolName = event.toolName;
    const input = formatPayload(event.input);
    const output = formatPayload(event.output);
    const parts = [`Tool: ${toolName}`];

    if (input) parts.push(`Input:\n${input}`);
    if (output) parts.push(`Output:\n${output}`);
    if (event.durationMs) {
        parts.push(`Duration: ${event.durationMs}ms`);
    }
    if (event.isError) {
        parts.push('Status: error');
    }

    return parts.join('\n\n');
};

const formatCombinedToolContext = (events: any[]): { summary: string; content: string } | null => {
    const mergedEvents = mergeTimelineToolEvents(events);
    if (!mergedEvents.length) return null;

    const uniqueToolNames = Array.from(new Set(mergedEvents.map((event) => event.toolName)));
    const summary = uniqueToolNames.length > 0
        ? truncateText(uniqueToolNames.join(', '), 96)
        : `${mergedEvents.length} tool calls`;
    const content = mergedEvents
        .map((event) => formatToolContext(event))
        .join('\n\n');

    return {
        summary: `${mergedEvents.length} tool call${mergedEvents.length === 1 ? '' : 's'}${summary ? `: ${summary}` : ''}`,
        content,
    };
};

const messageIdFromEntryId = (entryId: string): string => {
    const suffixIndex = entryId.lastIndexOf(':');
    return suffixIndex >= 0 ? entryId.slice(0, suffixIndex) : entryId;
};

const selectRecentToolContextByDefault = (
    entries: ComposerContextEntry[],
    activityById: Map<string, boolean>
) => {
    let selectedToolTokens = 0;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.kind !== 'tool') continue;
        if (activityById.get(messageIdFromEntryId(entry.id)) !== true) continue;
        if (entry.tokens > DEFAULT_TOOL_CONTEXT_MAX_ENTRY_TOKENS) continue;
        if (selectedToolTokens + entry.tokens > DEFAULT_TOOL_CONTEXT_TOKEN_BUDGET) continue;

        entry.defaultSelected = true;
        selectedToolTokens += entry.tokens;
    }
};

export function buildComposerContextSelection(
    parentId: string | null,
    messages: Message[],
    contextParentId: string | null = null,
    contextPolicy: 'continue' | 'fresh' = 'continue',
    contextStartId: string | null = null
): ComposerContextSelection {
    if (!parentId || contextPolicy === 'fresh') {
        return { turns: [], entries: [], defaultSelectedIds: [], defaultSelectedTokenEstimate: 0 };
    }

    const contextMessages = buildComposerContextMessages({
        parentId,
        messages,
        contextParentId,
        contextPolicy,
        contextStartId,
    });
    if (!contextMessages.length) {
        return { turns: [], entries: [], defaultSelectedIds: [], defaultSelectedTokenEstimate: 0 };
    }
    const activityById = computeContextActivityMap(contextMessages);
    const turns: ComposerContextTurn[] = [];
    let currentTurn: ComposerContextTurn | null = null;
    let turnIndex = 0;

    const pushEntry = (
        message: Message,
        kind: ComposerContextEntryKind,
        summary: string,
        content: string,
        suffix: string,
        artifacts?: ArtifactRef[],
    ) => {
        if (!currentTurn) {
            turnIndex += 1;
            currentTurn = {
                id: `turn:${message.id}`,
                index: turnIndex,
                entries: [],
            };
            turns.push(currentTurn);
        }

        const normalizedSummary = truncateText(normalizeText(summary) || `${kind} context`, 96);
        const tokens = estimateTokens(content);
        currentTurn.entries.push({
            id: `${message.id}:${suffix}`,
            turnId: currentTurn.id,
            turnIndex: currentTurn.index,
            kind,
            label: kind === 'tool' ? 'Execution timeline' : kind === 'artifact' ? 'Artifacts' : kind,
            summary: normalizedSummary,
            content,
            tokens,
            defaultSelected: kind === 'tool' ? false : activityById.get(message.id) === true,
            createdAt: message.createdAt,
            ...(artifacts?.length ? { artifacts } : {}),
        });
    };

    for (const message of contextMessages) {
        if (message.role === 'user' || !currentTurn) {
            turnIndex += 1;
            currentTurn = {
                id: `turn:${message.id}`,
                index: turnIndex,
                entries: [],
            };
            turns.push(currentTurn);
        }

        const messageContent = (message.role === 'user'
            ? message.processedContent
            : message.processedContent ?? message.content) || message.content || '';
        const summarySource = message.aiLabel || messageContent || `${message.role} message`;

        if (message.role === 'user') {
            pushEntry(message, 'user', summarySource, messageContent, 'user');
            const inputArtifacts = getMessageArtifacts(message, {
                includeAttachments: true,
                role: 'input',
            });
            const artifactContext = buildArtifactContextText(inputArtifacts);
            if (artifactContext) {
                pushEntry(message, 'artifact', 'Uploaded files', artifactContext, 'artifact', inputArtifacts);
            }
            continue;
        }

        pushEntry(message, 'assistant', summarySource, messageContent, 'assistant');

        const assistantArtifacts = getMessageArtifacts(message, {
            includeAttachments: false,
            role: 'output',
        }).filter((artifact) => artifact.role === 'output');
        const assistantArtifactContext = buildArtifactContextText(assistantArtifacts);
        if (assistantArtifactContext) {
            pushEntry(message, 'artifact', 'Output previews', assistantArtifactContext, 'artifact', assistantArtifacts);
        }

        const timelineEvents = getTimelineEvents(message).filter((event) =>
            event?.type === 'tool_use' || event?.type === 'tool_result' || event?.type === 'tool_error'
        );

        const combinedToolContext = formatCombinedToolContext(timelineEvents);
        if (combinedToolContext) {
            pushEntry(
                message,
                'tool',
                combinedToolContext.summary,
                combinedToolContext.content,
                'tool'
            );
        }
    }

    const entries = turns.flatMap((turn) => turn.entries);
    selectRecentToolContextByDefault(entries, activityById);
    const defaultSelectedIds = entries.filter((entry) => entry.defaultSelected).map((entry) => entry.id);
    const defaultSelectedTokenEstimate = entries
        .filter((entry) => entry.defaultSelected)
        .reduce((sum, entry) => sum + entry.tokens, 0);

    return {
        turns: turns.filter((turn) => turn.entries.length > 0),
        entries,
        defaultSelectedIds,
        defaultSelectedTokenEstimate,
    };
}

export function buildComposerContextManifest(
    turns: ComposerContextTurn[],
    selectedIds: Set<string>
): ComposerContextManifest {
    const selectedTurns = turns
        .map((turn) => ({
            ...turn,
            entries: turn.entries.filter((entry) => selectedIds.has(entry.id)),
        }))
        .filter((turn) => turn.entries.length > 0);

    if (selectedTurns.length === 0) {
        const empty = '';
        return {
            version: 'v1',
            blocks: [],
            stableBlocks: [],
            volatileBlocks: [],
            stablePrefixText: empty,
            volatileTailText: empty,
            contextText: empty,
            artifactInputs: [],
            manifestHash: fnv1aHash(empty),
            stablePrefixHash: fnv1aHash(empty),
            volatileTailHash: fnv1aHash(empty),
        };
    }

    const blocks: ComposerContextManifestBlock[] = [];
    for (const turn of selectedTurns) {
        for (const entry of turn.entries) {
            const normalizedContent = entry.kind === 'tool'
                ? stripVolatileToolFields(normalizePromptText(entry.content))
                : normalizePromptText(entry.content);
            if (!normalizedContent) continue;
            blocks.push({
                id: entry.id,
                turnIndex: turn.index,
                kind: entry.kind,
                volatile: entry.kind === 'tool' || entry.kind === 'artifact',
                content: normalizedContent,
                tokens: estimateTokens(normalizedContent),
                ...(entry.artifacts?.length ? { artifacts: entry.artifacts } : {}),
            });
        }
    }

    const artifactInputs = Array.from(
        blocks
            .flatMap((block) => block.artifacts ?? [])
            .reduce((map, artifact) => map.set(artifact.id, artifact), new Map<string, ArtifactRef>())
            .values()
    );

    const serializeBlock = (block: ComposerContextManifestBlock) => {
        const label = block.kind === 'tool'
            ? 'EXECUTION TIMELINE'
            : block.kind === 'artifact'
                ? 'ARTIFACTS'
                : block.kind.toUpperCase();
        return `[Turn ${block.turnIndex}] ${label} (${block.id})\n${block.content}`;
    };

    const stableBlocks = blocks.filter((block) => !block.volatile);
    const volatileBlocks = blocks.filter((block) => block.volatile);
    const stablePrefixText = stableBlocks.map(serializeBlock).join('\n\n---\n\n');
    const volatileTailText = volatileBlocks.map(serializeBlock).join('\n\n---\n\n');
    const contextParts = [];
    if (stablePrefixText) {
        contextParts.push(`[Context: Stable Prefix]\n${stablePrefixText}`);
    }
    if (volatileTailText) {
        contextParts.push(`[Context: Volatile Tail]\n${volatileTailText}`);
    }
    const contextText = contextParts.join('\n\n');
    const manifestCanonical = JSON.stringify({
        version: 'v1',
        blocks: blocks.map((block) => ({
            id: block.id,
            turnIndex: block.turnIndex,
            kind: block.kind,
            volatile: block.volatile,
            content: block.content,
            artifacts: block.artifacts?.map((artifact) => ({
                id: artifact.id,
                role: artifact.role,
                kind: artifact.kind,
                mimeType: artifact.mimeType,
                storage: artifact.storage,
                thumbnail: artifact.thumbnail,
            })),
        })),
    });

    return {
        version: 'v1',
        blocks,
        stableBlocks,
        volatileBlocks,
        stablePrefixText,
        volatileTailText,
        contextText,
        artifactInputs,
        manifestHash: fnv1aHash(manifestCanonical),
        stablePrefixHash: fnv1aHash(stablePrefixText),
        volatileTailHash: fnv1aHash(volatileTailText),
    };
}
