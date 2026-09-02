// @vitest-environment jsdom
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import type { Workspace } from '../stores/workspaceStore';

const mocks = vi.hoisted(() => ({
  user: { id: 'new-user', name: 'New User', email: 'new@example.com' },
  workspaces: [] as Workspace[],
  isLoadingWorkspaces: false,
  selectedWorkspaceId: null as string | null,
  markCompleted: vi.fn(),
  selectWorkspace: vi.fn(),
  clearSelectedWorkspace: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({ user: mocks.user }),
}));

vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: () => ({
    selectedWorkspaceId: mocks.selectedWorkspaceId,
    selectWorkspace: mocks.selectWorkspace,
    clearSelectedWorkspace: mocks.clearSelectedWorkspace,
    isFloatingChatInputOpen: false,
    floatingChatInputParentId: null,
    closeFloatingChatInput: vi.fn(),
  }),
}));

vi.mock('../stores/onboardingStore', () => ({
  useOnboardingStore: (selector: (state: unknown) => unknown) =>
    selector({
      hasCompletedForUser: () => false,
      markCompleted: mocks.markCompleted,
    }),
}));

vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    data: mocks.workspaces,
    isLoading: mocks.isLoadingWorkspaces,
    isFetching: false,
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('../components/onboarding/FirstRunExperience', () => ({
  FirstRunExperience: () => <div data-testid="first-run">First run</div>,
}));

vi.mock('../components/AppHeader', () => ({ AppHeader: () => <div /> }));
vi.mock('../components/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../components/navigation/WorkspaceNavigator', () => ({ WorkspaceNavigator: () => <div /> }));
vi.mock('../components/ChatInput', () => ({ ChatInput: () => <div /> }));
vi.mock('../../@/components/ui/resizable', () => ({
  ResizableHandle: () => <div />,
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../lib/analytics', () => ({ trackScreenViewed: vi.fn() }));
vi.mock('../lib/appLogger', () => ({ devLogLazy: vi.fn() }));
vi.mock('../lib/perfRecorder', () => ({
  getElapsedSinceAppStartMs: vi.fn(() => 0),
  recordPerfEvent: vi.fn(),
}));
vi.mock('../lib/graphChatSplitLayout', () => ({
  DEFAULT_GRAPH_CHAT_SPLIT: [100, 0],
  getGraphChatRestoreSplit: vi.fn(() => [65, 35]),
  readRememberedGraphChatSplit: vi.fn(() => null),
  rememberGraphChatSplit: vi.fn((layout: number[]) => layout),
}));

const workspace = (id: string, userId: string): Workspace => ({
  id,
  name: id,
  userId,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
});

describe('HomePage onboarding gate', () => {
  beforeEach(() => {
    mocks.workspaces = [];
    mocks.isLoadingWorkspaces = false;
    mocks.selectedWorkspaceId = null;
    vi.clearAllMocks();
  });

  it('uses the server-scoped workspace list without local user-id filtering', async () => {
    mocks.workspaces = [workspace('workspace-from-server', 'server-user')];

    render(<HomePage />);

    await waitFor(() => {
      expect(mocks.markCompleted).toHaveBeenCalledWith('new-user', 'workspace-from-server');
    });
  });
});
