import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedCommitLaneRow } from '../domain/workspaceProjection';

interface GetVisibleCommitProjectionInput {
  commitBySha: Map<string, ProjectedCommitEntity>;
  commitLaneRows: ProjectedCommitLaneRow[];
  layoutDerivedCommitGroups: ProjectedCommitGroup[];
  hiddenThreadRootIds: Set<string>;
  directDependencyCommitShas: Set<string>;
}

interface VisibleCommitProjection {
  visibleCommitShas: Set<string>;
  referenceCommitShas: Set<string>;
  visibleCommitLaneRows: ProjectedCommitLaneRow[];
  visibleCommitGroups: ProjectedCommitGroup[];
}

const isOwnedOnlyByHiddenThreads = (
  commit: ProjectedCommitEntity,
  hiddenThreadRootIds: Set<string>,
): boolean => {
  if (commit.owningThreadRootIds.length === 0) return false;
  return commit.owningThreadRootIds.every((threadRootId) => hiddenThreadRootIds.has(threadRootId));
};

const shouldHideOwnedCommit = (
  commit: ProjectedCommitEntity,
  hiddenThreadRootIds: Set<string>,
): boolean => {
  if (!commit.isProminentMerge) return false;
  return isOwnedOnlyByHiddenThreads(commit, hiddenThreadRootIds);
};

export const getVisibleCommitProjection = ({
  commitBySha,
  commitLaneRows,
  layoutDerivedCommitGroups,
  hiddenThreadRootIds,
  directDependencyCommitShas,
}: GetVisibleCommitProjectionInput): VisibleCommitProjection => {
  const visibleCommitShas = new Set<string>();
  const referenceCommitShas = new Set<string>();

  if (hiddenThreadRootIds.size === 0) {
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
    if (hiddenOwned && !directDependency) return;
    visibleCommitShas.add(sha);
    if (hiddenOwned && directDependency) {
      referenceCommitShas.add(sha);
    }
  });

  const originalToVisibleGroup = new Map<string, ProjectedCommitGroup>();
  const visibleCommitGroups: ProjectedCommitGroup[] = [];

  for (const group of layoutDerivedCommitGroups) {
    const visibleShas = group.commitShas.filter((sha) => visibleCommitShas.has(sha));
    if (visibleShas.length === 0) continue;
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
