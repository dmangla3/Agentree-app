import type { BranchPointer, CommitEntity, Message, TrackedGitRef } from '../stores/workspaceStore';
import { getBranchPointerCommitSha, getBranchPointerDisplayName, getMessageOutputCommitSha } from './graph/commitAccessors';

export type ComposerCodeBaseSourceKind =
  | 'reply-target-output'
  | 'ancestor-output'
  | 'new-thread-previous'
  | 'focused-commit'
  | 'workspace-base'
  | 'selected-commit'
  | 'tracked-ref'
  | 'branch-pointer'
  | 'conversation-commit';

export type ComposerCodeBaseGroup = 'recommended' | 'tracked' | 'conversation' | 'other';

export interface ComposerResolvedCodeBase {
  commitSha: string;
  sourceKind: ComposerCodeBaseSourceKind;
  primaryLabel: string;
  secondaryLabel: string;
  badge: string;
  producedByNodeId?: string | null;
}

export interface ComposerCodeBaseOption extends ComposerResolvedCodeBase {
  id: string;
  group: ComposerCodeBaseGroup;
  groupLabel: string;
  shortSha: string;
  selected: boolean;
  gitRef?: string | null;
  subject?: string | null;
  searchText: string;
  commit?: CommitEntity | null;
}

export interface ResolveComposerDefaultCodeBaseInput {
  targetMode: 'reply' | 'new-thread';
  replyParentMessageId: string | null;
  selectedNodeMessageId: string | null;
  focusedCommitSha: string | null;
  previousCommitSha: string | null;
  workspaceBaseCommitSha: string | null;
  messages: Message[];
}

export interface BuildComposerCodeBaseOptionsInput {
  defaultCodeBase: ComposerResolvedCodeBase | null;
  effectiveCommitSha: string | null;
  selectedCommit: CommitEntity | null;
  ancestorCommits: CommitEntity[];
  descendantCommits: CommitEntity[];
  branchPointers: BranchPointer[];
  trackedRefs: TrackedGitRef[];
}

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const shortSha = (commitSha: string | null | undefined): string => (
  normalizeString(commitSha)?.slice(0, 8) ?? 'No commit'
);

const normalizeRefName = (value: string | null | undefined): string | null => {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/agentree\/pointers\//, '');
};

const getCommitSubject = (commit: CommitEntity | null | undefined): string | null => (
  normalizeString(commit?.subject)
);

const messagePreview = (message: Message | null | undefined): string | null => {
  if (!message) return null;
  return normalizeString(message.aiLabel)
    ?? normalizeString(message.git_branch_name)
    ?? normalizeString(message.content);
};

const makeResolved = (
  commitSha: string | null | undefined,
  sourceKind: ComposerCodeBaseSourceKind,
  primaryLabel: string,
  secondaryLabel: string,
  badge: string,
  producedByNodeId?: string | null
): ComposerResolvedCodeBase | null => {
  const normalizedSha = normalizeString(commitSha);
  if (!normalizedSha) return null;
  return {
    commitSha: normalizedSha,
    sourceKind,
    primaryLabel,
    secondaryLabel,
    badge,
    producedByNodeId: producedByNodeId ?? null,
  };
};

const findNearestAssistantOutput = (
  startMessage: Message | null | undefined,
  messageById: Map<string, Message>
): { message: Message; commitSha: string } | null => {
  const visited = new Set<string>();
  let cursor = startMessage ?? null;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const outputCommitSha = getMessageOutputCommitSha(cursor);
    if (cursor.role === 'assistant' && outputCommitSha) {
      return { message: cursor, commitSha: outputCommitSha };
    }
    cursor = cursor.parentId ? messageById.get(cursor.parentId) ?? null : null;
  }

  return null;
};

