import { beforeEach, describe, expect, it } from 'vitest';
import { buildComposerDraftKey, useWorkspaceStore } from './workspaceStore';

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

  it('stores composer drafts separately by workspace target', () => {
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'first node prompt', 'message-1');
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'second node prompt', 'message-2');

    expect(buildComposerDraftKey('workspace-a', 'message-1')).toBe('workspace-a::message-1');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a', 'message-1')).toBe('first node prompt');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a', 'message-2')).toBe('second node prompt');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a')).toBe('');
  });

  it('clears only the requested workspace target draft', () => {
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'workspace prompt');
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'first node prompt', 'message-1');
    useWorkspaceStore.getState().setComposerDraft('workspace-a', 'second node prompt', 'message-2');

    useWorkspaceStore.getState().clearComposerDraft('workspace-a', 'message-1');

    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a')).toBe('workspace prompt');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a', 'message-1')).toBe('');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-a', 'message-2')).toBe('second node prompt');
  });

  it('does not persist composer drafts to workspace storage', () => {
    const partialized = (useWorkspaceStore as any).persist?.getOptions?.().partialize?.({
      ...useWorkspaceStore.getState(),
      composerDraftByWorkspace: { 'workspace-a': 'draft text' },
    });

    expect(partialized).not.toHaveProperty('composerDraftByWorkspace');
  });
});
