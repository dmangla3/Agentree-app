// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';
import type { WorkspacePublicShare } from '../hooks/useWorkspacePublicShare';

const mockShare: WorkspacePublicShare = {
  id: 'share-1',
  publicId: 'public-1',
  workspaceId: 'workspace-1',
  targetType: 'node',
  rootNodeId: 'node-12345678',
  mode: 'live',
  visibility: 'unlisted',
  status: 'active',
  createdAt: '2026-06-03T10:00:00.000Z',
  updatedAt: '2026-06-03T10:00:00.000Z',
  revokedAt: null,
  rootNode: {
    id: 'node-12345678',
    role: 'user',
    workspaceId: 'workspace-1',
    parentId: null,
    aiLabel: 'Release notes thread',
    contentPreview: 'Draft release notes',
    contentLength: 19,
    createdAt: '2026-06-03T09:55:00.000Z',
    updatedAt: '2026-06-03T09:55:00.000Z',
  },
};

vi.mock('../hooks/useWorkspacePublicShare', () => ({
  getPublicShareUrl: (publicId: string) => `https://agentree.app/share/${publicId}`,
  useWorkspacePublicShares: () => ({
    data: { shares: [mockShare] },
    isLoading: false,
  }),
  useRevokePublicShare: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('./Toast', () => ({
  useToastHelpers: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('WorkspaceShareDialog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows when each shared node link was created', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    render(<WorkspaceShareDialog workspaceId="workspace-1" workspaceName="Agentree" />);

    fireEvent.click(screen.getByRole('button', { name: /shared nodes/i }));

    const createdAt = screen.getByText('Created 2 hours ago');
    expect(createdAt.getAttribute('title')).toBe(
      new Date(mockShare.createdAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    );
  });
});
