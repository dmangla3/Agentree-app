import type { AgentStatus } from '@shared/agentStatus';
import type { Message, Scope, Summary } from '../stores/workspaceStore';
import { getGraphParentId } from '../lib/graph/lineage';
import { isRedundantCommitNode } from '../lib/graph/turnUtils';
import { resolveNodeState } from '../lib/runStateResolver';
import { buildScopedFocusRoute, isImportedGitMessage, type ScopedFocusRoute } from './scopedFocusRoute';
import {
  CanonicalNodeEntity,
  ExternalCommitBatch,
  buildExternalCommitBatches,
  classifyMessageNodeKind,
  getCommitSha,
  getAssistantCommitCount,
  getCommitParentShas,
  getMessageEntityId,
  getNodePreview,
  getSummaryEntityId,
  getToolCallCount,
  getTurnFocusMessageId,
  getTurnGroupIdForMessage,
  isManualCommitBatch,
} from './nodes';

export interface ProjectedNodeEntity extends CanonicalNodeEntity {
  message?: Message;
  summary?: Summary;
  preview: string;
  shortLabel: string;
  shortSha?: string | null;
  status?: AgentStatus | null;
  toolCallCount?: number;
  totalTokens?: number | null;
  commitCount?: number;
  authorName?: string | null;
  authoredAt?: string | null;
  importedFromRef?: string | null;
  parentShas?: string[];
  scopeId?: string | null;
}

export interface ProjectedTurnGroup {
  turnGroupId: string;
  userMessageId: string;
  userEntityId: string;
  assistantMessageIds: string[];
  assistantEntityIds: string[];
  memberEntityIds: string[];
  canonicalFocusMessageId: string;
  sortTs: number;
}

export interface ProjectedExternalCommitBatch {
  batchId: string;
  batch: ExternalCommitBatch;
  entityId: string;
  representativeMessageId: string;
  representativeEntityId: string;
  messageIds: string[];
  entityIds: string[];
  importedFromRef: string | null;
  title: string;
  sourceKind: 'external' | 'manual';
  commitCount: number;
  sortTs: number;
}

export type ProjectedTimelineItem =
  | { type: 'entity'; entityId: string; sortTs: number }
  | { type: 'external_commit_batch'; batchId: string; sortTs: number };

export type ProjectedChatItem =
  | {
      type: 'turn';
      turnGroupId: string;
      userEntityId: string;
      assistantEntityIds: string[];
      commitEntityIdsByAssistantEntityId: Record<string, string[]>;
      sortTs: number;
    }
  | { type: 'turn_user_only'; userEntityId: string; sortTs: number }
  | { type: 'summary'; entityId: string; bypassedCount: number; sortTs: number }
  | { type: 'entity'; entityId: string; sortTs: number }
  | { type: 'external_commit_batch'; batchId: string; sortTs: number };

export interface WorkspaceProjection {
  messages: Message[];
  scopes: Scope[];
  summaries: Summary[];
  messageMap: Map<string, Message>;
  scopeColorById: Map<string, string | null>;
  scopeNameById: Map<string, string>;
  summaryMap: Map<string, Summary>;
  entities: ProjectedNodeEntity[];
  entitiesById: Map<string, ProjectedNodeEntity>;
  entitiesByMessageId: Map<string, ProjectedNodeEntity>;
  entitiesBySummaryId: Map<string, ProjectedNodeEntity>;
  childEntityIdsByParentEntityId: Map<string, string[]>;
  commitEntityIdsByAssistantEntityId: Map<string, string[]>;
  turnGroups: ProjectedTurnGroup[];
  turnGroupById: Map<string, ProjectedTurnGroup>;
  externalCommitBatches: ProjectedExternalCommitBatch[];
  externalCommitBatchById: Map<string, ProjectedExternalCommitBatch>;
  originMessage: Message | null;
  originMessageId: string | null;
  branchPathMessageIds: Set<string>;
  scopedFocusRoute: ScopedFocusRoute;
  timelineItems: ProjectedTimelineItem[];
  chatItems: ProjectedChatItem[];
}

