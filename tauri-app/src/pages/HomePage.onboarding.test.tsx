// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  searchParams: new URLSearchParams(),
  hasCompletedOnboarding: false,
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
      hasCompletedForUser: () => mocks.hasCompletedOnboarding,
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
vi.mock('../hooks/useHotSendMessageDeltas', () => ({ useHotSendMessageDeltas: vi.fn() }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
  useSearchParams: () => [mocks.searchParams],
}));

vi.mock('../components/onboarding/FirstRunExperience', () => ({
  FirstRunExperience: ({ reviewMode }: { reviewMode?: boolean }) => (
    <div data-testid="first-run" data-review-mode={reviewMode ? 'true' : 'false'}>First run</div>
  ),
}));

vi.mock('../components/AppHeader', () => ({ AppHeader: () => <div /> }));
vi.mock('../components/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../components/navigation/WorkspaceNavigator', () => ({ WorkspaceNavigator: () => <div /> }));
vi.mock('../composer/GraphDockComposer', () => ({ GraphDockComposer: () => <div /> }));
vi.mock('../../@/components/ui/resizable', () => ({
  ResizableHandle: () => <div />,
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../lib/analytics', () => ({
  bucketCount: vi.fn(() => '1'),
  trackScreenViewed: vi.fn(),
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
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
    mocks.searchParams = new URLSearchParams();
    mocks.hasCompletedOnboarding = false;
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  it('uses the local workspace list independently of the signed-in account id', async () => {
    mocks.workspaces = [workspace('local-workspace', 'local-owner')];

    render(<HomePage />);

    await waitFor(() => {
      expect(mocks.markCompleted).toHaveBeenCalledWith('new-user', 'local-workspace');
    });
  });

  it('opens a safe onboarding preview after onboarding is complete', async () => {
    mocks.hasCompletedOnboarding = true;
    mocks.searchParams = new URLSearchParams('designReview=onboarding&designReviewRun=1');

    const view = render(<HomePage />);

    expect(view.getByTestId('first-run').getAttribute('data-review-mode')).toBe('true');
  });
});