export const resolveComposerDefaultCodeBase = ({
  targetMode,
  replyParentMessageId,
  selectedNodeMessageId,
  focusedCommitSha,
  previousCommitSha,
  workspaceBaseCommitSha,
  messages,
}: ResolveComposerDefaultCodeBaseInput): ComposerResolvedCodeBase | null => {
  const messageById = new Map(messages.map((message) => [message.id, message]));

  if (targetMode === 'new-thread') {
    return makeResolved(
      previousCommitSha,
      'new-thread-previous',
      'Previous code base',
      'New thread starts from the prior composer commit',
      'previous'
    ) ?? makeResolved(
      focusedCommitSha,
      'focused-commit',
      'Focused commit',
      'Graph commit selected before starting a new thread',
      'focused'
    ) ?? makeResolved(
      workspaceBaseCommitSha,
      'workspace-base',
      'Workspace base',
      'Initial workspace commit',
      'base'
    );
  }

  const replyTarget = replyParentMessageId ? messageById.get(replyParentMessageId) ?? null : null;
  const replyOutput = findNearestAssistantOutput(replyTarget, messageById);
  if (replyOutput) {
    const isReplyAssistantOutput = replyOutput.message.id === replyTarget?.id;
    return makeResolved(
      replyOutput.commitSha,
      isReplyAssistantOutput ? 'reply-target-output' : 'ancestor-output',
      isReplyAssistantOutput ? 'Default for this target' : 'Nearest ancestor commit',
      messagePreview(replyOutput.message) ?? (isReplyAssistantOutput ? 'Reply target output' : 'Assistant ancestor output'),
      isReplyAssistantOutput ? 'reply target' : 'ancestor',
      replyOutput.message.id
    );
  }

  const selectedMessage = selectedNodeMessageId ? messageById.get(selectedNodeMessageId) ?? null : null;
  const selectedOutput = findNearestAssistantOutput(selectedMessage, messageById);
  if (selectedOutput) {
    return makeResolved(
      selectedOutput.commitSha,
      'ancestor-output',
      'Nearest selected commit',
      messagePreview(selectedOutput.message) ?? 'Selected node ancestry',
      'ancestor',
      selectedOutput.message.id
    );
  }

  return makeResolved(
    focusedCommitSha,
    'focused-commit',
    'Focused commit',
    'Graph commit selected directly',
    'focused'
  ) ?? makeResolved(
    workspaceBaseCommitSha,
    'workspace-base',
    'Workspace base',
    'Initial workspace commit',
    'base'
  );
};

const groupLabel = (group: ComposerCodeBaseGroup): string => {
  switch (group) {
    case 'recommended':
      return 'Recommended';
    case 'tracked':
      return 'Tracked refs';
    case 'conversation':
      return 'Conversation commits';
    case 'other':
      return 'Other commits';
  }
};

const makeSearchText = (parts: Array<string | null | undefined>): string => (
  parts
    .map((part) => normalizeString(part))
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase()
);

const makeOption = (
  base: ComposerResolvedCodeBase,
  input: {
    id: string;
    group: ComposerCodeBaseGroup;
    selected: boolean;
    gitRef?: string | null;
    subject?: string | null;
    commit?: CommitEntity | null;
    extraSearch?: Array<string | null | undefined>;
  }
): ComposerCodeBaseOption => ({
  ...base,
  id: input.id,
  group: input.group,
  groupLabel: groupLabel(input.group),
  selected: input.selected,
  gitRef: input.gitRef ?? null,
  subject: input.subject ?? null,
  commit: input.commit ?? null,
  shortSha: shortSha(base.commitSha),
  searchText: makeSearchText([
    base.commitSha,
    shortSha(base.commitSha),
    base.primaryLabel,
    base.secondaryLabel,
    base.badge,
    input.gitRef,
    input.subject,
    ...(input.extraSearch ?? []),
  ]),
});

