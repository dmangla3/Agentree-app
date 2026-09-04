import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedCommitLaneRow } from '../domain/workspaceProjection';

interface GetVisibleCommitProjectionInput {
  commitBySha: Map<string, ProjectedCommitEntity>;
  commitLaneRows: ProjectedCommitLaneRow[];
  layoutDerivedCommitGroups: ProjectedCommitGroup[];
  hiddenThreadRootIds: Set<string>;
  directDependencyCommitShas: Set<string>;
  hideBackgroundCommits?: boolean;
}

interface VisibleCommitProjection {
  visibleCommitShas: Set<string>;
  referenceCommitShas: Set<string>;
  visibleCommitLaneRows: ProjectedCommitLaneRow[];
  visibleCommitGroups: ProjectedCommitGroup[];
}

const isRepresentedOnlyByHiddenThreads = (
  commit: ProjectedCommitEntity,
  hiddenThreadRootIds: Set<string>,
): boolean => {
  if (commit.representedThreadRootIds.length === 0) return false;
  return commit.representedThreadRootIds.every((threadRootId) => hiddenThreadRootIds.has(threadRootId));
};

const shouldHideOwnedCommit = (
  commit: ProjectedCommitEntity,
  hiddenThreadRootIds: Set<string>,
): boolean => {
  return isRepresentedOnlyByHiddenThreads(commit, hiddenThreadRootIds);
};

const isBackgroundImportCommit = (commit: ProjectedCommitEntity): boolean => (
  commit.placement === 'commit_lineage' &&
  (commit.kind === 'imported_commit' || (commit.sourceKind === 'external' && commit.ownerKind === 'external'))
);

const isUnresolvedGeneratedSidecarCommit = (commit: ProjectedCommitEntity): boolean => (
  commit.ownerKind === 'agentree' &&
  commit.placement === 'conversation_sidecar' &&
  commit.representedThreadRootIds.length === 0
);

export const getVisibleCommitProjection = ({
  commitBySha,
  commitLaneRows,
  layoutDerivedCommitGroups,
  hiddenThreadRootIds,
  directDependencyCommitShas,
  hideBackgroundCommits = false,
}: GetVisibleCommitProjectionInput): VisibleCommitProjection => {
  const visibleCommitShas = new Set<string>();
  const referenceCommitShas = new Set<string>();

  if (hiddenThreadRootIds.size === 0 && !hideBackgroundCommits) {
    commitBySha.forEach((_commit, sha) => visibleCommitShas.add(sha));
    return {
      visibleCommitShas,
      referenceCommitShas,
      visibleCommitLaneRows: commitLaneRows,
      visibleCommitGroups: layoutDerivedCommitGroups,
    };
  }

  commitBySha.forEach((commit, sha) => {
    const directDependency = directDependencyCommitShas.has(sha);
    const hiddenOwned = shouldHideOwnedCommit(commit, hiddenThreadRootIds);
    const backgroundImport = hideBackgroundCommits && isBackgroundImportCommit(commit);
    const unresolvedGenerated = hideBackgroundCommits && isUnresolvedGeneratedSidecarCommit(commit);
    const hiddenByVisibilityPolicy = hiddenOwned || backgroundImport || unresolvedGenerated;
    if (hiddenByVisibilityPolicy && !directDependency) return;
    visibleCommitShas.add(sha);
    if (hiddenByVisibilityPolicy && directDependency) {
      referenceCommitShas.add(sha);
    }
  });

  const originalToVisibleGroup = new Map<string, ProjectedCommitGroup>();
  const referenceRowsByOriginalGroup = new Map<string, ProjectedCommitLaneRow[]>();
  const visibleCommitGroups: ProjectedCommitGroup[] = [];

  for (const group of layoutDerivedCommitGroups) {
    const visibleShas = group.commitShas.filter((sha) => visibleCommitShas.has(sha));
    if (visibleShas.length === 0) continue;
    if (hideBackgroundCommits && group.sourceKind === 'external') {
      referenceRowsByOriginalGroup.set(group.groupId, visibleShas.map((sha) => ({
        rowId: `commit-row:${sha}:reference`,
        type: 'commit',
        commitSha: sha,
        sortTs: group.sortTs,
      })));
      continue;
    }
    const visibleGroup: ProjectedCommitGroup = {
      ...group,
      groupId: visibleShas.length === group.commitShas.length
        ? group.groupId
        : `${group.groupId}:visible:${visibleShas.join(':')}`,
      commitShas: visibleShas,
      firstSha: visibleShas[0],
      lastSha: visibleShas[visibleShas.length - 1],
    };
    visibleCommitGroups.push(visibleGroup);
    originalToVisibleGroup.set(group.groupId, visibleGroup);
  }

  const visibleCommitLaneRows = commitLaneRows.flatMap((row): ProjectedCommitLaneRow[] => {
    if (row.type === 'commit') {
      return row.commitSha && visibleCommitShas.has(row.commitSha) ? [row] : [];
    }

    if (!row.groupId) return [];
    const referenceRows = referenceRowsByOriginalGroup.get(row.groupId);
    if (referenceRows) return referenceRows.map((referenceRow) => ({ ...referenceRow, sortTs: row.sortTs }));
    const visibleGroup = originalToVisibleGroup.get(row.groupId);
    if (!visibleGroup) return [];
    return [{ ...row, groupId: visibleGroup.groupId, rowId: visibleGroup.groupId }];
  });

  return {
    visibleCommitShas,
    referenceCommitShas,
    visibleCommitLaneRows,
    visibleCommitGroups,
  };
};
