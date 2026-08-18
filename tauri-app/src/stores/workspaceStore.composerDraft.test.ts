import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

describe('workspace composer drafts', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      selectedWorkspaceId: null,
      composerDraftByWorkspace: {},
    });
  });

  it('stores composer drafts by workspace id', () => {
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'first prompt');
    useWorkspaceStore.getState().setComposerDraft('workspace-b', 'second prompt');

    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a')).toBe('first prompt');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-b')).toBe('second prompt');
  });

  it('clears only the requested workspace draft', () => {
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'first prompt');
    useWorkspaceStore.getState().setComposerDraft('workspace-b', 'second prompt');

    useWorkspaceStore.getState().clearComposerDraft('workspace-a');

    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a')).toBe('');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-b')).toBe('second prompt');
  });

  it('does not persist composer drafts to workspace storage', () => {
    const partialized = (useWorkspaceStore as any).persist?.getOptions?.().partialize?.({
      ...useWorkspaceStore.getState(),
      composerDraftByWorkspace: { 'workspace-a': 'draft text' },
    });

    expect(partialized).not.toHaveProperty('composerDraftByWorkspace');
  });
});
