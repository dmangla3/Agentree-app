import { fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    dom.window.HTMLElement.prototype.attachEvent = () => {};
    dom.window.HTMLElement.prototype.detachEvent = () => {};
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
    const { getByLabelText, getByPlaceholderText, getByText } = render(
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

    fireEvent.click(getByText('API key'));

    expect(getByLabelText('OpenAI API key')).toBeTruthy();
    expect(getByPlaceholderText('sk-...')).toBeTruthy();
  });

  it('labels Codex authentication options as ChatGPT subscription and API key', () => {
    const { getByText, queryByText } = render(
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

    expect(getByText('ChatGPT subscription')).toBeTruthy();
    expect(getByText('API key')).toBeTruthy();
    expect(queryByText('ChatGPT session')).toBeNull();
  });

  it('labels Claude authentication options as Claude subscription and API key', () => {
    const { getByText } = render(
      <LoginProfileEditor
        open
        provider="claude"
        profile={null}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(getByText('Claude subscription')).toBeTruthy();
    expect(getByText('API key')).toBeTruthy();
  });

  it('loads the current isolated auth.json when editing an OpenCode profile', async () => {
    const onLoadOpenCodeAuth = vi.fn().mockResolvedValue('{"openrouter":{"type":"api","key":"sk-FAKE_DO_NOT_USE"}}');
    const { getByLabelText, getByText } = render(
      <LoginProfileEditor
        open
        provider="opencode"
        profile={{
          id: 'profile-opencode',
          provider: 'opencode',
          displayName: 'OpenCode Work',
          authType: 'opencode_auth',
          config: {},
          status: 'ready',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onLoadOpenCodeAuth={onLoadOpenCodeAuth}
      />
    );

    await waitFor(() => expect((getByLabelText('OpenCode auth.json') as HTMLTextAreaElement).value).toContain('"openrouter"'));
    expect(onLoadOpenCodeAuth).toHaveBeenCalledWith('profile-opencode');
    expect(getByText(/Update provider keys or login data below/)).toBeTruthy();
    expect((getByLabelText('key value for OpenRouter') as HTMLInputElement).type).toBe('password');
  });

  it('shows the detected auth path with a compact import action', async () => {
    const onImportExistingOpenCode = vi.fn().mockResolvedValue(undefined);
    const { getByRole, getByText, queryByText } = render(
      <LoginProfileEditor
        open
        provider="opencode"
        profile={null}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onImportExistingOpenCode={onImportExistingOpenCode}
        openCodeAuthPath="/Users/test/.local/share/opencode/auth.json"
      />
    );

    expect(getByText(/Auth file found at/)).toBeTruthy();
    expect(getByText('/Users/test/.local/share/opencode/auth.json')).toBeTruthy();
    expect(queryByText(/Already signed in to OpenCode/)).toBeNull();
    const importButton = getByRole('button', { name: 'Import' });
    fireEvent.click(importButton);
    await waitFor(() => expect(onImportExistingOpenCode).toHaveBeenCalledOnce());
  });

  it('shows automatic OpenCode import failures and allows retrying', async () => {
    const onImportExistingOpenCode = vi.fn()
      .mockRejectedValueOnce(new Error('Could not import auth.json'))
      .mockResolvedValueOnce(undefined);
    const { getByRole, getByText, queryByText } = render(
      <LoginProfileEditor
        open
        provider="opencode"
        profile={null}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onImportExistingOpenCode={onImportExistingOpenCode}
        openCodeAuthPath="/Users/test/.local/share/opencode/auth.json"
      />
    );

    fireEvent.click(getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(getByText('Could not import auth.json')).toBeTruthy());

    fireEvent.click(getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onImportExistingOpenCode).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryByText('Could not import auth.json')).toBeNull());
  });

  it('adds and removes fields in the structured OpenCode editor', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const user = userEvent.setup({ document });
    const { getByLabelText, getByRole, getByText, queryByLabelText } = render(
      <LoginProfileEditor
        open
        provider="opencode"
        profile={{
          id: 'profile-opencode',
          provider: 'opencode',
          displayName: 'OpenCode Work',
          authType: 'opencode_auth',
          config: {},
          status: 'ready',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={onSave}
        onLoadOpenCodeAuth={vi.fn().mockResolvedValue('{"openrouter":{"type":"api","key":"sk-FAKE_DO_NOT_USE"}}')}
      />
    );

    await waitFor(() => expect(getByLabelText('key value for OpenRouter')).toBeTruthy());
    fireEvent.click(getByRole('button', { name: 'Remove key from OpenRouter' }));
    expect(queryByLabelText('key value for OpenRouter')).toBeNull();
    fireEvent.click(getByText('Add field'));
    expect(getByLabelText('newField field name for OpenRouter')).toBeTruthy();
    await user.type(getByLabelText('newField value for OpenRouter'), 'new-value');
    await waitFor(() => expect((getByLabelText('newField value for OpenRouter') as HTMLInputElement).value).toBe('new-value'));
    fireEvent.click(getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const savedAuth = JSON.parse(onSave.mock.calls[0][0].secret);
    expect(savedAuth.openrouter).toEqual({ type: 'api', newField: 'new-value' });
  });

  it('accepts a complete replacement auth.json and rebuilds provider cards', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const user = userEvent.setup({ document });
    const { getByLabelText, getByText } = render(
      <LoginProfileEditor
        open
        provider="opencode"
        profile={{
          id: 'profile-opencode',
          provider: 'opencode',
          displayName: 'OpenCode Work',
          authType: 'opencode_auth',
          config: {},
          status: 'ready',
          isDefault: true,
        }}
        isSaving={false}
        error={null}
        onOpenChange={vi.fn()}
        onSave={onSave}
        onLoadOpenCodeAuth={vi.fn().mockResolvedValue('{"openrouter":{"type":"api","key":"sk-FAKE_DO_NOT_USE"}}')}
      />
    );

    const rawEditor = await waitFor(() => {
      const editor = getByLabelText('OpenCode auth.json') as HTMLTextAreaElement;
      expect(editor.value).toContain('openrouter');
      return editor;
    });
    await user.clear(rawEditor);
    await user.type(rawEditor, '{{"custom-provider":{{"type":"api","key":"new-key"}}');
    await waitFor(() => expect(getByText('custom provider')).toBeTruthy());
    expect(getByLabelText('key value for custom provider')).toBeTruthy();
    fireEvent.click(getByText('Save'));
    await waitFor(() => expect(onSave.mock.calls[0][0].secret).toContain('custom-provider'));
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
