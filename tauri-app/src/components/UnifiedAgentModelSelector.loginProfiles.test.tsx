import { fireEvent, render } from '@testing-library/react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_PROFILES_NAVIGATION_EVENT } from '../lib/loginNavigationEvents';
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
        id: 'codex:gpt-6:low',
        type: 'codex',
        name: 'Codex Low',
        model_config: {
          model: 'gpt-6',
          familyKey: 'codex:gpt-6',
          familyLabel: 'GPT-6',
          reasoningEffort: 'low',
          effortLabel: 'Low',
        },
      },
      {
        id: 'codex:gpt-image-2',
        type: 'codex',
        name: 'GPT Image 2',
        model_config: {
          model: 'gpt-image-2',
          familyKey: 'codex:gpt-image-2',
          familyLabel: 'GPT Image 2',
          effortLabel: 'Image',
          capabilities: {
            inputModalities: ['text', 'image'],
            outputModalities: ['text', 'image'],
            reasoningEffort: false,
          },
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

let dom: JSDOM;

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
    dom = new JSDOM('<!doctype html><html><body></body></html>');
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows selecting models for providers with a ready selected profile', () => {
    const onSelectAgent = vi.fn();

    const { getAllByText, getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    fireEvent.click(getAllByText('GPT-5.5')[0]);
    fireEvent.click(getByText('High'));

    expect(onSelectAgent).toHaveBeenCalledWith('codex:gpt-5.5:high');
  });

  it('blocks Codex image models for ChatGPT session profiles', () => {
    profileState.profiles = [
      { id: 'codex-chatgpt', provider: 'codex', displayName: 'Codex Subscription', authType: 'codex_chatgpt_session', status: 'ready', isDefault: true },
    ];
    const onSelectAgent = vi.fn();

    const { getAllByText, getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    fireEvent.click(getAllByText('GPT Image 2')[0]);
    const imageRow = getByText('Image').closest('[role="button"]');

    expect(imageRow?.getAttribute('aria-disabled')).toBe('true');
    expect(imageRow?.getAttribute('title')).toContain('not available through a Codex ChatGPT subscription');
    fireEvent.click(getByText('Image'));
    expect(onSelectAgent).not.toHaveBeenCalledWith('codex:gpt-image-2');

    fireEvent.click(getAllByText('GPT-5.5')[0]);
    fireEvent.click(getByText('High'));
    expect(onSelectAgent).toHaveBeenCalledWith('codex:gpt-5.5:high');
  });

  it('allows Codex image models for API key profiles', () => {
    const onSelectAgent = vi.fn();

    const { getAllByText, getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    fireEvent.click(getAllByText('GPT Image 2')[0]);
    fireEvent.click(getByText('Image'));

    expect(onSelectAgent).toHaveBeenCalledWith('codex:gpt-image-2');
  });

  it('dims and blocks models whose provider lacks a ready selected profile', () => {
    const onSelectAgent = vi.fn();
    const loginIntent = vi.fn();
    window.addEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, loginIntent);

    const { getByText } = render(<UnifiedAgentModelSelector selectedAgentId={null} onSelectAgent={onSelectAgent} />);
    expect(getByText('Opus 4.5').closest('section')?.getAttribute('data-login-provider-active')).toBe('false');
    fireEvent.click(getByText('Opus 4.5'));

    fireEvent.click(getByText('Login to Claude'));
    expect(loginIntent).toHaveBeenCalled();
    expect((loginIntent.mock.calls[0][0] as CustomEvent).detail).toEqual({ provider: 'claude' });
    expect(onSelectAgent).not.toHaveBeenCalled();
    window.removeEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, loginIntent);
  });

  it('hides the effort picker for inactive providers', () => {
    const onSelectAgent = vi.fn();

    const { queryByText, getByText, getAllByText } = render(
      <UnifiedAgentModelSelector
        selectedAgentId="claude:opus-4.5:high"
        onSelectAgent={onSelectAgent}
      />
    );

    expect(queryByText('Thinking effort')).toBeNull();
    expect(getByText('Claude login required')).toBeTruthy();
    expect(getAllByText('Login to Claude').length).toBeGreaterThan(0);
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

  it('delays switching families while the pointer is moving diagonally toward the effort panel', () => {
    vi.useFakeTimers();
    const onSelectAgent = vi.fn();

    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      const element = this;
      if (element.getAttribute('data-model-family-list') === 'true') {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 300,
          bottom: 220,
          width: 300,
          height: 220,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (element.getAttribute('data-model-effort-column') === 'true') {
        return {
          x: 320,
          y: 0,
          left: 320,
          top: 0,
          right: 560,
          bottom: 220,
          width: 240,
          height: 220,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const { getAllByText, getByText, queryByText } = render(
      <UnifiedAgentModelSelector selectedAgentId="codex:gpt-5.5:high" onSelectAgent={onSelectAgent} />
    );

    const activeFamily = getAllByText('GPT-5.5')[0].closest('button')!;
    const nextFamily = getByText('GPT-6').closest('button')!;

    fireEvent.pointerEnter(activeFamily, { clientX: 120, clientY: 72 });
    fireEvent.pointerEnter(nextFamily, { clientX: 170, clientY: 118 });
    fireEvent.pointerMove(nextFamily, { clientX: 170, clientY: 118 });

    expect(queryByText('Low')).toBeNull();
    expect(getByText('High')).toBeTruthy();

    vi.advanceTimersByTime(300);

    expect(getByText('Low')).toBeTruthy();
  });

  it('does not draw selection chrome on the selected family while another family is active', () => {
    const onSelectAgent = vi.fn();

    const { getAllByText, getByText } = render(
      <UnifiedAgentModelSelector selectedAgentId="codex:gpt-5.5:high" onSelectAgent={onSelectAgent} />
    );

    const selectedFamily = getAllByText('GPT-5.5')[0].closest('button')!;
    const previewFamily = getByText('GPT-6').closest('button')!;

    fireEvent.pointerEnter(previewFamily, { clientX: 120, clientY: 118 });

    expect(selectedFamily.getAttribute('aria-pressed')).toBe('false');
    expect(previewFamily.getAttribute('aria-pressed')).toBe('true');
    expect(selectedFamily.className).not.toContain('shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.4)]');
    expect(selectedFamily.querySelector('span[aria-hidden="true"]')?.className).not.toContain('opacity-100');
  });
});