interface BuildWorkspaceProjectionInput {
  messages: Message[];
  scopes?: Scope[];
  summaries: Summary[];
  focusedMessageId: string | null;
  disabledSummaryIds?: Set<string>;
}

interface StableWorkspaceProjectionBase {
  sortedMessages: Message[];
  sortedSummaries: Summary[];
  messageMap: Map<string, Message>;
  summaryMap: Map<string, Summary>;
  entities: ProjectedNodeEntity[];
  entitiesById: Map<string, ProjectedNodeEntity>;
  entitiesByMessageId: Map<string, ProjectedNodeEntity>;
  entitiesBySummaryId: Map<string, ProjectedNodeEntity>;
  childEntityIdsByParentEntityId: Map<string, string[]>;
  commitEntityIdsByAssistantEntityId: Map<string, string[]>;
  turnGroups: ProjectedTurnGroup[];
  turnGroupById: Map<string, ProjectedTurnGroup>;
  externalCommitBatches: ProjectedExternalCommitBatch[];
  externalCommitBatchById: Map<string, ProjectedExternalCommitBatch>;
  originMessage: Message | null;
  originMessageId: string | null;
  timelineItems: ProjectedTimelineItem[];
  agentCommitShas: Set<string>;
}

const byCreatedAt = (left: { createdAt: string }, right: { createdAt: string }) =>
  new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

const STABLE_BASE_CACHE_LIMIT = 6;
const stableBaseCache = new Map<string, StableWorkspaceProjectionBase>();

const getMessageFingerprint = (message: Message): string => {
  const branchPointers = Array.isArray(message.branchPointers)
    ? message.branchPointers.map((pointer) => pointer.id).join(',')
    : '';
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, unknown>;
  const syncSource = typeof meta.sync_source === 'string' ? meta.sync_source : '';
  const importedFromRef = typeof meta.imported_from_ref === 'string' ? meta.imported_from_ref : '';
  const commitCount = typeof meta.commit_count === 'number' ? meta.commit_count : '';
  const content = message.content ?? '';

  return [
    message.id,
    message.parentId ?? '',
    message.role,
    message.status ?? '',
    message.updatedAt ?? '',
    message.createdAt ?? '',
    message.base_commit_sha ?? '',
    message.output_commit_sha ?? '',
    message.base_selected_from_node_id ?? '',
    getCommitSha(message) ?? '',
    message.aiLabel ?? '',
    message.llmModel ?? '',
    message.agent_id ?? '',
    message.scope_id ?? '',
    content.length,
    content.slice(0, 24),
    content.slice(-24),
    syncSource,
    importedFromRef,
    commitCount,
    branchPointers,
  ].join('\u001f');
};

const getSummaryFingerprint = (summary: Summary): string => (
  [
    summary.id,
    summary.startMessageId,
    summary.endMessageId,
    summary.createdAt,
    summary.content.length,
    summary.content.slice(0, 24),
    summary.content.slice(-24),
  ].join('\u001f')
);

const getStableBaseCacheKey = (messages: Message[], summaries: Summary[]): string => (
  [
    'messages',
    messages.length,
    ...messages.map(getMessageFingerprint),
    'summaries',
    summaries.length,
    ...summaries.map(getSummaryFingerprint),
  ].join('\u001e')
);

const rememberStableBase = (cacheKey: string, base: StableWorkspaceProjectionBase) => {
  if (stableBaseCache.has(cacheKey)) {
    stableBaseCache.delete(cacheKey);
  }
  stableBaseCache.set(cacheKey, base);
  while (stableBaseCache.size > STABLE_BASE_CACHE_LIMIT) {
    const oldestKey = stableBaseCache.keys().next().value;
    if (!oldestKey) break;
    stableBaseCache.delete(oldestKey);
  }
};

const getOriginMessage = (messages: Message[]): Message | null => {
  if (messages.length === 0) return null;
  const welcomeRoot = messages.find((m) =>
    m.role === 'assistant' &&
    m.parentId === null &&
    (m.content || '').trim().startsWith('Welcome! How can I help you explore your ideas today?')
  );
  if (welcomeRoot) return welcomeRoot;
  const roots = messages.filter((m) => m.parentId === null).sort(byCreatedAt);
  if (roots.length > 0) return roots[0];
  return [...messages].sort(byCreatedAt)[0] ?? null;
};

