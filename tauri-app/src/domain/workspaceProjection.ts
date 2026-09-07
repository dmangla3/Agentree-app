import { isActiveAgentStatus, isFailureAgentStatus, isTerminalAgentStatus, type AgentStatus } from '@shared/agentStatus';
import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Summary } from '../stores/workspaceStore';
import { getGraphParentId } from '../lib/graph/lineage';
import { isRedundantCommitNode } from '../lib/graph/turnUtils';
import { getMessageBaseCommitSha } from '../lib/graph/commitAccessors';
import { buildThreadRootIndex, getThreadOriginNodeId, type ThreadRootIndex } from '../lib/graphThreadRoots';
import type { ThreadSession } from '../lib/threadSessions';
import { getSubgraphThreadLinkTargetId } from '../lib/graphSubgraphThreads';
import { resolveNodeState } from '../lib/runStateResolver';
import { getNodeFailureReason } from '../lib/nodeFailureReason';
import { getControlledByNodeId, getNodeKind } from '../orchestration/domain';
import { buildFocusRoute, isImportedGitMessage, type FocusRoute } from './focusRoute';
import {
  CanonicalNodeEntity,
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
} from './nodes';

export interface ProjectedNodeEntity extends CanonicalNodeEntity {
  message?: Message;
  summary?: Summary;
  nodeKind?: string | null;
  controlledByNodeId?: string | null;
  orchestrationSummary?: ProjectedOrchestrationSummary | null;
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
  threadRootId?: string | null;
  threadLinkRootId?: string | null;
  rootMessageId?: string | null;
  isThreadRoot?: boolean;
}

