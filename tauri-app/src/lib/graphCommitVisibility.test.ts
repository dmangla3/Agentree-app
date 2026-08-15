import { describe, expect, it } from 'vitest';
import type { ProjectedCommitEntity, ProjectedCommitGroup } from '../domain/workspaceProjection';
import { getVisibleCommitProjection } from './graphCommitVisibility';

const commit = (overrides: Partial<ProjectedCommitEntity>): ProjectedCommitEntity => ({
  entityId: `commit:${overrides.sha ?? 'sha'}`,
  kind: overrides.kind ?? 'merge_commit',
  sha: overrides.sha ?? 'sha',
  shortSha: (overrides.sha ?? 'sha').slice(0, 8),
  subject: overrides.subject ?? overrides.sha ?? 'sha',
  sourceKind: overrides.sourceKind ?? 'external',
  ownerKind: overrides.ownerKind ?? 'external',
  placement: overrides.placement ?? 'commit_lineage',
  producedByNodeId: overrides.producedByNodeId ?? null,
  visualOwnerNodeId: overrides.visualOwnerNodeId ?? null,
  parentShas: overrides.parentShas ?? [],
  parentRows: overrides.parentRows ?? [],
  isMerge: overrides.isMerge ?? true,
  isProminentMerge: overrides.isProminentMerge ?? true,
  layoutParentSha: overrides.layoutParentSha ?? null,
  secondaryParentShas: overrides.secondaryParentShas ?? [],
  observations: overrides.observations ?? [],
  commit: overrides.commit ?? {
    workspace_id: 'workspace-1',
    sha: overrides.sha ?? 'sha',
    subject: overrides.subject ?? null,
    source_kind: overrides.sourceKind ?? 'external',
    produced_by_node_id: overrides.producedByNodeId ?? null,
    first_parent_sha: overrides.layoutParentSha ?? null,
  },
  sortTs: overrides.sortTs ?? 0,
  owningThreadRootIds: overrides.owningThreadRootIds ?? [],
});

const group = (commitShas: string[]): ProjectedCommitGroup => ({
  groupId: `group:${commitShas.join('-')}`,
  kind: 'layout_derived_commit_group',
  sourceKind: 'external',
  commitShas,
  firstSha: commitShas[0],
  lastSha: commitShas[commitShas.length - 1],
  parentSha: null,
  childSha: null,
  sortTs: 0,
  expanded: false,
});

describe('graph commit visibility', () => {
  it('hides prominent external merges when all owning threads are hidden', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', owningThreadRootIds: ['thread-a'] })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:merge-a', type: 'commit', commitSha: 'merge-a', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(['thread-a']),
      directDependencyCommitShas: new Set(),
    });

    expect(result.visibleCommitShas.has('merge-a')).toBe(false);
    expect(result.referenceCommitShas.has('merge-a')).toBe(false);
    expect(result.visibleCommitLaneRows).toEqual([]);
  });

  it('keeps hidden-owned direct dependencies as references', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', owningThreadRootIds: ['thread-a'] })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:merge-a', type: 'commit', commitSha: 'merge-a', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(['thread-a']),
      directDependencyCommitShas: new Set(['merge-a']),
    });

    expect(result.visibleCommitShas.has('merge-a')).toBe(true);
    expect(result.referenceCommitShas.has('merge-a')).toBe(true);
    expect(result.visibleCommitLaneRows).toHaveLength(1);
  });

  it('keeps merges visible when at least one owning thread remains visible', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', owningThreadRootIds: ['thread-a', 'thread-b'] })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:merge-a', type: 'commit', commitSha: 'merge-a', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(['thread-a']),
      directDependencyCommitShas: new Set(),
    });

    expect(result.visibleCommitShas.has('merge-a')).toBe(true);
    expect(result.referenceCommitShas.has('merge-a')).toBe(false);
  });

  it('filters grouped imports by visible commit membership', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['visible-a', commit({ sha: 'visible-a', isMerge: false, isProminentMerge: false, owningThreadRootIds: [] })],
        ['hidden-merge', commit({ sha: 'hidden-merge', owningThreadRootIds: ['thread-a'] })],
        ['visible-b', commit({ sha: 'visible-b', isMerge: false, isProminentMerge: false, owningThreadRootIds: [] })],
      ]),
      commitLaneRows: [{ rowId: 'group:visible-a-hidden-merge-visible-b', type: 'group', groupId: 'group:visible-a-hidden-merge-visible-b', sortTs: 1 }],
      layoutDerivedCommitGroups: [group(['visible-a', 'hidden-merge', 'visible-b'])],
      hiddenThreadRootIds: new Set(['thread-a']),
      directDependencyCommitShas: new Set(),
    });

    expect(result.visibleCommitGroups[0].commitShas).toEqual(['visible-a', 'visible-b']);
  });

  it('returns original rows and groups when no threads are hidden', () => {
    const commitBySha = new Map([
      ['visible-a', commit({ sha: 'visible-a', isMerge: false, isProminentMerge: false })],
      ['visible-b', commit({ sha: 'visible-b', isMerge: false, isProminentMerge: false })],
    ]);
    const laneRows = [{ rowId: 'group:visible-a-visible-b', type: 'group' as const, groupId: 'group:visible-a-visible-b', sortTs: 1 }];
    const groups = [group(['visible-a', 'visible-b'])];

    const result = getVisibleCommitProjection({
      commitBySha,
      commitLaneRows: laneRows,
      layoutDerivedCommitGroups: groups,
      hiddenThreadRootIds: new Set(),
      directDependencyCommitShas: new Set(),
    });

    expect(result.visibleCommitShas).toEqual(new Set(['visible-a', 'visible-b']));
    expect(result.referenceCommitShas.size).toBe(0);
    expect(result.visibleCommitLaneRows).toBe(laneRows);
    expect(result.visibleCommitGroups).toBe(groups);
  });
});