const getSummaryBypassedCount = (
  summary: Summary,
  messageMap: Map<string, Message>
): number => {
  let count = 0;
  let currentId: string | null = summary.endMessageId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messageMap.get(currentId);
    if (!message) break;
    count += 1;
    if (currentId === summary.startMessageId) break;
    currentId = message.parentId;
  }

  return count;
};

const getSummaryTurnCoverageIndex = (
  summary: Summary,
  turnGroups: ProjectedTurnGroup[]
): number => {
  return turnGroups.findIndex((turn) =>
    turn.userMessageId === summary.endMessageId || turn.assistantMessageIds.includes(summary.endMessageId)
  );
};

const getProjectedMessageEntity = (
  message: Message,
  messages: Message[],
  messageMap: Map<string, Message>
): ProjectedNodeEntity => {
  const kind = classifyMessageNodeKind(message, messageMap);
  const graphParentId = getGraphParentId(message, messageMap);
  const graphParent = graphParentId ? messageMap.get(graphParentId) : null;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, any>;
  const metaCommits = Array.isArray(meta.commits) ? meta.commits : [];
  const lastMetaCommit = metaCommits[metaCommits.length - 1] || null;
  const outputCommitSha = getCommitSha(message);
  const shortSha = outputCommitSha ? outputCommitSha.slice(0, 8) : null;
  const shortLabel = kind === 'commit_message'
    ? (shortSha || 'Commit')
    : (message.aiLabel?.trim() || (message.llmModel?.split('/').pop() || (message.role === 'user' ? 'Prompt' : 'Assistant')));

  return {
    entityId: getMessageEntityId(message, messageMap),
    kind,
    messageId: message.id,
    focusMessageId: message.id,
    parentEntityId: graphParent ? getMessageEntityId(graphParent, messageMap) : undefined,
    turnGroupId: getTurnGroupIdForMessage(message, messageMap),
    sortTs: new Date(message.createdAt).getTime(),
    message,
    preview: getNodePreview(message),
    shortLabel,
    shortSha,
    status: resolveNodeState(message, null).status as AgentStatus | null ?? (message.agent_id ? 'pending' : null),
    toolCallCount: getToolCallCount(message),
    totalTokens: message.totalTokens ?? null,
    commitCount: typeof meta.commit_count === 'number' ? meta.commit_count : getAssistantCommitCount(message, messages, messageMap),
    authorName: typeof meta.git_author_name === 'string' ? meta.git_author_name : (typeof lastMetaCommit?.author_name === 'string' ? lastMetaCommit.author_name : null),
    authoredAt: typeof meta.git_authored_at === 'string' ? meta.git_authored_at : (typeof lastMetaCommit?.authored_at === 'string' ? lastMetaCommit.authored_at : null),
    importedFromRef: typeof meta.imported_from_ref === 'string' ? meta.imported_from_ref : null,
    parentShas: kind === 'commit_message' ? getCommitParentShas(message) : undefined,
    scopeId: message.scope_id ?? null,
  };
};

const isAgentMaterializedDuplicateExternalCommit = (
  message: Message,
  agentCommitShas: Set<string>
): boolean => {
  const meta = (((message.execution_data as any)?.meta || {}) as Record<string, any>);
  if (meta.sync_source !== 'external_git') return false;
  const commitSha = getCommitSha(message);
  return !!commitSha && agentCommitShas.has(commitSha);
};

