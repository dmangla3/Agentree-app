// @vitest-environment jsdom
import '../../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphCanonicalCommitNode } from './GraphCanonicalCommitNode';
import type { ProjectedCommitEntity } from '../../../domain/workspaceProjection';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id }: { id: string }) => <div data-testid={`handle-${id}`} />,
  Position: {
    Top: 'top',
    Bottom: 'bottom',
  },
}));

const makeImportedCommit = (): ProjectedCommitEntity => ({
  entityId: 'commit:imported0001',
  kind: 'imported_commit',
  sha: 'imported0001abcdef',
  shortSha: 'imported',
  subject: 'Imported single commit',
  sourceKind: 'external',
  ownerKind: 'external',
  placement: 'commit_lineage',
  producedByNodeId: null,
  visualOwnerNodeId: null,
  parentShas: [],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: null,
  secondaryParentShas: [],
  observations: [{ commit_sha: 'imported0001abcdef', git_ref: 'refs/heads/main', source_kind: 'external' }],
  sortTs: 0,
  commit: {
    sha: 'imported0001abcdef',
    workspace_id: 'workspace-1',
    subject: 'Imported single commit',
    source_kind: 'external',
    produced_by_node_id: null,
    first_parent_sha: null,
    author_name: 'Ada',
    files_changed_count: 1,
    total_additions: 2,
    total_deletions: 1,
    committed_at: '2026-05-12T00:00:00.000Z',
    authored_at: '2026-05-12T00:00:00.000Z',
  } as ProjectedCommitEntity['commit'],
});

describe('GraphCanonicalCommitNode', () => {
  it('uses the same card surface as an agent-created commit for a single imported commit', () => {
    const { container } = render(
      <GraphCanonicalCommitNode commit={makeImportedCommit()} />
    );

    expect(screen.getByText('Import')).toBeTruthy();
    expect(container.querySelector('.agentree-graph-node-card')).not.toBeNull();
  });
});