export const buildComposerCodeBaseOptions = ({
  defaultCodeBase,
  effectiveCommitSha,
  selectedCommit,
  ancestorCommits,
  descendantCommits,
  branchPointers,
  trackedRefs,
}: BuildComposerCodeBaseOptionsInput): ComposerCodeBaseOption[] => {
  const options: ComposerCodeBaseOption[] = [];
  const seen = new Set<string>();
  const selectedSha = normalizeString(effectiveCommitSha);

  const push = (option: ComposerCodeBaseOption, dedupeKey: string = option.id) => {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    options.push(option);
  };

  if (defaultCodeBase) {
    push(makeOption(defaultCodeBase, {
      id: `default-${defaultCodeBase.commitSha}`,
      group: 'recommended',
      selected: selectedSha === defaultCodeBase.commitSha,
    }));
  }

  if (selectedCommit && selectedSha) {
    const subject = getCommitSubject(selectedCommit);
    push(makeOption({
      commitSha: selectedSha,
      sourceKind: 'selected-commit',
      primaryLabel: subject ?? 'Selected commit',
      secondaryLabel: 'Manually selected code base',
      badge: 'pinned',
      producedByNodeId: selectedCommit.produced_by_node_id ?? null,
    }, {
      id: `selected-${selectedSha}`,
      group: 'recommended',
      selected: true,
      subject,
      commit: selectedCommit,
    }));
  }

  for (const trackedRef of trackedRefs) {
    if (!trackedRef.enabled) continue;
    const commitSha = normalizeString(trackedRef.last_seen_commit_sha);
    if (!commitSha) continue;
    const displayName = normalizeString(trackedRef.display_name) ?? normalizeRefName(trackedRef.git_ref) ?? trackedRef.git_ref;
    push(makeOption({
      commitSha,
      sourceKind: 'tracked-ref',
      primaryLabel: displayName,
      secondaryLabel: normalizeRefName(trackedRef.git_ref) ?? trackedRef.git_ref,
      badge: 'tracked',
    }, {
      id: `tracked-${trackedRef.id}`,
      group: 'tracked',
      selected: selectedSha === commitSha,
      gitRef: trackedRef.git_ref,
      extraSearch: [trackedRef.display_name],
    }));
  }

  for (const pointer of branchPointers) {
    const commitSha = getBranchPointerCommitSha(pointer);
    const name = getBranchPointerDisplayName(pointer);
    if (!commitSha || !name) continue;
    push(makeOption({
      commitSha,
      sourceKind: 'branch-pointer',
      primaryLabel: name,
      secondaryLabel: pointer.is_ship_path ? 'Ship path branch' : normalizeRefName(pointer.git_ref) ?? pointer.git_ref,
      badge: pointer.is_ship_path ? 'ship' : 'branch',
      producedByNodeId: pointer.node_id ?? null,
    }, {
      id: `branch-${pointer.id}`,
      group: 'tracked',
      selected: selectedSha === commitSha,
      gitRef: pointer.git_ref,
      subject: getCommitSubject(pointer.commit),
      commit: pointer.commit ?? null,
      extraSearch: [pointer.name, pointer.node?.content, pointer.node?.git_branch_name],
    }), `branch-${pointer.git_ref}-${commitSha}`);
  }

  const addCommit = (commit: CommitEntity, group: ComposerCodeBaseGroup, badge: string, prefix: string) => {
    const commitSha = normalizeString(commit.sha);
    if (!commitSha) return;
    const subject = getCommitSubject(commit);
    push(makeOption({
      commitSha,
      sourceKind: 'conversation-commit',
      primaryLabel: subject ?? shortSha(commitSha),
      secondaryLabel: commit.produced_by_node_id ? `Generated by ${commit.produced_by_node_id}` : 'Imported commit',
      badge,
      producedByNodeId: commit.produced_by_node_id ?? null,
    }, {
      id: `${prefix}-${commitSha}`,
      group,
      selected: selectedSha === commitSha,
      subject,
      commit,
      extraSearch: [commit.produced_by_node_id, commit.author_name, commit.source_kind],
    }));
  };

  for (const commit of ancestorCommits) {
    addCommit(commit, 'conversation', 'earlier', 'ancestor');
  }
  for (const commit of descendantCommits) {
    addCommit(commit, 'conversation', 'later', 'descendant');
  }

  return options;
};

const scoreOption = (option: ComposerCodeBaseOption, query: string): number => {
  const normalizedQuery = query.toLowerCase();
  if (option.commitSha.toLowerCase().startsWith(normalizedQuery)) return 0;
  if (option.shortSha.toLowerCase().startsWith(normalizedQuery)) return 1;
  if ((option.gitRef ?? '').toLowerCase().includes(normalizedQuery)) return 2;
  if (option.primaryLabel.toLowerCase().includes(normalizedQuery)) return 3;
  if ((option.subject ?? '').toLowerCase().includes(normalizedQuery)) return 4;
  if (option.searchText.includes(normalizedQuery)) return 5;
  return Number.MAX_SAFE_INTEGER;
};

export const filterComposerCodeBaseOptions = (
  options: ComposerCodeBaseOption[],
  query: string
): ComposerCodeBaseOption[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return options;

  return options
    .map((option, index) => ({ option, index, score: scoreOption(option, normalizedQuery) }))
    .filter((entry) => entry.score < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.option);
};
