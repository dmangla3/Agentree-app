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
  ownerThreadRootId: null,
  parentShas: [],
  parentRows: [],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: null,
  secondaryParentShas: [],
  observations: [{ commit_sha: 'imported0001abcdef', git_ref: 'refs/heads/main', source_kind: 'external' }],
  sortTs: 0,
  representedThreadRootIds: [],
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

const makeGeneratedCommit = (isMerged: boolean): ProjectedCommitEntity => ({
  ...makeImportedCommit(),
  kind: 'generated_commit',
  ownerKind: 'agentree',
  placement: 'conversation_sidecar',
  producedByNodeId: 'assistant-1',
  visualOwnerNodeId: 'assistant-1',
  isMerged,
  commit: {
    ...makeImportedCommit().commit,
    source_kind: 'agent',
    produced_by_node_id: 'assistant-1',
    is_merged: isMerged,
  },
});

describe('GraphCanonicalCommitNode', () => {
  it('uses the same card surface as an agent-created commit for a single imported commit', () => {
    const { container } = render(
      <GraphCanonicalCommitNode commit={makeImportedCommit()} />
    );

    expect(screen.getByText('Import')).toBeTruthy();
    expect(container.querySelector('.agentree-graph-node-card')).not.toBeNull();
  });

  it('renders merged generated commits with the confident green treatment', () => {
    const { container } = render(<GraphCanonicalCommitNode commit={makeGeneratedCommit(true)} />);
    expect(container.querySelector('.agentree-commit-merged')).not.toBeNull();
    expect(container.querySelector('.agentree-commit-unmerged')).toBeNull();
  });

  it('renders unmerged generated commits with the muted treatment', () => {
    const { container } = render(<GraphCanonicalCommitNode commit={makeGeneratedCommit(false)} />);
    expect(container.querySelector('.agentree-commit-unmerged')).not.toBeNull();
    expect(container.querySelector('.agentree-commit-merged')).toBeNull();
  });
});