export interface ProjectedOrchestrationSummary {
  controllerMessageId: string;
  controlledEntityIds: string[];
  childAssistantEntityIds: string[];
  totalChildRuns: number;
  activeChildRuns: number;
  terminalChildRuns: number;
  completedChildRuns: number;
  failedChildRuns: number;
  cancelledChildRuns: number;
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

export type CommitPlacement = 'conversation_sidecar' | 'commit_lineage';

export type ProjectedCommitKind =
  | 'generated_commit'
  | 'imported_commit'
  | 'manual_commit'
  | 'merge_commit'
  | 'unknown_commit';

export type ProjectedCommitOwnerKind = 'agentree' | 'external' | 'manual' | 'unknown';

export interface ProjectedCommitEntity {
  entityId: string;
  kind: ProjectedCommitKind;
  sha: string;
  shortSha: string;
  subject: string;
  sourceKind: string;
  ownerKind: ProjectedCommitOwnerKind;
  placement: CommitPlacement;
  producedByNodeId: string | null;
  visualOwnerNodeId: string | null;
  ownerThreadRootId: string | null;
  parentShas: string[];
  parentRows: CommitParentEntity[];
  isMerge: boolean;
  isProminentMerge: boolean;
  layoutParentSha: string | null;
  secondaryParentShas: string[];
  observations: CommitObservationEntity[];
  commit: CommitEntity;
  sortTs: number;
  representedThreadRootIds: string[];
}

export interface ProjectedCommitLaneRow {
  rowId: string;
  type: 'commit' | 'group';
  commitSha?: string;
  groupId?: string;
  sortTs: number;
}

export interface ProjectedCommitGroup {
  groupId: string;
  kind: 'layout_derived_commit_group';
  sourceKind: 'external' | 'manual' | 'unknown';
  commitShas: string[];
  firstSha: string;
  lastSha: string;
  parentSha: string | null;
  childSha: string | null;
  sortTs: number;
  expanded: boolean;
}

export type ProjectedListItem = { type: 'entity'; entityId: string; sortTs: number };

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
  | { type: 'entity'; entityId: string; sortTs: number };

export interface WorkspaceProjection {
  messages: Message[];
  summaries: Summary[];
  messageMap: Map<string, Message>;
  summaryMap: Map<string, Summary>;
  entities: ProjectedNodeEntity[];
  entitiesById: Map<string, ProjectedNodeEntity>;
  entitiesByMessageId: Map<string, ProjectedNodeEntity>;
  entitiesBySummaryId: Map<string, ProjectedNodeEntity>;
  childEntityIdsByParentEntityId: Map<string, string[]>;
  controlledEntityIdsByControllerMessageId: Map<string, string[]>;
  commitEntityIdsByAssistantEntityId: Map<string, string[]>;
  commitBySha: Map<string, ProjectedCommitEntity>;
  commitLaneRows: ProjectedCommitLaneRow[];
  layoutDerivedCommitGroups: ProjectedCommitGroup[];
  groupIdByCommitSha: Map<string, string>;
  threadRootIds: string[];
  threadRootIdByMessageId: Map<string, string>;
  rootMessageIdByThreadRootId: Map<string, string>;
  turnGroups: ProjectedTurnGroup[];
  turnGroupById: Map<string, ProjectedTurnGroup>;
  originMessage: Message | null;
  originMessageId: string | null;
  branchPathMessageIds: Set<string>;
  focusRoute: FocusRoute;
  listItems: ProjectedListItem[];
  chatItems: ProjectedChatItem[];
}

export interface BuildWorkspaceProjectionInput {
  messages: Message[];
  summaries: Summary[];
  commits?: CommitEntity[];
  commitParents?: CommitParentEntity[];
  commitObservations?: CommitObservationEntity[];
  focusedMessageId: string | null;
  disabledSummaryIds?: Set<string>;
  emptyThreadRoot?: EmptyThreadRootInput | null;
  syntheticThreadRoots?: EmptyThreadRootInput[];
  threadSessions?: ThreadSession[];
}

export interface EmptyThreadRootInput {
  threadRootId: string;
  workspaceId: string;
  createdAt?: string | null;
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
  controlledEntityIdsByControllerMessageId: Map<string, string[]>;
  commitEntityIdsByAssistantEntityId: Map<string, string[]>;
  commitBySha: Map<string, ProjectedCommitEntity>;
  commitLaneRows: ProjectedCommitLaneRow[];
  layoutDerivedCommitGroups: ProjectedCommitGroup[];
  groupIdByCommitSha: Map<string, string>;
  threadRootIds: string[];
  threadRootIdByMessageId: Map<string, string>;
  rootMessageIdByThreadRootId: Map<string, string>;
  turnGroups: ProjectedTurnGroup[];
  turnGroupById: Map<string, ProjectedTurnGroup>;
  originMessage: Message | null;
  originMessageId: string | null;
  listItems: ProjectedListItem[];
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
  const executionData = message.execution_data as Record<string, unknown> | null | undefined;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, unknown>;
  const syncSource = typeof meta.sync_source === 'string' ? meta.sync_source : '';
  const importedFromRef = typeof meta.imported_from_ref === 'string' ? meta.imported_from_ref : '';
  const commitCount = typeof meta.commit_count === 'number' ? meta.commit_count : '';
  const failureReason = getNodeFailureReason(executionData, meta.provider_error_message);
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
    content.length,
    content.slice(0, 24),
    content.slice(-24),
    failureReason ?? '',
    typeof executionData?.last_terminal_status === 'string' ? executionData.last_terminal_status : '',
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

const getCommitFingerprint = (commit: CommitEntity): string => (
  [
    commit.sha,
    commit.subject ?? '',
    commit.source_kind ?? '',
    commit.produced_by_node_id ?? '',
    commit.first_parent_sha ?? '',
    commit.committed_at ?? '',
    commit.authored_at ?? '',
  ].join('\u001f')
);

const getCommitParentFingerprint = (parent: CommitParentEntity): string => (
  [parent.child_sha, parent.parent_sha, parent.parent_index].join('\u001f')
);

const getCommitObservationFingerprint = (observation: CommitObservationEntity): string => (
  [
    observation.commit_sha,
    observation.source_kind ?? '',
    observation.git_ref ?? '',
    observation.last_seen_at ?? '',
  ].join('\u001f')
);

const getStableBaseCacheKey = (
  messages: Message[],
  summaries: Summary[],
  commits: CommitEntity[] = [],
  commitParents: CommitParentEntity[] = [],
  commitObservations: CommitObservationEntity[] = [],
  emptyThreadRoot: EmptyThreadRootInput | null = null,
  syntheticThreadRoots: EmptyThreadRootInput[] = [],
  threadSessions: ThreadSession[] = [],
): string => (
  [
    'messages',
    messages.length,
    ...messages.map(getMessageFingerprint),
    'summaries',
    summaries.length,
    ...summaries.map(getSummaryFingerprint),
    'commits',
    commits.length,
    ...commits.map(getCommitFingerprint),
    'commitParents',
    commitParents.length,
    ...commitParents.map(getCommitParentFingerprint),
    'commitObservations',
    commitObservations.length,
    ...commitObservations.map(getCommitObservationFingerprint),
    'emptyThreadRoot',
    emptyThreadRoot?.threadRootId ?? '',
    emptyThreadRoot?.workspaceId ?? '',
    emptyThreadRoot?.createdAt ?? '',
    'syntheticThreadRoots',
    syntheticThreadRoots.length,
    ...syntheticThreadRoots.map((root) => `${root.threadRootId}:${root.workspaceId}:${root.createdAt ?? ''}`),
    'threadSessions',
    threadSessions.length,
    ...threadSessions.map((thread) => [
      thread.id,
      thread.workspaceId,
      thread.title ?? '',
      thread.status,
      thread.createdAt,
      thread.updatedAt,
      thread.baseCommitSha ?? '',
      thread.firstMessageId ?? '',
      thread.source,
    ].join(':')),
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

const isWorkspaceWelcomeOriginMessage = (message: Message): boolean => (
  message.role === 'assistant' &&
  message.parentId === null &&
  (message.content || '').trim().startsWith('Welcome! How can I help you explore your ideas today?')
);

const getThreadOriginEntity = (
  threadRootId: string,
  rootMessage: Message,
): ProjectedNodeEntity => ({
  entityId: `thread_origin:${threadRootId}`,
  kind: 'thread_origin',
  messageId: null,
  focusMessageId: rootMessage.id,
  parentEntityId: undefined,
  turnGroupId: `thread_origin:${threadRootId}`,
  sortTs: new Date(rootMessage.createdAt).getTime() - 0.25,
  preview: rootMessage.aiLabel?.trim() || rootMessage.content?.trim() || 'Thread origin',
  shortLabel: 'Thread origin',
  threadRootId,
  rootMessageId: rootMessage.id,
  isThreadRoot: true,
  message: {
    id: getThreadOriginNodeId(threadRootId),
    role: 'assistant',
    content: 'Thread origin',
    parentId: null,
    workspaceId: rootMessage.workspaceId,
    createdAt: rootMessage.createdAt,
    updatedAt: rootMessage.createdAt,
    status: null,
    agent_id: null,
    execution_data: { meta: { node_kind: 'thread_origin', thread_origin_id: threadRootId } },
  } as Message,
});

const getEmptyThreadOriginEntity = ({
  threadRootId,
  workspaceId,
  createdAt,
  title,
}: EmptyThreadRootInput & { title?: string | null }): ProjectedNodeEntity => {
  const timestamp = createdAt || new Date(0).toISOString();
  const preview = title?.trim() || 'New thread';
  return {
    entityId: `thread_origin:${threadRootId}`,
    kind: 'thread_origin',
    messageId: null,
    focusMessageId: null,
    parentEntityId: undefined,
    turnGroupId: `thread_origin:${threadRootId}`,
    sortTs: new Date(timestamp).getTime(),
    preview,
    shortLabel: 'Thread origin',
    threadRootId,
    rootMessageId: null,
    isThreadRoot: true,
    message: {
      id: getThreadOriginNodeId(threadRootId),
      role: 'assistant',
      content: preview,
      parentId: null,
      workspaceId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: null,
      agent_id: null,
      execution_data: { meta: { node_kind: 'thread_origin', thread_origin_id: threadRootId, empty_workspace_thread: true } },
    } as Message,
  };
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
  messageMap: Map<string, Message>,
  threadRootIdByMessageId: Map<string, string>,
  rootMessageIdByThreadRootId: Map<string, string>,
  assistantMessagesByGraphParentId: Map<string, Message[]>,
): ProjectedNodeEntity => {
  const kind = classifyMessageNodeKind(message, messageMap);
  const graphParentId = getGraphParentId(message, messageMap);
  const graphParent = graphParentId ? messageMap.get(graphParentId) : null;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, any>;
  const nodeKind = getNodeKind(message);
  const controlledByNodeId = getControlledByNodeId(message);
  const metaCommits = Array.isArray(meta.commits) ? meta.commits : [];
  const lastMetaCommit = metaCommits[metaCommits.length - 1] || null;
  const outputCommitSha = getCommitSha(message);
  const shortSha = outputCommitSha ? outputCommitSha.slice(0, 8) : null;
  const shortLabel = kind === 'commit_message'
    ? (shortSha || 'Commit')
    : kind === 'thread_link'
      ? 'Thread'
      : (message.aiLabel?.trim() || (message.llmModel?.split('/').pop() || (message.role === 'user' ? 'Prompt' : 'Assistant')));
  const focusMessageId = kind === 'user_message'
    ? assistantMessagesByGraphParentId.get(message.id)?.[0]?.id ?? null
    : message.id;
  const threadRootId = threadRootIdByMessageId.get(message.id) ?? null;
  const threadLinkRootId = kind === 'thread_link' ? getSubgraphThreadLinkTargetId(message) : null;

  return {
    entityId: getMessageEntityId(message, messageMap),
    kind,
    messageId: message.id,
    focusMessageId,
    parentEntityId: graphParent ? getMessageEntityId(graphParent, messageMap) : undefined,
    turnGroupId: kind === 'thread_link' ? undefined : getTurnGroupIdForMessage(message, messageMap),
    sortTs: new Date(message.createdAt).getTime(),
    message,
    nodeKind,
    controlledByNodeId,
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
    threadRootId,
    threadLinkRootId,
    isThreadRoot: Boolean(threadRootId && rootMessageIdByThreadRootId.get(threadRootId) === message.id),
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

const buildProjectedOrchestrationSummary = (
  controllerMessageId: string,
  controlledEntityIds: string[],
  entitiesById: Map<string, ProjectedNodeEntity>,
): ProjectedOrchestrationSummary => {
  const childAssistantEntities = controlledEntityIds
    .map((entityId) => entitiesById.get(entityId) ?? null)
    .filter((entity): entity is ProjectedNodeEntity => entity?.kind === 'assistant_message');

  return {
    controllerMessageId,
    controlledEntityIds,
    childAssistantEntityIds: childAssistantEntities.map((entity) => entity.entityId),
    totalChildRuns: childAssistantEntities.length,
    activeChildRuns: childAssistantEntities.filter((entity) => isActiveAgentStatus(entity.status)).length,
    terminalChildRuns: childAssistantEntities.filter((entity) => isTerminalAgentStatus(entity.status)).length,
    completedChildRuns: childAssistantEntities.filter((entity) => entity.status === 'completed').length,
    failedChildRuns: childAssistantEntities.filter((entity) => isFailureAgentStatus(entity.status)).length,
    cancelledChildRuns: childAssistantEntities.filter((entity) => entity.status === 'cancelled').length,
  };
};

const getCommitSortTs = (commit: CommitEntity): number => {
  const value = commit.committed_at ?? commit.authored_at ?? commit.updatedAt ?? commit.createdAt ?? '';
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? 0 : ts;
};

const normalizeSourceKind = (value: string | null | undefined): string => (
  value === 'external' || value === 'manual' || value === 'agent' || value === 'merge' || value === 'unknown'
    ? value
    : 'unknown'
);

const getProjectedCommitKind = (
  commit: CommitEntity,
  observations: CommitObservationEntity[],
  parentRows: CommitParentEntity[],
): ProjectedCommitKind => {
  if (commit.source_kind === 'merge' || parentRows.length > 1) return 'merge_commit';
  if (commit.produced_by_node_id) return 'generated_commit';
  if (commit.source_kind === 'manual' || observations.some((observation) => observation.source_kind === 'manual')) return 'manual_commit';
  if (commit.source_kind === 'external' || observations.some((observation) => observation.source_kind === 'external')) return 'imported_commit';
  return 'unknown_commit';
};

const isExternalSyncMessage = (message: Message): boolean => {
  const meta = (((message.execution_data as any)?.meta || {}) as Record<string, unknown>);
  return meta.sync_source === 'external_git';
};

const getMergeMetadata = (message: Message | null | undefined): Record<string, any> | null => {
  const metadata = (message?.execution_data as any)?.merge_metadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, any> : null;
};

const getMergeTargetCommitSha = (message: Message | null | undefined): string | null => {
  const targetSha = getMergeMetadata(message)?.target?.commitSha;
  return typeof targetSha === 'string' && targetSha.trim() ? targetSha.trim() : null;
};

const getMergePrimaryParentNodeId = (message: Message | null | undefined): string | null => {
  const nodeId = getMergeMetadata(message)?.lineage?.primary_parent_node_id;
  return typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : null;
};

const buildCommitProjection = (
  commits: CommitEntity[] = [],
  commitParents: CommitParentEntity[] = [],
  commitObservations: CommitObservationEntity[] = [],
  messages: Message[] = [],
  messageMap: Map<string, Message> = new Map(),
  threadRootIndex: ThreadRootIndex = buildThreadRootIndex(messages),
) => {
  if (commits.length === 0) {
    return {
      commitBySha: new Map<string, ProjectedCommitEntity>(),
      commitLaneRows: [],
      layoutDerivedCommitGroups: [],
      groupIdByCommitSha: new Map<string, string>(),
    };
  }

  const outputOwnerBySha = new Map<string, Message>();
  for (const message of messages) {
    if (message.role !== 'assistant' || isExternalSyncMessage(message)) continue;
    const outputSha = getCommitSha(message);
    if (!outputSha) continue;
    outputOwnerBySha.set(outputSha, message);
  }

  const parentsByChildSha = new Map<string, CommitParentEntity[]>();
  for (const parent of commitParents) {
    const childParents = parentsByChildSha.get(parent.child_sha) ?? [];
    childParents.push(parent);
    parentsByChildSha.set(parent.child_sha, childParents);
  }
  parentsByChildSha.forEach((parents) => parents.sort((left, right) => left.parent_index - right.parent_index));

  const observationsBySha = new Map<string, CommitObservationEntity[]>();
  for (const observation of commitObservations) {
    const observations = observationsBySha.get(observation.commit_sha) ?? [];
    observations.push(observation);
    observationsBySha.set(observation.commit_sha, observations);
  }

  const commitBySha = new Map<string, ProjectedCommitEntity>();

  const getOwnerThreadRootId = (
    producedByNodeId: string | null,
    outputOwnerNodeId: string | null,
  ): string | null => {
    const producedByThreadRootId = producedByNodeId
      ? threadRootIndex.threadRootIdByMessageId.get(producedByNodeId) ?? null
      : null;
    if (producedByThreadRootId) return producedByThreadRootId;

    return outputOwnerNodeId
      ? threadRootIndex.threadRootIdByMessageId.get(outputOwnerNodeId) ?? null
      : null;
  };

  for (const commit of commits) {
    if (!commit.sha) continue;
    const parentRows: CommitParentEntity[] = (parentsByChildSha.get(commit.sha) ?? commit.parents ?? [])
      .map((parent) => ({
        ...parent,
        child_sha: parent.child_sha ?? commit.sha,
      }))
      .sort((left, right) => left.parent_index - right.parent_index);
    const observations = observationsBySha.get(commit.sha) ?? [];
    const sourceKind = normalizeSourceKind(commit.source_kind);
    const producedByNodeId = commit.produced_by_node_id ?? null;
    const outputOwner = outputOwnerBySha.get(commit.sha) ?? null;
    const visualOwnerNodeId = producedByNodeId ?? outputOwner?.id ?? null;
    const ownerKind: ProjectedCommitOwnerKind = visualOwnerNodeId
      ? 'agentree'
      : sourceKind === 'manual' || observations.some((observation) => observation.source_kind === 'manual')
        ? 'manual'
        : sourceKind === 'external' || observations.some((observation) => observation.source_kind === 'external')
          ? 'external'
          : 'unknown';
    const isMerge = sourceKind === 'merge' || parentRows.length > 1;
    const projected: ProjectedCommitEntity = {
      entityId: `commit:${commit.sha}`,
      kind: getProjectedCommitKind(commit, observations, parentRows),
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 8),
      subject: commit.subject?.trim() || `Commit ${commit.sha.slice(0, 8)}`,
      sourceKind,
      ownerKind,
      placement: visualOwnerNodeId ? 'conversation_sidecar' : 'commit_lineage',
      producedByNodeId,
      visualOwnerNodeId,
      ownerThreadRootId: getOwnerThreadRootId(producedByNodeId, outputOwner?.id ?? null),
      parentShas: parentRows.map((parent) => parent.parent_sha),
      parentRows,
      isMerge,
      isProminentMerge: false,
      layoutParentSha: parentRows[0]?.parent_sha ?? null,
      secondaryParentShas: [],
      observations,
      commit,
      sortTs: getCommitSortTs(commit),
      representedThreadRootIds: [],
    };
    commitBySha.set(commit.sha, projected);
  }

  const agentreeOwnedShas = new Set(
    Array.from(commitBySha.values())
      .filter((commit) => commit.ownerKind === 'agentree')
      .map((commit) => commit.sha)
  );

  const threadRootByOutputSha = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || isExternalSyncMessage(message)) continue;
    const outputSha = getCommitSha(message);
    if (!outputSha) continue;
    const threadRootId = threadRootIndex.threadRootIdByMessageId.get(message.id);
    if (threadRootId) threadRootByOutputSha.set(outputSha, threadRootId);
  }

  const resolveOwnerMessage = (commit: ProjectedCommitEntity): Message | null => {
    const ownerId = commit.visualOwnerNodeId;
    return ownerId ? messageMap.get(ownerId) ?? null : null;
  };

  const chooseLayoutParentSha = (commit: ProjectedCommitEntity): string | null => {
    if (commit.parentShas.length === 0) return null;
    const parentSet = new Set(commit.parentShas);
    if (!commit.isMerge) return commit.parentRows[0]?.parent_sha ?? commit.parentShas[0] ?? null;

    const ownerMessage = resolveOwnerMessage(commit);
    const explicitBaseSha = ownerMessage ? getMessageBaseCommitSha(ownerMessage) : null;
    if (explicitBaseSha && parentSet.has(explicitBaseSha)) return explicitBaseSha;

    const targetSha = getMergeTargetCommitSha(ownerMessage);
    if (targetSha && parentSet.has(targetSha)) return targetSha;

    const primaryParentNodeId = getMergePrimaryParentNodeId(ownerMessage);
    const primaryParentMessage = primaryParentNodeId ? messageMap.get(primaryParentNodeId) ?? null : null;
    const primaryParentOutputSha = primaryParentMessage ? getCommitSha(primaryParentMessage) : null;
    if (primaryParentOutputSha && parentSet.has(primaryParentOutputSha)) return primaryParentOutputSha;

    const agentreeParentSha = commit.parentShas.find((sha) => agentreeOwnedShas.has(sha));
    if (agentreeParentSha && commit.ownerKind !== 'agentree') return agentreeParentSha;

    return commit.parentRows[0]?.parent_sha ?? commit.parentShas[0] ?? null;
  };

  const getRepresentedThreadRootIds = (commit: ProjectedCommitEntity): string[] => {
    const owners = new Set<string>();

    if (commit.ownerThreadRootId) owners.add(commit.ownerThreadRootId);

    if (commit.isMerge) {
      commit.parentShas.forEach((parentSha) => {
        const parentThreadRootId = threadRootByOutputSha.get(parentSha);
        if (parentThreadRootId) owners.add(parentThreadRootId);
      });
    }

    return Array.from(owners).sort();
  };

  commitBySha.forEach((commit) => {
    const layoutParentSha = chooseLayoutParentSha(commit);
    const hasAgentreeParent = commit.parentShas.some((sha) => agentreeOwnedShas.has(sha));
    commit.layoutParentSha = layoutParentSha;
    commit.secondaryParentShas = commit.parentShas.filter((sha) => sha !== layoutParentSha);
    commit.isProminentMerge = commit.isMerge && (
      commit.ownerKind === 'agentree'
      || commit.sourceKind === 'merge'
      || hasAgentreeParent
    );
    commit.representedThreadRootIds = getRepresentedThreadRootIds(commit);
  });

  const sortedCommits = Array.from(commitBySha.values()).sort((left, right) => {
    if (left.sortTs !== right.sortTs) return left.sortTs - right.sortTs;
    return left.sha.localeCompare(right.sha);
  });

  const getGroupSourceKind = (commit: ProjectedCommitEntity): ProjectedCommitGroup['sourceKind'] | null => {
    if (commit.sourceKind === 'external' || commit.sourceKind === 'manual') return commit.sourceKind;
    if (commit.sourceKind === 'unknown') return 'unknown';
    return null;
  };

  const isGroupable = (commit: ProjectedCommitEntity): boolean => {
    if (commit.placement !== 'commit_lineage') return false;
    if (commit.isProminentMerge) return false;
    return getGroupSourceKind(commit) !== null;
  };

  const groups: ProjectedCommitGroup[] = [];
  const groupedShas = new Set<string>();
  const neighborsBySha = new Map<string, Set<string>>();
  const addNeighbor = (leftSha: string, rightSha: string) => {
    const left = neighborsBySha.get(leftSha) ?? new Set<string>();
    left.add(rightSha);
    neighborsBySha.set(leftSha, left);
    const right = neighborsBySha.get(rightSha) ?? new Set<string>();
    right.add(leftSha);
    neighborsBySha.set(rightSha, right);
  };

  for (const commit of sortedCommits) {
    if (!isGroupable(commit)) continue;
    const sourceKind = getGroupSourceKind(commit);
    const parentSha = commit.layoutParentSha;
    if (parentSha) {
      const parent = commitBySha.get(parentSha);
      if (!parent || !isGroupable(parent)) continue;
      if (getGroupSourceKind(parent) !== sourceKind) continue;
      addNeighbor(commit.sha, parent.sha);
    }
  }

  const pickBoundaryCommit = (
    component: ProjectedCommitEntity[],
    direction: 'root' | 'tip',
  ): ProjectedCommitEntity => {
    const componentShas = new Set(component.map((commit) => commit.sha));
    const candidates = component.filter((commit) => {
      if (direction === 'root') {
        return !commit.layoutParentSha || !componentShas.has(commit.layoutParentSha);
      }
      return !Array.from(neighborsBySha.get(commit.sha) ?? [])
        .some((neighborSha) => {
          const neighbor = commitBySha.get(neighborSha);
          return neighbor?.layoutParentSha === commit.sha;
        });
    });
    return (candidates.length > 0 ? candidates : component)
      .sort((left, right) => left.sha.localeCompare(right.sha))[0];
  };

  const visitedShas = new Set<string>();
  const componentStarts = [...sortedCommits].sort((left, right) => left.sha.localeCompare(right.sha));
  for (const start of componentStarts) {
    if (groupedShas.has(start.sha) || !isGroupable(start)) continue;
    if (visitedShas.has(start.sha)) continue;

    const component: ProjectedCommitEntity[] = [];
    const stack = [start.sha];
    visitedShas.add(start.sha);
    while (stack.length > 0) {
      const sha = stack.pop()!;
      const commit = commitBySha.get(sha);
      if (!commit || !isGroupable(commit)) continue;
      component.push(commit);
      (neighborsBySha.get(sha) ?? new Set<string>()).forEach((neighborSha) => {
        if (visitedShas.has(neighborSha)) return;
        visitedShas.add(neighborSha);
        stack.push(neighborSha);
      });
    }

    if (component.length < 3) continue;

    const first = pickBoundaryCommit(component, 'root');
    const last = pickBoundaryCommit(component, 'tip');
    const sourceKind = getGroupSourceKind(first) ?? 'unknown';
    const group: ProjectedCommitGroup = {
      groupId: `commit-group:${sourceKind}:${first.sha}:${last.sha}:${component.length}`,
      kind: 'layout_derived_commit_group',
      sourceKind,
      commitShas: component.map((commit) => commit.sha).sort((left, right) => left.localeCompare(right)),
      firstSha: first.sha,
      lastSha: last.sha,
      parentSha: first.layoutParentSha ?? null,
      childSha: null,
      sortTs: first.sortTs,
      expanded: false,
    };
    groups.push(group);
    component.forEach((commit) => groupedShas.add(commit.sha));
  }

  const groupIdByCommitSha = new Map<string, string>();
  groups.forEach((group) => {
    group.commitShas.forEach((sha) => groupIdByCommitSha.set(sha, group.groupId));
  });

  const groupByFirstSha = new Map(groups.map((group) => [group.firstSha, group]));
  const commitLaneRows: ProjectedCommitLaneRow[] = [];
  for (const commit of sortedCommits) {
    const group = groupByFirstSha.get(commit.sha);
    if (group) {
      commitLaneRows.push({
        rowId: group.groupId,
        type: 'group',
        groupId: group.groupId,
        sortTs: group.sortTs,
      });
      continue;
    }
    if (groupedShas.has(commit.sha)) continue;
    commitLaneRows.push({
      rowId: `commit-row:${commit.sha}`,
      type: 'commit',
      commitSha: commit.sha,
      sortTs: commit.sortTs,
    });
  }

  return {
    commitBySha,
    commitLaneRows,
    layoutDerivedCommitGroups: groups,
    groupIdByCommitSha,
  };
};

export function buildWorkspaceProjection({
  messages,
  summaries,
  commits = [],
  commitParents = [],
  commitObservations = [],
  focusedMessageId,
  disabledSummaryIds = new Set<string>(),
  emptyThreadRoot = null,
  syntheticThreadRoots = [],
  threadSessions = [],
}: BuildWorkspaceProjectionInput): WorkspaceProjection {
  const base = getStableWorkspaceProjectionBase(messages, summaries, commits, commitParents, commitObservations, emptyThreadRoot, syntheticThreadRoots, threadSessions);
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
    controlledEntityIdsByControllerMessageId,
    commitEntityIdsByAssistantEntityId,
    commitBySha,
    commitLaneRows,
    layoutDerivedCommitGroups,
    groupIdByCommitSha,
    threadRootIds,
    threadRootIdByMessageId,
    rootMessageIdByThreadRootId,
    turnGroups,
    turnGroupById,
    originMessage,
    originMessageId,
    listItems,
    agentCommitShas,
  } = base;

  const focusRoute = buildFocusRoute(messageMap, focusedMessageId);
  const branchPathMessageIds = new Set(focusRoute.messageIds);
  const branchTurnGroups = turnGroups.filter((group) => branchPathMessageIds.has(group.userMessageId));
  const pathMessages = focusRoute.messageIds
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
  for (const message of assistantOnlyPathMessages) {
    chatItems.push({
      type: 'entity',
      entityId: getMessageEntityId(message, messageMap),
      sortTs: new Date(message.createdAt).getTime(),
    });
  }

  const focusedMessage = focusedMessageId ? messageMap.get(focusedMessageId) ?? null : null;
  if (focusedMessage && isImportedGitMessage(focusedMessage)) {
    const focusedEntity = entitiesByMessageId.get(focusedMessage.id);
    if (focusedEntity && !chatItems.some((item) => item.type === 'entity' && item.entityId === focusedEntity.entityId)) {
      chatItems.push({
        type: 'entity',
        entityId: focusedEntity.entityId,
        sortTs: focusedEntity.sortTs,
      });
    }
  }

  const pathIndexByMessageId = new Map<string, number>();
  pathMessages.forEach((message, pathIndex) => pathIndexByMessageId.set(message.id, pathIndex));
  chatItems.sort((left, right) => {
    const getRepresentativeMessageId = (item: ProjectedChatItem): string | null => {
      if (item.type === 'turn') return entitiesById.get(item.userEntityId)?.messageId ?? null;
      if (item.type === 'turn_user_only') return entitiesById.get(item.userEntityId)?.messageId ?? null;
      if (item.type === 'summary') return entitiesById.get(item.entityId)?.summary?.startMessageId ?? null;
      if (item.type === 'entity') return entitiesById.get(item.entityId)?.messageId ?? null;
      return null;
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
    summaries: sortedSummaries,
    messageMap,
    summaryMap,
    entities,
    entitiesById,
    entitiesByMessageId,
    entitiesBySummaryId,
    childEntityIdsByParentEntityId,
    controlledEntityIdsByControllerMessageId,
    commitEntityIdsByAssistantEntityId,
    commitBySha,
    commitLaneRows,
    layoutDerivedCommitGroups,
    groupIdByCommitSha,
    threadRootIds,
    threadRootIdByMessageId,
    rootMessageIdByThreadRootId,
    turnGroups,
    turnGroupById,
    originMessage,
    originMessageId,
    branchPathMessageIds,
    focusRoute,
    listItems,
    chatItems,
  };
}

function getStableWorkspaceProjectionBase(
  messages: Message[],
  summaries: Summary[],
  commits: CommitEntity[] = [],
  commitParents: CommitParentEntity[] = [],
  commitObservations: CommitObservationEntity[] = [],
  emptyThreadRoot: EmptyThreadRootInput | null = null,
  syntheticThreadRoots: EmptyThreadRootInput[] = [],
  threadSessions: ThreadSession[] = [],
): StableWorkspaceProjectionBase {
  const normalizedEmptyThreadRoot = messages.length === 0 ? emptyThreadRoot : null;
  const syntheticRootById = new Map<string, EmptyThreadRootInput>();
  for (const root of syntheticThreadRoots) {
    const threadRootId = root.threadRootId.trim();
    if (!threadRootId) continue;
    syntheticRootById.set(threadRootId, { ...root, threadRootId });
  }
  if (normalizedEmptyThreadRoot?.threadRootId.trim()) {
    syntheticRootById.set(normalizedEmptyThreadRoot.threadRootId.trim(), {
      ...normalizedEmptyThreadRoot,
      threadRootId: normalizedEmptyThreadRoot.threadRootId.trim(),
    });
  }
  const normalizedSyntheticThreadRoots = Array.from(syntheticRootById.values()).sort((left, right) => (
    (Number.isFinite(new Date(left.createdAt ?? '').getTime()) ? new Date(left.createdAt ?? '').getTime() : 0) -
    (Number.isFinite(new Date(right.createdAt ?? '').getTime()) ? new Date(right.createdAt ?? '').getTime() : 0) ||
    left.threadRootId.localeCompare(right.threadRootId)
  ));
  const normalizedThreadSessions = [...threadSessions].sort((left, right) => (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    || left.id.localeCompare(right.id)
  ));
  const threadSessionById = new Map(normalizedThreadSessions.map((thread) => [thread.id, thread]));
  const cacheKey = getStableBaseCacheKey(messages, summaries, commits, commitParents, commitObservations, normalizedEmptyThreadRoot, normalizedSyntheticThreadRoots, normalizedThreadSessions);
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
  const threadRootIndex = buildThreadRootIndex(sortedMessages, {
    emptyThreadRootId: normalizedEmptyThreadRoot?.threadRootId ?? null,
    syntheticThreadRootIds: normalizedSyntheticThreadRoots.map((root) => root.threadRootId),
    threadSessions: normalizedThreadSessions,
  });
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
      !isWorkspaceWelcomeOriginMessage(message) &&
      !isRedundantCommitNode(message, { messageMap }) &&
      !duplicateAgentCommitMessageIds.has(message.id) &&
      !isAgentMaterializedDuplicateExternalCommit(message, agentCommitShas)
    ))
    .map((message) => getProjectedMessageEntity(
      message,
      sortedMessages,
      messageMap,
      threadRootIndex.threadRootIdByMessageId,
      threadRootIndex.rootMessageIdByThreadRootId,
      assistantMessagesByGraphParentId
    ));
  const threadOriginEntities = threadRootIndex.threadRootIds
    .map((threadRootId) => {
      const rootMessageId = threadRootIndex.rootMessageIdByThreadRootId.get(threadRootId);
      const rootMessage = rootMessageId ? messageMap.get(rootMessageId) ?? null : null;
      const threadSession = threadSessionById.get(threadRootId) ?? null;
      const syntheticRoot = syntheticRootById.get(threadRootId) ?? null;
      if (!rootMessage && (threadSession || syntheticRoot)) {
        return getEmptyThreadOriginEntity({
          threadRootId,
          workspaceId: threadSession?.workspaceId ?? syntheticRoot!.workspaceId,
          createdAt: threadSession?.createdAt ?? syntheticRoot?.createdAt ?? null,
          title: threadSession?.title ?? null,
        });
      }
      return rootMessage ? getThreadOriginEntity(threadRootId, rootMessage) : null;
    })
    .filter((entity): entity is ProjectedNodeEntity => Boolean(entity));
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
  }));

  const entities = [...threadOriginEntities, ...messageEntities, ...summaryEntities].sort((left, right) => left.sortTs - right.sortTs);
  const entitiesById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const entitiesByMessageId = new Map(messageEntities.map((entity) => [entity.messageId!, entity]));
  const entitiesBySummaryId = new Map(summaryEntities.map((entity) => [entity.summary!.id, entity]));
  const childEntityIdsByParentEntityId = new Map<string, string[]>();
  const controlledEntityIdsByControllerMessageId = new Map<string, string[]>();
  const commitEntityIdsByAssistantEntityId = new Map<string, string[]>();
  const commitProjection = buildCommitProjection(commits, commitParents, commitObservations, sortedMessages, messageMap, threadRootIndex);

  for (const entity of messageEntities) {
    if (entity.parentEntityId) {
      const children = childEntityIdsByParentEntityId.get(entity.parentEntityId) ?? [];
      children.push(entity.entityId);
      childEntityIdsByParentEntityId.set(entity.parentEntityId, children);
    }
    if (entity.controlledByNodeId) {
      const controlled = controlledEntityIdsByControllerMessageId.get(entity.controlledByNodeId) ?? [];
      controlled.push(entity.entityId);
      controlledEntityIdsByControllerMessageId.set(entity.controlledByNodeId, controlled);
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

  for (const controllerEntity of messageEntities) {
    if (!controllerEntity.messageId || controllerEntity.nodeKind !== 'orchestrator') continue;
    const controlledEntityIds = controlledEntityIdsByControllerMessageId.get(controllerEntity.messageId) ?? [];
    controllerEntity.orchestrationSummary = buildProjectedOrchestrationSummary(
      controllerEntity.messageId,
      controlledEntityIds,
      entitiesById,
    );
  }

  const turnGroupMap = new Map<string, ProjectedTurnGroup>();
  for (const message of sortedMessages) {
    if (message.role !== 'user') continue;
    if (classifyMessageNodeKind(message, messageMap) === 'thread_link') continue;
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

  const listItems: ProjectedListItem[] = [];
  for (const entity of messageEntities) {
    if (!entity.messageId) continue;
    listItems.push({ type: 'entity', entityId: entity.entityId, sortTs: entity.sortTs });
  }
  for (const entity of summaryEntities) {
    listItems.push({ type: 'entity', entityId: entity.entityId, sortTs: entity.sortTs });
  }
  listItems.sort((left, right) => left.sortTs - right.sortTs);

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
    controlledEntityIdsByControllerMessageId,
    commitEntityIdsByAssistantEntityId,
    commitBySha: commitProjection.commitBySha,
    commitLaneRows: commitProjection.commitLaneRows,
    layoutDerivedCommitGroups: commitProjection.layoutDerivedCommitGroups,
    groupIdByCommitSha: commitProjection.groupIdByCommitSha,
    threadRootIds: threadRootIndex.threadRootIds,
    threadRootIdByMessageId: threadRootIndex.threadRootIdByMessageId,
    rootMessageIdByThreadRootId: threadRootIndex.rootMessageIdByThreadRootId,
    turnGroups,
    turnGroupById,
    originMessage,
    originMessageId,
    listItems,
    agentCommitShas,
  };
  rememberStableBase(cacheKey, base);
  return base;
}
