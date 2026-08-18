export type ComposerTargetModeForBase = 'reply' | 'new-thread';

export interface ComposerBaseMessage {
  id: string;
  parentId: string | null;
  output_commit_sha?: string | null;
  base_commit_sha?: string | null;
}

export interface ComposerCommitPickerCommit {
  sha: string;
  subject?: string | null;
  parents?: string[];
  produced_by_node_id?: string | null;
  authored_at?: string | null;
  committed_at?: string | null;
}

export interface ComposerCommitPickerRef {
  git_ref: string;
  short_name: string;
  commit_sha: string;
}

export interface ComposerCommitPickerTrackedRef {
  git_ref: string;
  display_name?: string | null;
  enabled?: boolean;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export type ComposerDefaultBaseSource =
  | 'reply-parent-output'
  | 'reply-parent-base'
  | 'latest-ancestor-output'
  | 'main-ref'
  | 'thread-root-base'
  | 'workspace-base'
  | 'none';

export interface ComposerDefaultBaseResolution {
  sha: string | null;
  source: ComposerDefaultBaseSource;
  selectedFromNodeId: string | null;
}

export interface ComposerCommitPickerItem {
  sha: string;
  subject: string;
  primaryLabel: string;
  secondaryLabel: string;
  refNames: string[];
  selected: boolean;
  isDefault: boolean;
  relation: 'default' | 'earlier' | 'later' | 'ref' | 'commit';
  producedByNodeId: string | null;
  searchText: string;
}

export interface ComposerCommitPickerChipItem {
  key: string;
  label: string;
  item: ComposerCommitPickerItem;
}

const normalize = (value: string | null | undefined): string => String(value || '').trim();

export const shortCommitSha = (sha: string | null | undefined): string => {
  const normalized = normalize(sha);
  return normalized ? normalized.slice(0, 8) : 'No commit';
};

const getOutputCommitSha = (message: ComposerBaseMessage | null | undefined): string | null => {
  const sha = normalize(message?.output_commit_sha);
  return sha || null;
};

const getBaseCommitSha = (message: ComposerBaseMessage | null | undefined): string | null => {
  const sha = normalize(message?.base_commit_sha);
  return sha || null;
};

export const findLatestAncestorOutput = (
  messageMap: Map<string, ComposerBaseMessage>,
  startId: string | null | undefined
): { sha: string; nodeId: string } | null => {
  let cursorId = startId ?? null;
  const visited = new Set<string>();

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId);
    const message = messageMap.get(cursorId);
    if (!message) return null;

    const outputSha = getOutputCommitSha(message);
    if (outputSha) return { sha: outputSha, nodeId: message.id };

    cursorId = message.parentId ?? null;
  }

  return null;
};

const findThreadRoot = (
  messageMap: Map<string, ComposerBaseMessage>,
  startId: string | null | undefined
): ComposerBaseMessage | null => {
  let cursor = startId ? messageMap.get(startId) ?? null : null;
  const visited = new Set<string>();
  let latest = cursor;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    latest = cursor;
    cursor = cursor.parentId ? messageMap.get(cursor.parentId) ?? null : null;
  }

  return latest;
};

const isMainRef = (ref: ComposerCommitPickerRef): boolean => (
  ref.git_ref === 'refs/heads/main' || ref.short_name === 'main'
);

export const isInternalAgentreeRefName = (name: string | null | undefined): boolean => {
  const normalized = normalize(name).toLowerCase();
  return (
    normalized === 'agentree' ||
    normalized.startsWith('agentree/') ||
    normalized.startsWith('refs/heads/agentree/') ||
    normalized.startsWith('refs/agentree/')
  );
};

export const getVisibleRefName = (ref: ComposerCommitPickerRef): string | null => {
  if (isInternalAgentreeRefName(ref.git_ref) || isInternalAgentreeRefName(ref.short_name)) return null;
  if (ref.git_ref.startsWith('refs/heads/')) return ref.short_name;
  if (ref.git_ref.startsWith('refs/tags/')) return ref.short_name;
  return ref.short_name || ref.git_ref;
};

