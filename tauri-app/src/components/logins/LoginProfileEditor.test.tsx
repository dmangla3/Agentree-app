import { fireEvent, render, waitFor } from '@testing-library/react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginProfileEditor } from './LoginProfileEditor';

vi.mock('../../../@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

describe('LoginProfileEditor', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  it('hides advanced config for Codex API key profiles even when config exists', () => {
    const { queryByLabelText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={{
          id: 'profile-codex',
          provider: 'codex',
          displayName: 'Codex Work',
          authType: 'codex_api_key',
          redactedHint: 'sk-proj...cdef',
          config: { openai_project_id: 'proj_123' },
          status: 'ready',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(queryByLabelText('Advanced config JSON')).toBeNull();
  });

  it('uses an OpenAI API key field for Codex API key secrets', () => {
    const { getByLabelText, getByPlaceholderText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={null}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(getByLabelText('OpenAI API key')).toBeTruthy();
    expect(getByPlaceholderText('sk-...')).toBeTruthy();
  });

  it('hides advanced config for new common login types', () => {
    const { queryByLabelText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={null}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(queryByLabelText('Advanced config JSON')).toBeNull();
  });

  it('does not show a secret field for Codex managed sessions', () => {
    const { getByText, queryByLabelText, queryByText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={{
          id: 'profile-codex',
          provider: 'codex',
          displayName: 'Codex Work',
          authType: 'codex_chatgpt_session',
          redactedHint: '{ "au...Z" }',
          config: {},
          status: 'unchecked',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(getByText('Connect')).toBeTruthy();
    expect(getByText('Save')).toBeTruthy();
    expect(queryByLabelText('Session JSON')).toBeNull();
    expect(queryByText('Current secret:')).toBeNull();
  });

  it('hides internal Codex managed session implementation details', () => {
    const { queryByLabelText, queryByText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={{
          id: 'profile-codex',
          provider: 'codex',
          displayName: 'Codex Work',
          authType: 'codex_chatgpt_session',
          redactedHint: '{ "au...Z" }',
          config: { live_check_model: 'gpt-5.5' },
          status: 'unchecked',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(queryByText('Managed session profile')).toBeNull();
    expect(queryByText('Isolated CODEX_HOME')).toBeNull();
    expect(queryByText('Refresh state persisted')).toBeNull();
    expect(queryByText('Per-account limits')).toBeNull();
    expect(queryByLabelText('Advanced config JSON')).toBeNull();
  });

  it('shows a copy button for the Codex device sign in code', async () => {
    const onSave = vi.fn().mockResolvedValue({
      id: 'profile-codex',
      provider: 'codex',
      displayName: 'Codex Work',
      authType: 'codex_chatgpt_session',
      config: {},
      status: 'checking',
      isDefault: true,
    });
    const onConnectCodex = vi.fn().mockResolvedValue({
      profileId: 'profile-codex',
      deviceUrl: 'https://auth.openai.com/codex/device',
      deviceCode: '1K96-KUM0M',
    });
    const { getByText } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={{
          id: 'profile-codex',
          provider: 'codex',
          displayName: 'Codex Work',
          authType: 'codex_chatgpt_session',
          config: {},
          status: 'unchecked',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={onSave}
        onConnectCodex={onConnectCodex}
      />
    );

    fireEvent.click(getByText('Connect'));

    await waitFor(() => expect(getByText('1K96-KUM0M')).toBeTruthy());
    expect(getByText('Copy code')).toBeTruthy();
  });

  it('closes after a Codex managed session profile becomes ready', async () => {
    const onOpenChange = vi.fn();
    const profile = {
      id: 'profile-codex',
      provider: 'codex',
      displayName: 'Codex Work',
      authType: 'codex_chatgpt_session',
      config: {},
      status: 'checking',
      isDefault: true,
    } as const;
    const { getByText, rerender } = render(
      <LoginProfileEditor
        open
        provider="codex"
        profile={profile}
        isSaving={false}
        error={null}
        onOpenChange={onOpenChange}
        onSave={vi.fn().mockResolvedValue(profile)}
        onConnectCodex={vi.fn().mockResolvedValue({
          profileId: 'profile-codex',
          deviceUrl: 'https://auth.openai.com/codex/device',
          deviceCode: '1K96-KUM0M',
        })}
      />
    );

    fireEvent.click(getByText('Connect'));
    await waitFor(() => expect(getByText('1K96-KUM0M')).toBeTruthy());

    rerender(
      <LoginProfileEditor
        open
        provider="codex"
        profile={{ ...profile, status: 'ready' }}
        isSaving={false}
        error={null}
        onOpenChange={onOpenChange}
        onSave={vi.fn().mockResolvedValue({ ...profile, status: 'ready' })}
        onConnectCodex={vi.fn()}
      />
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