const getDuplicateAgentCommitMessageIds = (
  messages: Message[],
  messageMap: Map<string, Message>
): Set<string> => {
  const childCountByMessageId = new Map<string, number>();
  messages.forEach((message) => {
    const parentId = getGraphParentId(message, messageMap);
    if (!parentId) return;
    childCountByMessageId.set(parentId, (childCountByMessageId.get(parentId) ?? 0) + 1);
  });
  const groups = new Map<string, Message[]>();

  messages.forEach((message) => {
    if (classifyMessageNodeKind(message, messageMap) !== 'commit_message') return;
    const meta = (((message.execution_data as any)?.meta || {}) as Record<string, any>);
    if (meta.sync_source === 'external_git') return;

    const commitSha = getCommitSha(message);
    if (!commitSha) return;

    const list = groups.get(commitSha) ?? [];
    list.push(message);
    groups.set(commitSha, list);
  });

  const duplicateIds = new Set<string>();
  groups.forEach((group) => {
    if (group.length <= 1) return;

    const canonical = [...group].sort((left, right) => {
      const childCountDiff = (childCountByMessageId.get(right.id) ?? 0) - (childCountByMessageId.get(left.id) ?? 0);
      if (childCountDiff !== 0) return childCountDiff;

      const leftTs = new Date(left.createdAt).getTime();
      const rightTs = new Date(right.createdAt).getTime();
      if (leftTs !== rightTs) return leftTs - rightTs;

      return left.id.localeCompare(right.id);
    })[0];

    group.forEach((message) => {
      if (message.id !== canonical.id) duplicateIds.add(message.id);
    });
  });

  return duplicateIds;
};

