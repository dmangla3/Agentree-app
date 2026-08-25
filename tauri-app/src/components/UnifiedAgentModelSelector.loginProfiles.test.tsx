import { fireEvent, render } from '@testing-library/react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedAgentModelSelector } from './UnifiedAgentModelSelector';

vi.mock('../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [
      {
        id: 'codex:gpt-5.5:high',
        type: 'codex',
        name: 'Codex High',
        model_config: {
          model: 'gpt-5.5',
          familyKey: 'codex:gpt-5.5',
          familyLabel: 'GPT-5.5',
          reasoningEffort: 'high',
          effortLabel: 'High',
        },
      },
      {
        id: 'claude:opus-4.5:high',
        type: 'claude',
        name: 'Claude Opus High',
        model_config: {
          model: 'opus-4.5',
          familyKey: 'claude:opus-4.5',
          familyLabel: 'Opus 4.5',
          reasoningEffort: 'high',
          effortLabel: 'High',
        },
      },
    ],
  }),
}));

vi.mock('../stores/providerLimitsStore', () => ({
  useProviderLimitsStore: (selector: any) => selector({ byProvider: {} }),
  getProviderLimitSeverity: () => 'normal',
  getProviderLimitWindows: () => [],
  providerLimitKey: (provider: string, profileId?: string | null) => profileId ? `${provider}:${profileId}` : provider,
}));

const profileState = {
  profiles: [] as any[],
  isLoading: false,
};

vi.mock('../stores/loginProfilesStore', () => ({
  useLoginProfilesStore: (selector: any) => selector(profileState),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    checkRuntimeReadiness: vi.fn(async (provider: string) => ({
      provider,
      status: 'ready',
      message: 'Ready',
      diagnostics: { browserPreview: true },
    })),
  },
}));

describe('UnifiedAgentModelSelector login profile gating', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    profileState.profiles = [
      { id: 'codex-ready', provider: 'codex', displayName: 'Codex Work', authType: 'codex_api_key', status: 'ready', isDefault: true },
      { id: 'claude-expired', provider: 'claude', displayName: 'Claude Old', authType: 'claude_api_key', status: 'expired', isDefault: true },
    ];
  });

  it('allows selecting models for providers with a ready selected profile', () => {
    const onSelectAgent = vi.fn();

    const { getAllByText, getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    fireEvent.click(getAllByText('GPT-5.5')[0]);
    fireEvent.click(getByText('High'));

    expect(onSelectAgent).toHaveBeenCalledWith('codex:gpt-5.5:high');
  });

  it('dims and blocks models whose provider lacks a ready selected profile', () => {
    const onSelectAgent = vi.fn();

    const { getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    expect(getByText('Opus 4.5').closest('section')?.getAttribute('data-login-provider-active')).toBe('false');
    fireEvent.click(getByText('Opus 4.5'));

    expect(getByText('Login inactive')).toBeTruthy();
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it('falls back to external runtime readiness when no managed profile exists', () => {
    profileState.profiles = [];
    const onSelectAgent = vi.fn();

    const { getAllByText } = render(
      <UnifiedAgentModelSelector
        selectedAgentId={null}
        onSelectAgent={onSelectAgent}
        externalRuntimeReadinessByProvider={{
          codex: { provider: 'codex', status: 'ready', message: 'Codex ready', diagnostics: {} } as any,
        }}
      />
    );
    fireEvent.click(getAllByText('GPT-5.5')[0]);
    fireEvent.click(getAllByText('High')[0]);

    expect(onSelectAgent).toHaveBeenCalledWith('codex:gpt-5.5:high');
  });
});