export const resolveComposerDefaultBaseCommit = (input: {
  targetMode: ComposerTargetModeForBase;
  replyParentMessageId: string | null;
  selectedNodeId: string | null;
  messages: ComposerBaseMessage[];
  refs: ComposerCommitPickerRef[];
  workspaceBaseCommitSha: string | null | undefined;
}): ComposerDefaultBaseResolution => {
  const messageMap = new Map(input.messages.map((message) => [message.id, message]));

  if (input.targetMode === 'reply' && input.replyParentMessageId) {
    const replyParent = messageMap.get(input.replyParentMessageId) ?? null;
    const replyParentOutput = getOutputCommitSha(replyParent);
    if (replyParentOutput) {
      return {
        sha: replyParentOutput,
        source: 'reply-parent-output',
        selectedFromNodeId: replyParent?.id ?? null,
      };
    }

    const replyParentBase = getBaseCommitSha(replyParent);
    if (replyParentBase) {
      return {
        sha: replyParentBase,
        source: 'reply-parent-base',
        selectedFromNodeId: replyParent?.id ?? null,
      };
    }

    const ancestorOutput = findLatestAncestorOutput(messageMap, replyParent?.parentId ?? null);
    if (ancestorOutput) {
      return {
        sha: ancestorOutput.sha,
        source: 'latest-ancestor-output',
        selectedFromNodeId: ancestorOutput.nodeId,
      };
    }
  }

  if (input.targetMode === 'new-thread') {
    const mainRef = input.refs.find(isMainRef);
    if (mainRef?.commit_sha) {
      return {
        sha: mainRef.commit_sha,
        source: 'main-ref',
        selectedFromNodeId: null,
      };
    }

    const threadRoot = findThreadRoot(messageMap, input.selectedNodeId);
    const threadRootBase = getBaseCommitSha(threadRoot);
    if (threadRootBase) {
      return {
        sha: threadRootBase,
        source: 'thread-root-base',
        selectedFromNodeId: threadRoot?.id ?? null,
      };
    }
  }

  const workspaceBase = normalize(input.workspaceBaseCommitSha);
  return workspaceBase
    ? { sha: workspaceBase, source: 'workspace-base', selectedFromNodeId: null }
    : { sha: null, source: 'none', selectedFromNodeId: null };
};

const trackedDisplayByRef = (
  trackedRefs: ComposerCommitPickerTrackedRef[] = []
): Map<string, string> => {
  const displayByRef = new Map<string, string>();

  for (const ref of trackedRefs) {
    if (ref.enabled === false) continue;
    const gitRef = normalize(ref.git_ref);
    const displayName = normalize(ref.display_name);
    if (!gitRef || isInternalAgentreeRefName(gitRef)) continue;
    if (displayName && !isInternalAgentreeRefName(displayName)) {
      displayByRef.set(gitRef, displayName);
    }
  }

  return displayByRef;
};

const refPriority = (
  refName: string,
  gitRef: string,
  trackedDisplay: Map<string, string>
): number => {
  if (trackedDisplay.has(gitRef)) return 0;
  if (refName === 'main') return 1;
  if (refName === 'master' || refName === 'trunk') return 2;
  if (gitRef.startsWith('refs/heads/')) return 3;
  if (gitRef.startsWith('refs/tags/')) return 4;
  return 5;
};

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const parseTimestamp = (value: string | null | undefined): number => {
  const normalized = normalize(value);
  if (!normalized) return 0;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const buildComposerCommitPickerItems = (input: {
  defaultSha: string | null | undefined;
  effectiveSha: string | null | undefined;
  commits: ComposerCommitPickerCommit[];
  refs: ComposerCommitPickerRef[];
  trackedRefs?: ComposerCommitPickerTrackedRef[];
  query?: string;
  laterCommitShas?: Set<string>;
  earlierCommitShas?: Set<string>;
}): ComposerCommitPickerItem[] => {
  const defaultSha = normalize(input.defaultSha);
  const effectiveSha = normalize(input.effectiveSha);
  const query = normalize(input.query).toLowerCase();
  const trackedDisplay = trackedDisplayByRef(input.trackedRefs);
  const commitBySha = new Map<string, ComposerCommitPickerCommit>();

  for (const commit of input.commits) {
    const sha = normalize(commit.sha);
    if (!sha || commitBySha.has(sha)) continue;
    commitBySha.set(sha, commit);
  }

  for (const ref of input.refs) {
    const sha = normalize(ref.commit_sha);
    if (!sha || commitBySha.has(sha)) continue;
    commitBySha.set(sha, { sha, subject: '' });
  }

  const refsBySha = new Map<string, Array<{ label: string; gitRef: string }>>();
  for (const ref of input.refs) {
    const sha = normalize(ref.commit_sha);
    const visibleRefName = getVisibleRefName(ref);
    if (!sha || !visibleRefName) continue;
    const trackedLabel = trackedDisplay.get(ref.git_ref);
    const labels = unique([trackedLabel ?? '', visibleRefName]);
    if (labels.length === 0) continue;

    const bucket = refsBySha.get(sha) ?? [];
    for (const label of labels) {
      bucket.push({ label, gitRef: ref.git_ref });
    }
    refsBySha.set(sha, bucket);
  }

  const laterCommitShas = input.laterCommitShas ?? new Set<string>();
  const earlierCommitShas = input.earlierCommitShas ?? new Set<string>();

  const items = Array.from(commitBySha.values()).map((commit): ComposerCommitPickerItem => {
    const sha = normalize(commit.sha);
    const subject = normalize(commit.subject) || 'Untitled commit';
    const refEntries = unique(
      (refsBySha.get(sha) ?? [])
        .sort((left, right) => (
          refPriority(left.label, left.gitRef, trackedDisplay) -
          refPriority(right.label, right.gitRef, trackedDisplay)
        ))
        .map((entry) => entry.label)
    );
    const primaryLabel = refEntries[0] || subject || shortCommitSha(sha);
    const relation: ComposerCommitPickerItem['relation'] = sha === defaultSha
      ? 'default'
      : laterCommitShas.has(sha)
        ? 'later'
        : earlierCommitShas.has(sha)
          ? 'earlier'
          : refEntries.length > 0
            ? 'ref'
            : 'commit';
    const searchText = [
      sha,
      shortCommitSha(sha),
      subject,
      ...refEntries,
    ].join(' ').toLowerCase();

    return {
      sha,
      subject,
      primaryLabel,
      secondaryLabel: refEntries.length > 0 && primaryLabel !== subject ? subject : shortCommitSha(sha),
      refNames: refEntries,
      selected: Boolean(effectiveSha && sha === effectiveSha),
      isDefault: Boolean(defaultSha && sha === defaultSha),
      relation,
      producedByNodeId: normalize(commit.produced_by_node_id) || null,
      searchText,
    };
  });

  return items
    .filter((item) => !query || item.searchText.includes(query))
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      const leftHasRef = left.refNames.length > 0;
      const rightHasRef = right.refNames.length > 0;
      if (leftHasRef !== rightHasRef) return leftHasRef ? -1 : 1;
      return left.primaryLabel.localeCompare(right.primaryLabel);
    });
};

