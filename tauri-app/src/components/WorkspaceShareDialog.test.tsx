// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';

const useWorkspacePublicShares = vi.fn((_workspaceId: string | null) => ({
  data: { shares: [] },
  isLoading: false,
}));

vi.mock('../hooks/useWorkspacePublicShare', () => ({
  getPublicShareUrl: (publicId: string) => `https://agentree.app/share/${publicId}`,
  useWorkspacePublicShares: (workspaceId: string | null) => useWorkspacePublicShares(workspaceId),
  useRevokePublicShare: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('./Toast', () => ({
  useToastHelpers: () => ({ success: vi.fn(), error: vi.fn() }),
}));

describe('WorkspaceShareDialog', () => {
  it('does not contact cloud when a local-only workspace opens share management', () => {
    render(
      <WorkspaceShareDialog
        workspaceId="workspace-1"
        workspaceName="Agentree"
        cloudSyncEnabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /shared nodes/i }));

    expect(screen.getByText(/nothing from this workspace is stored/i)).toBeTruthy();
    expect(useWorkspacePublicShares).toHaveBeenLastCalledWith(null);
  });
});
