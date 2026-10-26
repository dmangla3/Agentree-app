import { fireEvent, render } from '@testing-library/react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reasoningEffortsByProvider } from '../lib/runtimeModels';
import { UnifiedAgentModelSelector } from './UnifiedAgentModelSelector';

vi.mock('../hooks/useAgents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks/useAgents')>();
  return {
    ...original,
    useAgents: () => ({ data: original.runtimeAgents }),
  };
});

vi.mock('../stores/providerLimitsStore', () => ({
  useProviderLimitsStore: (selector: any) => selector({ byProvider: {} }),
  getProviderLimitSeverity: () => 'normal',
  getProviderLimitWindows: () => [],
  providerLimitKey: (provider: string, profileId?: string | null) => profileId ? `${provider}:${profileId}` : provider,
}));

const readyProfiles = [
  { id: 'codex-ready', provider: 'codex', displayName: 'Codex', authType: 'codex_api_key', status: 'ready', isDefault: true },
  { id: 'claude-ready', provider: 'claude', displayName: 'Claude', authType: 'claude_api_key', status: 'ready', isDefault: true },
];

vi.mock('../stores/loginProfilesStore', () => ({
  useLoginProfilesStore: (selector: any) => selector({
    profiles: readyProfiles,
    isLoading: false,
  }),
}));

let dom: JSDOM;

const visibleFamilyKeys = (container: HTMLElement) => (
  Array.from(container.querySelectorAll<HTMLElement>('[data-model-family-key]'))
    .map((element) => element.dataset.modelFamilyKey)
);

const visibleEfforts = (container: HTMLElement) => (
  Array.from(container.querySelectorAll<HTMLElement>('[data-model-effort]'))
    .map((element) => element.dataset.modelEffort)
);

describe('UnifiedAgentModelSelector runtime catalog', () => {
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every Codex effort from the authoritative runtime catalog', () => {
    const { container } = render(
      <UnifiedAgentModelSelector
        selectedAgentId="codex:gpt-5.6-sol:high"
        onSelectAgent={() => {}}
      />
    );

    expect(visibleEfforts(container)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(container.querySelector('[data-model-effort="max"]')?.textContent).toContain('Maximum Codex reasoning level');
    expect(container.querySelector('[data-model-effort="ultra"]')?.textContent).toContain('Highest supported Codex reasoning level');
  });

  it('renders only supported Claude families with every requested effort and description', () => {
    const { container, getByRole } = render(
      <UnifiedAgentModelSelector
        selectedAgentId="codex:gpt-5.6-sol:high"
        onSelectAgent={() => {}}
      />
    );

    fireEvent.click(getByRole('tab', { name: /Claude/ }));

    const expectedFamilies = [
      'claude:claude-fable-5',
      'claude:claude-opus-5',
      'claude:claude-opus-4-8',
      'claude:claude-sonnet-5',
    ];
    const expectedEfforts = reasoningEffortsByProvider.claude.map((effort) => effort.id);

    expect(visibleFamilyKeys(container)).toEqual(expectedFamilies);

    for (const familyKey of expectedFamilies) {
      const familyButton = container.querySelector<HTMLElement>(`[data-model-family-key="${familyKey}"]`);
      expect(familyButton).not.toBeNull();
      fireEvent.click(familyButton!);

      expect(visibleEfforts(container)).toEqual(expectedEfforts);
      for (const effort of reasoningEffortsByProvider.claude) {
        expect(container.querySelector(`[data-model-effort="${effort.id}"]`)?.textContent).toContain(effort.description);
      }
    }

    expect(container.textContent).not.toContain('Claude Sonnet 4.6');
    expect(container.textContent).not.toContain('Claude Haiku 4.5');
    expect(container.textContent).not.toContain('Maximum effort for Claude Opus 4.8');
  });
});
