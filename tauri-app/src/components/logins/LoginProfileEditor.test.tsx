import { render } from '@testing-library/react';
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

  it('loads existing non-secret config when editing a profile', () => {
    const { getByLabelText } = render(
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

    expect((getByLabelText('Advanced config JSON') as HTMLTextAreaElement).value)
      .toBe(JSON.stringify({ openai_project_id: 'proj_123' }, null, 2));
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
});
