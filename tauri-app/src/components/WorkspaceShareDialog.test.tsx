// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';

const refetchPublicShares = vi.fn();
const useWorkspacePublicShares = vi.fn();

vi.mock('../hooks/useWorkspacePublicShare', () => ({
  getPublicShareUrl: (publicId: string) => `https://agentree.app/share/${publicId}`,
  useWorkspacePublicShares: (workspaceId: string | null) => useWorkspacePublicShares(workspaceId),
  useRevokePublicShare: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('./Toast', () => ({
  useToastHelpers: () => ({ success: vi.fn(), error: vi.fn() }),
}));

describe('WorkspaceShareDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacePublicShares.mockReturnValue({
      data: { shares: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: refetchPublicShares,
    });
  });

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

  it('shows an initial load failure instead of a false empty state and allows retry', () => {
    useWorkspacePublicShares.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: refetchPublicShares,
    });

    render(
      <WorkspaceShareDialog
        workspaceId="workspace-1"
        workspaceName="Agentree"
        cloudSyncEnabled
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /shared nodes/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/unable to load shared node links/i);
    expect(screen.queryByText(/no active public node links/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetchPublicShares).toHaveBeenCalledTimes(1);
  });

  it('keeps cached shares visible when refreshing them fails', () => {
    useWorkspacePublicShares.mockReturnValue({
      data: {
        shares: [{
          id: 'share-1',
          publicId: 'public-1',
          rootNodeId: 'node-1',
          createdAt: '2026-07-30T05:00:00.000Z',
          rootNode: { aiLabel: 'Cached shared node' },
        }],
      },
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: refetchPublicShares,
    });

    render(
      <WorkspaceShareDialog
        workspaceId="workspace-1"
        workspaceName="Agentree"
        cloudSyncEnabled
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /shared nodes/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/unable to refresh shared node links/i);
    expect(screen.getByText('Cached shared node')).toBeTruthy();
    expect(screen.queryByText(/no active public node links/i)).toBeNull();
  });
});