export function buildWorkspaceProjection({
  messages,
  scopes = [],
  summaries,
  focusedMessageId,
  disabledSummaryIds = new Set<string>(),
}: BuildWorkspaceProjectionInput): WorkspaceProjection {
  const base = getStableWorkspaceProjectionBase(messages, summaries);
  const {
    sortedMessages,
    sortedSummaries,
    messageMap,
    summaryMap,
    entities,
    entitiesById,
    entitiesByMessageId,
    entitiesBySummaryId,
    childEntityIdsByParentEntityId,
    commitEntityIdsByAssistantEntityId,
    turnGroups,
    turnGroupById,
    externalCommitBatches,
    externalCommitBatchById,
    originMessage,
    originMessageId,
    timelineItems,
    agentCommitShas,
  } = base;

  const scopedFocusRoute = buildScopedFocusRoute(messageMap, scopes, focusedMessageId);
  const scopeColorById = new Map(scopes.map((scope) => [scope.id, scope.color || null]));
  const scopeNameById = new Map(scopes.map((scope) => [scope.id, scope.name]));
  const branchPathMessageIds = new Set(scopedFocusRoute.messageIds);
  const branchTurnGroups = turnGroups.filter((group) => branchPathMessageIds.has(group.userMessageId));
  const pathMessages = scopedFocusRoute.messageIds
    .map((messageId) => messageMap.get(messageId))
    .filter((message): message is Message => Boolean(message));

  const chatItems: ProjectedChatItem[] = [];
  const coveredPathMessageIds = new Set<string>();

  let index = 0;
  while (index < branchTurnGroups.length) {
    const turnGroup = branchTurnGroups[index];
    const summariesStartingAtUser = sortedSummaries.filter((summary) => (
      !disabledSummaryIds.has(summary.id) && summary.startMessageId === turnGroup.userMessageId
    ));
    const firstAssistantId = turnGroup.assistantMessageIds[0] ?? null;
    const summariesStartingAtAssistant = firstAssistantId
      ? sortedSummaries.filter((summary) => !disabledSummaryIds.has(summary.id) && summary.startMessageId === firstAssistantId)
      : [];

    let bestSummary: Summary | null = null;
    let bestSummaryEndIndex = -1;
    let startAtAssistant = false;

    for (const summary of summariesStartingAtUser) {
      const endIndex = getSummaryTurnCoverageIndex(summary, branchTurnGroups);
      if (endIndex >= index && endIndex > bestSummaryEndIndex) {
        bestSummary = summary;
        bestSummaryEndIndex = endIndex;
        startAtAssistant = false;
      }
    }
    for (const summary of summariesStartingAtAssistant) {
      const endIndex = getSummaryTurnCoverageIndex(summary, branchTurnGroups);
      if (endIndex >= index && endIndex > bestSummaryEndIndex) {
        bestSummary = summary;
        bestSummaryEndIndex = endIndex;
        startAtAssistant = true;
      }
    }

    if (bestSummary && bestSummaryEndIndex >= index) {
      if (startAtAssistant) {
        chatItems.push({
          type: 'turn_user_only',
          userEntityId: turnGroup.userEntityId,
          sortTs: turnGroup.sortTs,
        });
        const userMessageId = entitiesById.get(turnGroup.userEntityId)?.messageId;
        if (userMessageId) coveredPathMessageIds.add(userMessageId);
      }
      const summaryEntity = entitiesBySummaryId.get(bestSummary.id);
      if (summaryEntity) {
        chatItems.push({
          type: 'summary',
          entityId: summaryEntity.entityId,
          bypassedCount: getSummaryBypassedCount(bestSummary, messageMap),
          sortTs: summaryEntity.sortTs,
        });
      }
      index = bestSummaryEndIndex + 1;
      continue;
    }

    const isFocusedUserTurn = focusedMessageId === turnGroup.userMessageId;
    const visibleAssistantEntityIds = turnGroup.assistantEntityIds.filter((assistantEntityId) => {
      const assistantMessageId = entitiesById.get(assistantEntityId)?.messageId;
      return !!assistantMessageId && branchPathMessageIds.has(assistantMessageId);
    });
    const visibleCommitEntityIdsByAssistantEntityId = Object.fromEntries(
      visibleAssistantEntityIds.map((assistantEntityId) => {
        const commitEntityIds = (commitEntityIdsByAssistantEntityId.get(assistantEntityId) ?? []).filter((commitEntityId) => {
          const commitMessageId = entitiesById.get(commitEntityId)?.messageId;
          return !!commitMessageId && branchPathMessageIds.has(commitMessageId);
        });
        return [assistantEntityId, commitEntityIds];
      })
    );

    const userMessageId = entitiesById.get(turnGroup.userEntityId)?.messageId;
    if (userMessageId) coveredPathMessageIds.add(userMessageId);

    if (isFocusedUserTurn || visibleAssistantEntityIds.length === 0) {
      chatItems.push({
        type: 'turn_user_only',
        userEntityId: turnGroup.userEntityId,
        sortTs: turnGroup.sortTs,
      });
      index += 1;
      continue;
    }

    visibleAssistantEntityIds.forEach((assistantEntityId) => {
      const assistantMessageId = entitiesById.get(assistantEntityId)?.messageId;
      if (assistantMessageId) coveredPathMessageIds.add(assistantMessageId);
      (visibleCommitEntityIdsByAssistantEntityId[assistantEntityId] ?? []).forEach((commitEntityId) => {
        const commitMessageId = entitiesById.get(commitEntityId)?.messageId;
        if (commitMessageId) coveredPathMessageIds.add(commitMessageId);
      });
    });

    chatItems.push({
      type: 'turn',
      turnGroupId: turnGroup.turnGroupId,
      userEntityId: turnGroup.userEntityId,
      assistantEntityIds: visibleAssistantEntityIds,
      commitEntityIdsByAssistantEntityId: visibleCommitEntityIdsByAssistantEntityId,
      sortTs: turnGroup.sortTs,
    });
    index += 1;
  }

  const assistantOnlyPathMessages = pathMessages.filter((message) => (
    message.role === 'assistant' &&
    !coveredPathMessageIds.has(message.id) &&
    !isAgentMaterializedDuplicateExternalCommit(message, agentCommitShas)
  ));
  const assistantOnlyPathBatches = new Map<string, Message[]>();
  for (const message of assistantOnlyPathMessages) {
    const batch = externalCommitBatches.find((candidate) => candidate.messageIds.includes(message.id));
    if (!batch) {
      chatItems.push({
        type: 'entity',
        entityId: getMessageEntityId(message, messageMap),
        sortTs: new Date(message.createdAt).getTime(),
      });
      continue;
    }
    const list = assistantOnlyPathBatches.get(batch.batchId) ?? [];
    list.push(message);
    assistantOnlyPathBatches.set(batch.batchId, list);
  }
  for (const batchId of assistantOnlyPathBatches.keys()) {
    const batch = externalCommitBatchById.get(batchId);
    if (!batch) continue;
    chatItems.push({
      type: 'external_commit_batch',
      batchId,
      sortTs: batch.sortTs,
    });
  }

  const focusedMessage = focusedMessageId ? messageMap.get(focusedMessageId) ?? null : null;
  if (focusedMessage && isImportedGitMessage(focusedMessage)) {
    const focusedBatch = externalCommitBatches.find((candidate) => candidate.messageIds.includes(focusedMessage.id));
    if (focusedBatch && !chatItems.some((item) => item.type === 'external_commit_batch' && item.batchId === focusedBatch.batchId)) {
      chatItems.push({
        type: 'external_commit_batch',
        batchId: focusedBatch.batchId,
        sortTs: focusedBatch.sortTs,
      });
    } else if (!focusedBatch) {
      const focusedEntity = entitiesByMessageId.get(focusedMessage.id);
      if (focusedEntity && !chatItems.some((item) => item.type === 'entity' && item.entityId === focusedEntity.entityId)) {
        chatItems.push({
          type: 'entity',
          entityId: focusedEntity.entityId,
          sortTs: focusedEntity.sortTs,
        });
      }
    }
  }

  const pathIndexByMessageId = new Map<string, number>();
  pathMessages.forEach((message, pathIndex) => pathIndexByMessageId.set(message.id, pathIndex));
  chatItems.sort((left, right) => {
    const getBatchSortAnchorMessageId = (batchId: string): string | null => {
      const batch = externalCommitBatchById.get(batchId);
      if (!batch) return null;

      if (focusedMessageId && batch.messageIds.includes(focusedMessageId)) {
        return focusedMessageId;
      }

      let bestMessageId: string | null = null;
      let bestPathIndex = -1;
      batch.messageIds.forEach((messageId) => {
        const pathIndex = pathIndexByMessageId.get(messageId);
        if (pathIndex === undefined || pathIndex <= bestPathIndex) return;
        bestPathIndex = pathIndex;
        bestMessageId = messageId;
      });

      return bestMessageId ?? batch.representativeMessageId ?? null;
    };

    const getRepresentativeMessageId = (item: ProjectedChatItem): string | null => {
      if (item.type === 'turn') return entitiesById.get(item.userEntityId)?.messageId ?? null;
      if (item.type === 'turn_user_only') return entitiesById.get(item.userEntityId)?.messageId ?? null;
      if (item.type === 'summary') return entitiesById.get(item.entityId)?.summary?.startMessageId ?? null;
      if (item.type === 'entity') return entitiesById.get(item.entityId)?.messageId ?? null;
      return getBatchSortAnchorMessageId(item.batchId);
    };

    const leftIndex = pathIndexByMessageId.get(getRepresentativeMessageId(left) ?? '') ?? 0;
    const rightIndex = pathIndexByMessageId.get(getRepresentativeMessageId(right) ?? '') ?? 0;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (left.type === 'summary' && right.type === 'turn_user_only') return 1;
    if (right.type === 'summary' && left.type === 'turn_user_only') return -1;
    return left.sortTs - right.sortTs;
  });

  return {
    messages: sortedMessages,
    scopes,
    summaries: sortedSummaries,
    messageMap,
    scopeColorById,
    scopeNameById,
    summaryMap,
    entities,
    entitiesById,
    entitiesByMessageId,
    entitiesBySummaryId,
    childEntityIdsByParentEntityId,
    commitEntityIdsByAssistantEntityId,
    turnGroups,
    turnGroupById,
    externalCommitBatches,
    externalCommitBatchById,
    originMessage,
    originMessageId,
    branchPathMessageIds,
    scopedFocusRoute,
    timelineItems,
    chatItems,
  };
}

