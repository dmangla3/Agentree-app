// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../../@/components/ui/dialog';
import { WorktreePolicyPanel } from './WorktreePolicyButton';

const mocks = vi.hoisted(() => ({
  getAgentWorktreeConfig: vi.fn(),
  saveAgentWorktreeConfig: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({
  DEFAULT_AGENT_WORKTREE_CONFIG: {
    dependencyLinkDirs: ['node_modules'],
    copyEnvFiles: true,
    envFilePatterns: ['.env*'],
    commitExcludePatterns: [],
    blockDependencyMutationCommands: true,
  },
  agentClient: {
    getAgentWorktreeConfig: mocks.getAgentWorktreeConfig,
    saveAgentWorktreeConfig: mocks.saveAgentWorktreeConfig,
    getAgentSandboxRoot: vi.fn().mockResolvedValue('/tmp/agentree'),
  },
}));

const defaultPolicy = {
  config: {
    dependencyLinkDirs: ['node_modules'],
    copyEnvFiles: true,
    envFilePatterns: ['.env*'],
    commitExcludePatterns: [],
    blockDependencyMutationCommands: true,
  },
  configPath: '/repo/.agentree/config.json',
  source: 'default',
};

describe('WorktreePolicyPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentWorktreeConfig.mockResolvedValue(defaultPolicy);
  });

  it('continues with defaults from the onboarding policy prompt', async () => {
    const onContinueWithDefaultPolicy = vi.fn();

    render(
      <Dialog open>
        <WorktreePolicyPanel
          repoPath="/repo"
          onContinueWithDefaultPolicy={onContinueWithDefaultPolicy}
        />
      </Dialog>
    );

    const continueButton = await screen.findByRole('button', {
      name: 'Continue with default policy',
    });
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(continueButton);

    expect(onContinueWithDefaultPolicy).toHaveBeenCalledOnce();
    expect(mocks.saveAgentWorktreeConfig).not.toHaveBeenCalled();
  });

  it('keeps the unchanged save action disabled outside the prompt', async () => {
    render(
      <Dialog open>
        <WorktreePolicyPanel repoPath="/repo" />
      </Dialog>
    );

    const saveButton = await screen.findByRole('button', { name: 'Save policy' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });
});
