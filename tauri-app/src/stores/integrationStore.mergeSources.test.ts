import { describe, expect, it } from 'vitest';
import * as integrationStoreModule from './integrationStore';
import type { MergeSource } from './integrationStore';
import type { ProjectedCommitEntity } from '../domain/workspaceProjection';

const source = (commitSha: string, id = commitSha): MergeSource => ({
  id,
  type: 'graph-node',
  label: commitSha,
  commitSha,
  nodeId: id,
});

const commitMap = (parentsBySha: Record<string, string[]>): Map<string, Pick<ProjectedCommitEntity, 'sha' | 'parentShas'>> => (
  new Map(Object.entries(parentsBySha).map(([sha, parentShas]) => [sha, { sha, parentShas }]))
);

describe('merge source pruning', () => {
  it('removes an existing ancestor source when adding a descendant source', () => {
    const getMergeSourcePrunePlan = (integrationStoreModule as {
      getMergeSourcePrunePlan?: (
        existingSources: MergeSource[],
        incomingSources: MergeSource[],
        commitsBySha: Map<string, Pick<ProjectedCommitEntity, 'sha' | 'parentShas'>>
      ) => { sourcesToAdd: MergeSource[]; sourceIdsToRemove: string[]; skippedSources: MergeSource[] };
    }).getMergeSourcePrunePlan;

    expect(typeof getMergeSourcePrunePlan).toBe('function');

    const plan = getMergeSourcePrunePlan?.(
      [source('parent-sha', 'parent-node')],
      [source('child-sha', 'child-node')],
      commitMap({
        'child-sha': ['parent-sha'],
        'parent-sha': [],
      })
    );

    expect(plan).toEqual({
      sourcesToAdd: [source('child-sha', 'child-node')],
      sourceIdsToRemove: ['parent-node'],
      skippedSources: [],
    });
  });

  it('skips an incoming ancestor source when a descendant source is already selected', () => {
    const getMergeSourcePrunePlan = (integrationStoreModule as {
      getMergeSourcePrunePlan?: (
        existingSources: MergeSource[],
        incomingSources: MergeSource[],
        commitsBySha: Map<string, Pick<ProjectedCommitEntity, 'sha' | 'parentShas'>>
      ) => { sourcesToAdd: MergeSource[]; sourceIdsToRemove: string[]; skippedSources: MergeSource[] };
    }).getMergeSourcePrunePlan;

    expect(typeof getMergeSourcePrunePlan).toBe('function');

    const plan = getMergeSourcePrunePlan?.(
      [source('child-sha', 'child-node')],
      [source('parent-sha', 'parent-node')],
      commitMap({
        'child-sha': ['parent-sha'],
        'parent-sha': [],
      })
    );

    expect(plan).toEqual({
      sourcesToAdd: [],
      sourceIdsToRemove: [],
      skippedSources: [source('parent-sha', 'parent-node')],
    });
  });

  it('keeps only the descendant when incoming sources contain an ancestor and child together', () => {
    const getMergeSourcePrunePlan = (integrationStoreModule as {
      getMergeSourcePrunePlan?: (
        existingSources: MergeSource[],
        incomingSources: MergeSource[],
        commitsBySha: Map<string, Pick<ProjectedCommitEntity, 'sha' | 'parentShas'>>
      ) => { sourcesToAdd: MergeSource[]; sourceIdsToRemove: string[]; skippedSources: MergeSource[] };
    }).getMergeSourcePrunePlan;

    expect(typeof getMergeSourcePrunePlan).toBe('function');

    const plan = getMergeSourcePrunePlan?.(
      [],
      [source('parent-sha', 'parent-node'), source('child-sha', 'child-node')],
      commitMap({
        'child-sha': ['parent-sha'],
        'parent-sha': [],
      })
    );

    expect(plan).toEqual({
      sourcesToAdd: [source('child-sha', 'child-node')],
      sourceIdsToRemove: [],
      skippedSources: [source('parent-sha', 'parent-node')],
    });
  });

  it('removes a stale selected ancestor when the incoming descendant is already selected', () => {
    const getMergeSourcePrunePlan = (integrationStoreModule as {
      getMergeSourcePrunePlan?: (
        existingSources: MergeSource[],
        incomingSources: MergeSource[],
        commitsBySha: Map<string, Pick<ProjectedCommitEntity, 'sha' | 'parentShas'>>
      ) => { sourcesToAdd: MergeSource[]; sourceIdsToRemove: string[]; skippedSources: MergeSource[] };
    }).getMergeSourcePrunePlan;

    expect(typeof getMergeSourcePrunePlan).toBe('function');

    const plan = getMergeSourcePrunePlan?.(
      [source('parent-sha', 'parent-node'), source('child-sha', 'child-node')],
      [source('child-sha', 'child-node')],
      commitMap({
        'child-sha': ['parent-sha'],
        'parent-sha': [],
      })
    );

    expect(plan).toEqual({
      sourcesToAdd: [],
      sourceIdsToRemove: ['parent-node'],
      skippedSources: [source('child-sha', 'child-node')],
    });
  });
});
