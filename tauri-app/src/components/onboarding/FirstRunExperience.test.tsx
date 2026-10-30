// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstRunExperience } from './FirstRunExperience';

const mocks = vi.hoisted(() => ({
  checkLocalEnvironment: vi.fn(),
  checkAllLoginProfiles: vi.fn(),
  refreshLoginProfiles: vi.fn(),
  discoverImportCandidates: vi.fn(),
  profiles: [] as Array<Record<string, unknown>>,
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
    profiles: mocks.profiles,
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
    document.documentElement.removeAttribute('data-design-onboarding');
    mocks.profiles = [{
      id: 'codex-profile',
      provider: 'codex',
      displayName: 'Codex',
      authType: 'codex_chatgpt_session',
      status: 'ready',
      isDefault: true,
    }];
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
  }, 10_000);

  it('allows preview navigation while blocking setup actions', async () => {
    const view = render(
      <FirstRunExperience
        userName="Example"
        workspaces={[]}
        onSelectWorkspace={vi.fn()}
        onComplete={vi.fn()}
        reviewMode
      />
    );

    await waitFor(() => expect(view.getByRole('button', { name: 'Run tests' })).toBeTruthy());
    expect(mocks.checkLocalEnvironment).not.toHaveBeenCalled();
    expect(mocks.checkAllLoginProfiles).not.toHaveBeenCalled();
    expect(mocks.discoverImportCandidates).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Run tests' }));
    expect(mocks.checkLocalEnvironment).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Continue to models' }));
    expect(await view.findByText('Step 2 of 3')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Continue to workspace' }));
    expect(await view.findByText('Step 3 of 3')).toBeTruthy();
  });

  it('groups compact environment statuses and shows a calm setup notice when no provider is ready', async () => {
    mocks.profiles = [];

    const view = render(
      <FirstRunExperience
        userName="Example"
        workspaces={[]}
        onSelectWorkspace={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    expect(await view.findByRole('list', { name: 'Environment requirements' })).toBeTruthy();
    expect(view.getAllByRole('listitem')).toHaveLength(4);
    expect(view.getByText('Finish login setup.')).toBeTruthy();
    expect((view.getByRole('button', { name: 'Continue to models' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('covers the pre-redesign onboarding shell and environment row variant without styling After', async () => {
    mocks.profiles = [];
    const styles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = styles;
    document.head.append(style);

    const view = render(
      <FirstRunExperience
        userName="Example"
        workspaces={[]}
        onSelectWorkspace={vi.fn()}
        onComplete={vi.fn()}
        reviewMode
      />
    );

    const aside = view.container.querySelector<HTMLElement>('[data-design-part="onboarding-aside"]');
    const stepCard = view.container.querySelector<HTMLElement>('[data-design-part="onboarding-step-card"]');
    const statusRow = await waitFor(() => {
      const row = view.container.querySelector<HTMLElement>('[data-design-part="onboarding-status-row"]');
      expect(row).toBeTruthy();
      return row!;
    });

    expect(aside).toBeTruthy();
    expect(stepCard).toBeTruthy();
    expect(['pending', 'checking', 'ready', 'missing']).toContain(statusRow.dataset.status);

    document.documentElement.setAttribute('data-design-onboarding', 'before');
    expect(getComputedStyle(aside!).width).toBe('38%');
    expect(getComputedStyle(stepCard!).backdropFilter).toBe('blur(24px)');
    expect(getComputedStyle(statusRow).display).toBe('flex');
    expect(getComputedStyle(statusRow).borderRadius).toBe('0.75rem');

    document.documentElement.setAttribute('data-design-onboarding', 'after');
    expect(styles).not.toContain('data-design-onboarding="after"');

    style.remove();
  });
});
