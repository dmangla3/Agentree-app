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
  ownerThreadRootId: overrides.ownerThreadRootId ?? null,
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
  representedThreadRootIds: overrides.representedThreadRootIds ?? [],
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
  it('hides prominent external merges when all represented threads are hidden', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', representedThreadRootIds: ['thread-a'] })],
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

  it('hides generated commits when all represented threads are hidden', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['generated-a', commit({
          sha: 'generated-a',
          ownerKind: 'agentree',
          placement: 'conversation_sidecar',
          isMerge: false,
          isProminentMerge: false,
          representedThreadRootIds: ['thread-a'],
        })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:generated-a', type: 'commit', commitSha: 'generated-a', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(['thread-a']),
      directDependencyCommitShas: new Set(),
    });

    expect(result.visibleCommitShas.has('generated-a')).toBe(false);
    expect(result.referenceCommitShas.has('generated-a')).toBe(false);
    expect(result.visibleCommitLaneRows).toEqual([]);
  });

  it('keeps hidden-owned direct dependencies as references', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', representedThreadRootIds: ['thread-a'] })],
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

  it('hides generated sidecar commits without a resolvable represented thread', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['generated-orphan', commit({
          sha: 'generated-orphan',
          ownerKind: 'agentree',
          placement: 'conversation_sidecar',
          isMerge: false,
          isProminentMerge: false,
          representedThreadRootIds: [],
        })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:generated-orphan', type: 'commit', commitSha: 'generated-orphan', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(),
      directDependencyCommitShas: new Set(),
      hideBackgroundCommits: true,
    });

    expect(result.visibleCommitShas.has('generated-orphan')).toBe(false);
    expect(result.visibleCommitLaneRows).toEqual([]);
  });

  it('keeps unresolved generated direct dependencies as references', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['generated-base', commit({
          sha: 'generated-base',
          ownerKind: 'agentree',
          placement: 'conversation_sidecar',
          isMerge: false,
          isProminentMerge: false,
          representedThreadRootIds: [],
        })],
      ]),
      commitLaneRows: [{ rowId: 'commit-row:generated-base', type: 'commit', commitSha: 'generated-base', sortTs: 1 }],
      layoutDerivedCommitGroups: [],
      hiddenThreadRootIds: new Set(),
      directDependencyCommitShas: new Set(['generated-base']),
      hideBackgroundCommits: true,
    });

    expect(result.visibleCommitShas).toEqual(new Set(['generated-base']));
    expect(result.referenceCommitShas).toEqual(new Set(['generated-base']));
    expect(result.visibleCommitLaneRows).toEqual([
      { rowId: 'commit-row:generated-base', type: 'commit', commitSha: 'generated-base', sortTs: 1 },
    ]);
  });

  it('keeps merges visible when at least one represented thread remains visible', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['merge-a', commit({ sha: 'merge-a', representedThreadRootIds: ['thread-a', 'thread-b'] })],
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
        ['visible-a', commit({ sha: 'visible-a', isMerge: false, isProminentMerge: false, representedThreadRootIds: [] })],
        ['hidden-merge', commit({ sha: 'hidden-merge', representedThreadRootIds: ['thread-a'] })],
        ['visible-b', commit({ sha: 'visible-b', isMerge: false, isProminentMerge: false, representedThreadRootIds: [] })],
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

  it('hides background imported commit groups when requested', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['import-a', commit({ sha: 'import-a', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
        ['import-b', commit({ sha: 'import-b', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
        ['import-c', commit({ sha: 'import-c', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
      ]),
      commitLaneRows: [{ rowId: 'group:import-a-import-b-import-c', type: 'group', groupId: 'group:import-a-import-b-import-c', sortTs: 1 }],
      layoutDerivedCommitGroups: [group(['import-a', 'import-b', 'import-c'])],
      hiddenThreadRootIds: new Set(),
      directDependencyCommitShas: new Set(),
      hideBackgroundCommits: true,
    });

    expect(result.visibleCommitShas.size).toBe(0);
    expect(result.referenceCommitShas.size).toBe(0);
    expect(result.visibleCommitGroups).toEqual([]);
    expect(result.visibleCommitLaneRows).toEqual([]);
  });

  it('keeps imported direct dependencies as reference commits instead of import batches', () => {
    const result = getVisibleCommitProjection({
      commitBySha: new Map([
        ['import-a', commit({ sha: 'import-a', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
        ['import-b', commit({ sha: 'import-b', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
        ['import-c', commit({ sha: 'import-c', kind: 'imported_commit', sourceKind: 'external', isMerge: false, isProminentMerge: false })],
      ]),
      commitLaneRows: [{ rowId: 'group:import-a-import-b-import-c', type: 'group', groupId: 'group:import-a-import-b-import-c', sortTs: 1 }],
      layoutDerivedCommitGroups: [group(['import-a', 'import-b', 'import-c'])],
      hiddenThreadRootIds: new Set(),
      directDependencyCommitShas: new Set(['import-b']),
      hideBackgroundCommits: true,
    });

    expect(result.visibleCommitShas).toEqual(new Set(['import-b']));
    expect(result.referenceCommitShas).toEqual(new Set(['import-b']));
    expect(result.visibleCommitGroups).toEqual([]);
    expect(result.visibleCommitLaneRows).toEqual([
      { rowId: 'commit-row:import-b:reference', type: 'commit', commitSha: 'import-b', sortTs: 1 },
    ]);
  });
});
