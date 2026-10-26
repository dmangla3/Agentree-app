// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstRunExperience } from './FirstRunExperience';

const mocks = vi.hoisted(() => ({
  checkLocalEnvironment: vi.fn(),
  checkAllLoginProfiles: vi.fn(),
  refreshLoginProfiles: vi.fn(),
  discoverImportCandidates: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../hooks/useWorkspaces', () => ({
  RepoPrepareActionRequiredError: class RepoPrepareActionRequiredError extends Error {},
  useCreateWorkspace: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../lib/agentClient', () => ({
  agentClient: { checkLocalEnvironment: mocks.checkLocalEnvironment },
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({ dispatchFocus: vi.fn() }),
}));
vi.mock('../../stores/loginProfilesStore', () => ({
  useLoginProfilesStore: (selector: (state: unknown) => unknown) => selector({
    profiles: [{
      id: 'codex-profile',
      provider: 'codex',
      displayName: 'Codex',
      authType: 'codex_chatgpt_session',
      status: 'ready',
      isDefault: true,
    }],
    isMutating: false,
    error: null,
    refresh: mocks.refreshLoginProfiles,
    saveProfile: vi.fn(),
    connectCodexProfile: vi.fn(),
    connectClaudeOauthProfile: vi.fn(),
    pollClaudeOauthProfile: vi.fn(),
    submitClaudeOauthCode: vi.fn(),
    checkProfile: vi.fn(),
    checkAllProfiles: mocks.checkAllLoginProfiles,
    discoverImportCandidates: mocks.discoverImportCandidates,
    importCandidate: vi.fn(),
  }),
}));
vi.mock('../Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../ChangedFilesSummary', () => ({ ChangedFilesSummary: () => null }));
vi.mock('../logins/LoginProfileEditor', () => ({ LoginProfileEditor: () => null }));
vi.mock('../ModelVisibilitySettingsPanel', () => ({
  ModelVisibilitySettingsPanel: ({ showHeader }: { showHeader?: boolean }) => (
    <div data-testid="model-visibility-settings" data-show-header={String(showHeader)} />
  ),
}));
vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackOnboardingStepViewed: vi.fn(),
}));
vi.mock('../../lib/finalizeCreatedWorkspace', () => ({ finalizeCreatedWorkspace: vi.fn() }));

describe('FirstRunExperience model selection step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkLocalEnvironment.mockResolvedValue({
      git: { installed: true, version: 'git version 2.50.0', error: null },
      codex: { installed: true, version: 'codex 0.144.1', error: null },
      codex_auth: { installed: true, version: null, error: null },
      claude: { installed: true, version: null, error: null },
      claude_auth: { installed: false, version: null, error: null },
    });
    mocks.checkAllLoginProfiles.mockResolvedValue(undefined);
    mocks.refreshLoginProfiles.mockResolvedValue(undefined);
    mocks.discoverImportCandidates.mockResolvedValue([]);
  });

  it('places the shared model visibility page before repository selection', async () => {
    const view = render(
      <FirstRunExperience
        userName="Example"
        workspaces={[]}
        onSelectWorkspace={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    expect(view.getByText('Step 1 of 3')).toBeTruthy();
    const continueToModels = view.getByRole('button', { name: 'Continue to models' });
    await waitFor(() => expect((continueToModels as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(continueToModels);
    expect(await view.findByText('Step 2 of 3')).toBeTruthy();
    expect(view.getByText('Choose your models')).toBeTruthy();
    expect(view.getByTestId('model-visibility-settings').dataset.showHeader).toBe('false');

    fireEvent.click(view.getByRole('button', { name: 'Continue to workspace' }));
    expect(await view.findByText('Step 3 of 3')).toBeTruthy();
    expect(view.getByText('Select a repository')).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(await view.findByText('Choose your models')).toBeTruthy();
  });
});
