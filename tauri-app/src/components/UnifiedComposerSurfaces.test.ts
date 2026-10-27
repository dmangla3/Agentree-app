import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('unified composer surfaces', () => {
  it('uses GraphDockComposer for graph, chat, and floating replies', () => {
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');
    const homePageSource = readSource('src/pages/HomePage.tsx');
    const graphDockSource = readSource('src/components/GraphComposerDock.tsx');

    expect(chatInterfaceSource).toContain('<GraphDockComposer surface="chat-panel" />');
    expect(homePageSource).toContain('surface="floating-reply"');
    expect(homePageSource).toContain('parentMessageIdOverride={floatingChatInputParentId}');
    expect(graphDockSource).toContain('<GraphDockComposer />');
    expect(chatInterfaceSource).not.toContain('ChatInput');
    expect(homePageSource).not.toContain("components/ChatInput");
  });

  it('keeps explicit reply targets ahead of ambient graph focus', () => {
    const source = readSource('src/composer/GraphDockComposer.tsx');

    expect(source).toContain('parentMessageIdOverride !== undefined');
    expect(source).toContain('parentMessageId: parentMessageIdOverride');
    expect(source.indexOf('parentMessageIdOverride !== undefined')).toBeGreaterThan(source.indexOf('const ambientTarget'));
  });

  it('keeps composer layers above the minimap and adapts width by surface', () => {
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');
    const homePageSource = readSource('src/pages/HomePage.tsx');
    const composerSource = readSource('src/composer/GraphDockComposer.tsx');
    const miniMapPanelSource = readSource('src/components/graph/MiniMapPanel.tsx');

    expect(chatInterfaceSource).toContain('relative z-[40] overflow-visible');
    expect(homePageSource).toContain('fixed inset-x-0 bottom-5 z-[70]');
    expect(composerSource).toContain("surface === 'graph'");
    expect(composerSource).toContain("'w-full max-w-none'");
    expect(miniMapPanelSource).toContain('const minimapLayerClass = "z-[30]"');
  });

  it('preserves uploads, attachment previews, drafts, mentions, and steering in the shared composer', () => {
    const composerSource = readSource('src/composer/GraphDockComposer.tsx');
    const sendSource = readSource('src/composer/headlessComposerSend.ts');

    expect(composerSource).toContain('useComposerAttachments');
    expect(composerSource).toContain('<AttachmentPreview');
    expect(composerSource).toContain('setComposerDraft(selectedWorkspaceId');
    expect(composerSource).toContain('getActiveFileMention');
    expect(composerSource).toContain('getActiveSkillMention');
    expect(composerSource).toContain('getActiveTemplateMention');
    expect(composerSource).toContain('await agentClient.steerAgentRun(');
    expect(sendSource).toContain('appendComposerContextArtifactInputs');
    expect(sendSource).toContain('appendInputArtifactsToPrompt');
  });

  it('queues only until a complete batch is durable and preserves focus lifecycle cleanup', () => {
    const composerSource = readSource('src/composer/GraphDockComposer.tsx');

    expect(composerSource).toContain('ComposerSendAcceptanceQueue');
    expect(composerSource).toContain('acceptedRunKeys.size < runsToLaunch.length');
    expect(composerSource).toContain('acceptRun(spec.runKey)');
    expect(composerSource).toContain('beginComposerSendFocus({');
    expect(composerSource).toContain('acceptComposerSendFocus({');
    expect(composerSource).toContain('cancelComposerSendFocus(flowId)');
    expect(composerSource).toContain('finishComposerSendFocus({');
  });

  it('never auto-checks out competing commits from a multi-run batch', () => {
    const composerSource = readSource('src/composer/GraphDockComposer.tsx');

    expect(composerSource).toContain('autoCheckoutOnAgentCommit && specs.length === 1');
    expect(composerSource).toContain('auto_checkout_requested: shouldAutoCheckoutThisBatch');
    expect(composerSource).toContain('selectedRunTotal > 1');
  });
});