function getStableWorkspaceProjectionBase(
  messages: Message[],
  summaries: Summary[]
): StableWorkspaceProjectionBase {
  const cacheKey = getStableBaseCacheKey(messages, summaries);
  const cached = stableBaseCache.get(cacheKey);
  if (cached) {
    stableBaseCache.delete(cacheKey);
    stableBaseCache.set(cacheKey, cached);
    return cached;
  }

  const sortedMessages = [...messages].sort(byCreatedAt);
  const sortedSummaries = [...summaries].sort(byCreatedAt);
  const messageMap = new Map(sortedMessages.map((message) => [message.id, message]));
  const summaryMap = new Map(sortedSummaries.map((summary) => [summary.id, summary]));
  const originMessage = getOriginMessage(sortedMessages);
  const originMessageId = originMessage?.id ?? null;
  const agentCommitShas = new Set(
    sortedMessages
      .filter((message) => {
        if (message.role !== 'assistant') return false;
        const meta = (((message.execution_data as any)?.meta || {}) as Record<string, any>);
        return meta.sync_source !== 'external_git';
      })
      .map((message) => getCommitSha(message))
      .filter((commitSha): commitSha is string => !!commitSha)
  );
  const duplicateAgentCommitMessageIds = getDuplicateAgentCommitMessageIds(sortedMessages, messageMap);
  const assistantMessagesByGraphParentId = new Map<string, Message[]>();
  for (const message of sortedMessages) {
    if (message.role !== 'assistant') continue;
    if (classifyMessageNodeKind(message, messageMap) === 'commit_message') continue;
    const graphParentId = getGraphParentId(message, messageMap);
    if (!graphParentId) continue;
    const siblings = assistantMessagesByGraphParentId.get(graphParentId) ?? [];
    siblings.push(message);
    assistantMessagesByGraphParentId.set(graphParentId, siblings);
  }

  const messageEntities = sortedMessages
    .filter((message) => (
      !isRedundantCommitNode(message, { messageMap }) &&
      !duplicateAgentCommitMessageIds.has(message.id) &&
      !isAgentMaterializedDuplicateExternalCommit(message, agentCommitShas)
    ))
    .map((message) => getProjectedMessageEntity(message, sortedMessages, messageMap));
  const summaryEntities: ProjectedNodeEntity[] = sortedSummaries.map((summary) => ({
    entityId: getSummaryEntityId(summary),
    kind: 'summary_block',
    messageId: null,
    focusMessageId: summary.startMessageId,
    parentEntityId: undefined,
    turnGroupId: undefined,
    sortTs: new Date(summary.createdAt).getTime(),
    summary,
    preview: summary.content.replace(/\s+/g, ' ').trim(),
    shortLabel: 'Summary',
    scopeId: null,
  }));

  const entities = [...messageEntities, ...summaryEntities].sort((left, right) => left.sortTs - right.sortTs);
  const entitiesById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const entitiesByMessageId = new Map(messageEntities.map((entity) => [entity.messageId!, entity]));
  const entitiesBySummaryId = new Map(summaryEntities.map((entity) => [entity.summary!.id, entity]));
  const childEntityIdsByParentEntityId = new Map<string, string[]>();
  const commitEntityIdsByAssistantEntityId = new Map<string, string[]>();

  for (const entity of messageEntities) {
    if (entity.parentEntityId) {
      const children = childEntityIdsByParentEntityId.get(entity.parentEntityId) ?? [];
      children.push(entity.entityId);
      childEntityIdsByParentEntityId.set(entity.parentEntityId, children);
    }
    if (entity.kind === 'commit_message' && entity.parentEntityId) {
      const parentEntity = entitiesById.get(entity.parentEntityId);
      if (parentEntity?.kind === 'assistant_message') {
        const commits = commitEntityIdsByAssistantEntityId.get(parentEntity.entityId) ?? [];
        commits.push(entity.entityId);
        commitEntityIdsByAssistantEntityId.set(parentEntity.entityId, commits);
      }
    }
  }

  const turnGroupMap = new Map<string, ProjectedTurnGroup>();
  for (const message of sortedMessages) {
    if (message.role !== 'user') continue;
    const turnGroupId = getTurnGroupIdForMessage(message, messageMap);
    const assistantMessages = assistantMessagesByGraphParentId.get(message.id) ?? [];
    const commitEntities = assistantMessages.flatMap((assistantMessage) => {
      const assistantEntityId = getMessageEntityId(assistantMessage, messageMap);
      return commitEntityIdsByAssistantEntityId.get(assistantEntityId) ?? [];
    });

    turnGroupMap.set(turnGroupId, {
      turnGroupId,
      userMessageId: message.id,
      userEntityId: getMessageEntityId(message, messageMap),
      assistantMessageIds: assistantMessages.map((candidate) => candidate.id),
      assistantEntityIds: assistantMessages.map((candidate) => getMessageEntityId(candidate, messageMap)),
      memberEntityIds: [
        getMessageEntityId(message, messageMap),
        ...assistantMessages.map((candidate) => getMessageEntityId(candidate, messageMap)),
        ...commitEntities,
      ],
      canonicalFocusMessageId: getTurnFocusMessageId(message, sortedMessages, messageMap),
      sortTs: new Date(message.createdAt).getTime(),
    });
  }
  const turnGroups = Array.from(turnGroupMap.values()).sort((left, right) => left.sortTs - right.sortTs);
  const turnGroupById = new Map(turnGroups.map((group) => [group.turnGroupId, group]));

  const rawBatches = buildExternalCommitBatches(
    sortedMessages.filter((message) => !isAgentMaterializedDuplicateExternalCommit(message, agentCommitShas)),
    messageMap
  );
  const externalCommitBatches = rawBatches.map((batch) => {
    const representative = messageMap.get(batch.representativeMessageId);
    const meta = representative
      ? (((representative.execution_data as any)?.meta || {}) as Record<string, any>)
      : {};
    const sourceKind = representative && isManualCommitBatch(representative) ? 'manual' : 'external';
    const manualCommits = Array.isArray(meta.commits) ? meta.commits : [];
    const importedFromRef = sourceKind === 'external'
      ? (meta.imported_from_ref as string | undefined) ?? null
      : null;
    const commitCount = sourceKind === 'manual'
      ? (typeof meta.commit_count === 'number' ? meta.commit_count : manualCommits.length || 1)
      : batch.messages.length;
    return {
      batchId: batch.entityId,
      batch,
      entityId: batch.entityId,
      representativeMessageId: batch.representativeMessageId,
      representativeEntityId: getMessageEntityId(messageMap.get(batch.representativeMessageId)!, messageMap),
      messageIds: batch.messages.map((message) => message.id),
      entityIds: batch.messages.map((message) => getMessageEntityId(message, messageMap)),
      importedFromRef,
      title: sourceKind === 'manual' ? 'Added Commits' : 'Imported Commits',
      sourceKind,
      commitCount,
      sortTs: batch.sortTs,
    } satisfies ProjectedExternalCommitBatch;
  });
  const externalCommitBatchById = new Map(externalCommitBatches.map((batch) => [batch.batchId, batch]));
  const batchedMessageIds = new Set(externalCommitBatches.flatMap((batch) => batch.messageIds));

  const timelineItems: ProjectedTimelineItem[] = [];
  for (const entity of messageEntities) {
    if (!entity.messageId || batchedMessageIds.has(entity.messageId)) continue;
    timelineItems.push({ type: 'entity', entityId: entity.entityId, sortTs: entity.sortTs });
  }
  for (const entity of summaryEntities) {
    timelineItems.push({ type: 'entity', entityId: entity.entityId, sortTs: entity.sortTs });
  }
  for (const batch of externalCommitBatches) {
    timelineItems.push({ type: 'external_commit_batch', batchId: batch.batchId, sortTs: batch.sortTs });
  }
  timelineItems.sort((left, right) => left.sortTs - right.sortTs);

  const base: StableWorkspaceProjectionBase = {
    sortedMessages,
    sortedSummaries,
    messageMap,
    summaryMap,
    entities,
    entitiesById,
    entitiesByMessageId,
    entitiesBySummaryId,
    childEntityIdsByParentEntityId,
    commitEntityIdsByAssistantEntityId,
    turnGroups,
    turnGroupById,
    externalCommitBatches,
    externalCommitBatchById,
    originMessage,
    originMessageId,
    timelineItems,
    agentCommitShas,
  };
  rememberStableBase(cacheKey, base);
  return base;
}
