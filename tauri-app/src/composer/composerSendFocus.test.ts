import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  acceptComposerSendFocus,
  beginComposerSendFocus,
  cancelComposerSendFocus,
  clearComposerSendFocusRegistry,
  finishComposerSendFocus,
} from './composerSendFocus';

const resetFocus = () => {
  useWorkspaceStore.setState({
    selectedWorkspaceId: 'workspace-1',
    focusedMessageId: 'parent-1',
    lastFocusSource: 'chat',
    lastFocusMetadata: null,
    focusNonce: 10,
    activeSendFlowFocus: null,
    lastFocusedMessageByWorkspace: { 'workspace-1': 'parent-1' },
    recentFocusedMessageIdsByWorkspace: { 'workspace-1': ['parent-1'] },
  });
};

describe('composer send focus lifecycle', () => {
  beforeEach(() => {
    clearComposerSendFocusRegistry();
    resetFocus();
  });

  it('advances owned focus from the parent to the accepted assistant and its generated commit', () => {
    expect(beginComposerSendFocus({
      flowId: 'flow-1',
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
    })).toBe(true);
    expect(acceptComposerSendFocus({
      flowId: 'flow-1',
      workspaceId: 'workspace-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      parentMessageId: 'parent-1',
    })).toBe(true);
    expect(useWorkspaceStore.getState().focusedMessageId).toBe('assistant-1');

    expect(finishComposerSendFocus({
      assistantMessageId: 'assistant-1',
      workspaceId: 'workspace-1',
      terminalStatus: 'completed',
      outputCommitSha: 'abc123',
    })).toBe(true);
    expect(useWorkspaceStore.getState()).toMatchObject({
      focusedMessageId: 'assistant-1',
      lastFocusSource: 'composer',
      lastFocusMetadata: {
        reason: 'generated-commit',
        commitSha: 'abc123',
      },
      activeSendFlowFocus: null,
    });
  });

  it('does not steal focus back after the user selects another graph node', () => {
    beginComposerSendFocus({
      flowId: 'flow-1',
      workspaceId: 'workspace-1',
      parentMessageId: 'parent-1',
    });
    useWorkspaceStore.setState({
      focusedMessageId: 'manual-node',
      lastFocusSource: 'graph',
      lastFocusMetadata: { via: 'node-click' },
      focusNonce: 11,
    });

    expect(acceptComposerSendFocus({
      flowId: 'flow-1',
      workspaceId: 'workspace-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      parentMessageId: 'parent-1',
    })).toBe(false);
    expect(finishComposerSendFocus({
      assistantMessageId: 'assistant-1',
      workspaceId: 'workspace-1',
      terminalStatus: 'completed',
      outputCommitSha: 'abc123',
    })).toBe(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      focusedMessageId: 'manual-node',
      lastFocusSource: 'graph',
      activeSendFlowFocus: null,
    });
  });

  it('lets the latest send own focus while older runs finish silently', () => {
    beginComposerSendFocus({ flowId: 'flow-1', workspaceId: 'workspace-1', parentMessageId: 'parent-1' });
    acceptComposerSendFocus({
      flowId: 'flow-1', workspaceId: 'workspace-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1', parentMessageId: 'parent-1',
    });
    beginComposerSendFocus({ flowId: 'flow-2', workspaceId: 'workspace-1', parentMessageId: 'assistant-1' });
    acceptComposerSendFocus({
      flowId: 'flow-2', workspaceId: 'workspace-1', userMessageId: 'user-2', assistantMessageId: 'assistant-2', parentMessageId: 'assistant-1',
    });

    expect(finishComposerSendFocus({ assistantMessageId: 'assistant-1', outputCommitSha: 'old-commit' })).toBe(false);
    expect(useWorkspaceStore.getState().focusedMessageId).toBe('assistant-2');
    expect(useWorkspaceStore.getState().activeSendFlowFocus?.flowId).toBe('flow-2');
  });

  it('releases ownership when persistence fails before an assistant can be registered', () => {
    beginComposerSendFocus({ flowId: 'flow-1', workspaceId: 'workspace-1', parentMessageId: 'parent-1' });
    cancelComposerSendFocus('flow-1');
    expect(useWorkspaceStore.getState().activeSendFlowFocus).toBeNull();
  });
});