export const buildComposerCommitPickerChipItems = (input: {
  items: ComposerCommitPickerItem[];
  refs: ComposerCommitPickerRef[];
  trackedRefs?: ComposerCommitPickerTrackedRef[];
  headSha?: string | null;
  commitRecencyBySha?: Map<string, number>;
  limit?: number;
}): ComposerCommitPickerChipItem[] => {
  const limit = input.limit ?? 6;
  const itemBySha = new Map(input.items.map((item) => [item.sha, item]));
  const trackedByRef = new Map<string, ComposerCommitPickerTrackedRef>();
  for (const ref of input.trackedRefs ?? []) {
    if (ref.enabled === false) continue;
    const gitRef = normalize(ref.git_ref);
    if (!gitRef || isInternalAgentreeRefName(gitRef)) continue;
    trackedByRef.set(gitRef, ref);
  }

  const chips: Array<ComposerCommitPickerChipItem & { rank: number; recency: number }> = [];
  const seen = new Set<string>();
  const pushChip = (
    sha: string,
    label: string,
    gitRef: string,
    rank: number,
    recency: number
  ) => {
    const item = itemBySha.get(sha);
    const normalizedLabel = normalize(label);
    if (!item || !normalizedLabel) return;
    const key = `${gitRef}:${sha}:${normalizedLabel}`;
    if (seen.has(key)) return;
    seen.add(key);
    chips.push({
      key,
      label: normalizedLabel,
      item,
      rank,
      recency,
    });
  };

  for (const ref of input.refs) {
    const sha = normalize(ref.commit_sha);
    const gitRef = normalize(ref.git_ref);
    const visibleRefName = getVisibleRefName(ref);
    if (!sha || !gitRef || !visibleRefName) continue;

    if (gitRef === 'HEAD') {
      pushChip(sha, 'HEAD', gitRef, 1, input.commitRecencyBySha?.get(sha) ?? 0);
      continue;
    }

    const trackedRef = trackedByRef.get(gitRef);
    if (trackedRef) {
      const trackedLabel = normalize(trackedRef.display_name);
      pushChip(
        sha,
        trackedLabel && !isInternalAgentreeRefName(trackedLabel) ? trackedLabel : visibleRefName,
        gitRef,
        0,
        parseTimestamp(trackedRef.updatedAt) || input.commitRecencyBySha?.get(sha) || 0
      );
      continue;
    }

    pushChip(sha, visibleRefName, gitRef, 2, input.commitRecencyBySha?.get(sha) ?? 0);
  }

  const headSha = normalize(input.headSha);
  if (headSha && !seen.has(`HEAD:${headSha}:HEAD`)) {
    pushChip(headSha, 'HEAD', 'HEAD', 1, input.commitRecencyBySha?.get(headSha) ?? 0);
  }

  return chips
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.recency !== right.recency) return right.recency - left.recency;
      return left.label.localeCompare(right.label);
    })
    .slice(0, limit)
    .map(({ rank: _rank, recency: _recency, ...chip }) => chip);
};
