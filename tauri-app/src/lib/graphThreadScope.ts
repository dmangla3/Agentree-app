import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Summary } from '../stores/workspaceStore';
import { getMessageOutputCommitSha } from './graph/commitAccessors';
import type { ThreadRootIndex } from './graphThreadRoots';
import { getLatestThreadMessageId } from './graphThreadRoots';

export interface ThreadSelectionItem {
  threadRootId: string;
  lastUpdatedAt?: number;
  done?: boolean;
  runningCount?: number;
}

export interface ThreadGraphScope {
  activeThreadRootId: string | null;
  rootMessageId: string | null;
  latestMessageId: string | null;
  scopedMessageIds: Set<string>;
  scopedMessages: Message[];
  isThreadScoped: boolean;
}

export interface ThreadScopedCommitContext {
  commits: CommitEntity[];
  commitParents: CommitParentEntity[];
  commitObservations: CommitObservationEntity[];
}

export const getThreadScopeKey = (
  workspaceId: string | null | undefined,
  activeThreadRootId: string | null | undefined,
): string => `${workspaceId ?? 'workspace-none'}:${activeThreadRootId ?? 'all'}`;

export const resolveInitialActiveThreadRootId = ({
  preferredThreadRootId,
  threadRootIds,
  threadItems,
}: {
  preferredThreadRootId: string | null | undefined;
  threadRootIds: string[];
  threadItems: ThreadSelectionItem[];
}): string | null => {
  const available = new Set(threadRootIds);
  if (preferredThreadRootId && available.has(preferredThreadRootId)) {
    return preferredThreadRootId;
  }

  const byRecent = (left: ThreadSelectionItem, right: ThreadSelectionItem) => (
    (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0) ||
    left.threadRootId.localeCompare(right.threadRootId)
  );

  const running = threadItems
    .filter((item) => available.has(item.threadRootId) && (item.runningCount ?? 0) > 0)
    .sort(byRecent);
  if (running[0]) return running[0].threadRootId;

  const open = threadItems
    .filter((item) => available.has(item.threadRootId) && !item.done)
    .sort(byRecent);
  if (open[0]) return open[0].threadRootId;

  const any = threadItems
    .filter((item) => available.has(item.threadRootId))
    .sort(byRecent);
  return any[0]?.threadRootId ?? threadRootIds[0] ?? null;
};

export const resolveThreadGraphScope = ({
  messages,
  threadRootIndex,
  activeThreadRootId,
}: {
  messages: Message[];
  threadRootIndex: ThreadRootIndex;
  activeThreadRootId: string | null | undefined;
}): ThreadGraphScope => {
  const threadMessageIds = activeThreadRootId
    ? threadRootIndex.messageIdsByThreadRootId.get(activeThreadRootId) ?? null
    : null;

  if (!activeThreadRootId || !threadMessageIds || threadMessageIds.size === 0) {
    return {
      activeThreadRootId: null,
      rootMessageId: null,
      latestMessageId: null,
      scopedMessageIds: new Set(messages.map((message) => message.id)),
      scopedMessages: messages,
      isThreadScoped: false,
    };
  }

  return {
    activeThreadRootId,
    rootMessageId: threadRootIndex.rootMessageIdByThreadRootId.get(activeThreadRootId) ?? activeThreadRootId,
    latestMessageId: getLatestThreadMessageId(activeThreadRootId, messages),
    scopedMessageIds: new Set(threadMessageIds),
    scopedMessages: messages.filter((message) => threadMessageIds.has(message.id)),
    isThreadScoped: true,
  };
};

export const filterSummariesForThreadScope = (
  summaries: Summary[],
  scope: ThreadGraphScope,
): Summary[] => {
  if (!scope.isThreadScoped) return summaries;
  return summaries.filter((summary) => (
    scope.scopedMessageIds.has(summary.startMessageId) &&
    scope.scopedMessageIds.has(summary.endMessageId)
  ));
};

export const filterCommitContextForThreadScope = ({
  messages,
  scope,
  commits,
  commitParents,
  commitObservations,
}: {
  messages: Message[];
  scope: ThreadGraphScope;
  commits: CommitEntity[];
  commitParents: CommitParentEntity[];
  commitObservations: CommitObservationEntity[];
}): ThreadScopedCommitContext => {
  if (!scope.isThreadScoped) {
    return { commits, commitParents, commitObservations };
  }

  const scopedMessageIds = new Set(messages.map((message) => message.id));
  const scopedOutputCommitShas = new Set<string>();
  for (const message of messages) {
    const outputCommitSha = getMessageOutputCommitSha(message);
    if (outputCommitSha) scopedOutputCommitShas.add(outputCommitSha);
  }

  const scopedCommits = commits.filter((commit) => (
    scopedOutputCommitShas.has(commit.sha) ||
    Boolean(commit.produced_by_node_id && scopedMessageIds.has(commit.produced_by_node_id))
  ));
  const scopedCommitShas = new Set(scopedCommits.map((commit) => commit.sha));

  return {
    commits: scopedCommits,
    commitParents: commitParents.filter((parent) => scopedCommitShas.has(parent.child_sha)),
    commitObservations: commitObservations.filter((observation) => scopedCommitShas.has(observation.commit_sha)),
  };
};

export const getInactiveThreadRootIds = (
  threadRootIds: string[],
  activeThreadRootId: string | null | undefined,
): Set<string> => {
  if (!activeThreadRootId) return new Set();
  return new Set(threadRootIds.filter((threadRootId) => threadRootId !== activeThreadRootId));
};
