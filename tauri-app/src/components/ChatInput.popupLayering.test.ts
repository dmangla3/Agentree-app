import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('chat composer popup layering', () => {
  it('keeps composer popups above both docked and floating composer shells', () => {
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');
    const chatInputSource = readSource('src/components/ChatInput.tsx');
    const homePageSource = readSource('src/pages/HomePage.tsx');

    expect(chatInterfaceSource).toContain('relative z-[40] overflow-visible');
    expect(homePageSource).toContain('fixed inset-x-0 bottom-5 z-[70]');
    expect(chatInputSource).toContain('const composerPopupLayerClass = "z-[90]"');
    expect(chatInputSource.match(/composerPopupLayerClass/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps the graph minimap below app-level composer layers', () => {
    const miniMapPanelSource = readSource('src/components/graph/MiniMapPanel.tsx');

    expect(miniMapPanelSource).toContain('const minimapLayerClass = "z-[30]"');
    expect(miniMapPanelSource).not.toContain('z-[200]');
  });

  it('keeps graph hover previews above the docked chat composer', () => {
    const graphNodeWrapperSource = readSource('src/components/nodes/graph/GraphNodeWrapper.tsx');
    const derivedCommitGroupSource = readSource('src/components/nodes/graph/GraphDerivedCommitGroupNode.tsx');
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');

    expect(graphNodeWrapperSource).not.toContain('z-[210]');
    expect(derivedCommitGroupSource).not.toContain('z-[210]');
    expect(chatInterfaceSource).not.toContain('relative z-[60] overflow-visible');
    expect(chatInterfaceSource).toContain('relative z-[40] overflow-visible');
    expect(graphNodeWrapperSource).toContain('className="z-50 w-auto border-none bg-transparent p-0 shadow-none"');
    expect(derivedCommitGroupSource).toContain('className="z-50 w-auto border-none bg-transparent p-0 shadow-none"');
  });

  it('does not show the cancel affordance when new thread is selected over a running node', () => {
    const chatInputSource = readSource('src/components/ChatInput.tsx');

    expect(chatInputSource).toContain('const showCancel = shouldShowComposerCancel({');
    expect(chatInputSource).toContain('isNewThreadTarget,');
    expect(chatInputSource).toContain('isSelectedNodeRunning,');
  });

  it('clears manual code base selection when the reply target context changes', () => {
    const chatInputSource = readSource('src/components/ChatInput.tsx');

    expect(chatInputSource).toContain('baseSelectionContextKeyRef');
    expect(chatInputSource).toContain('previousBaseSelectionContextKey');
    expect(chatInputSource).toContain('setComposerBaseCommitOverride(null);');
  });

  it('keeps ChatInput scoped to the chat-panel composer surface', () => {
    const chatInputSource = readSource('src/components/ChatInput.tsx');
    const surfaceSource = readSource('src/lib/chatInputSurface.ts');

    expect(chatInputSource).toContain("surface = 'chat-panel'");
    expect(chatInputSource).toContain('getChatInputSurfaceClasses(surface)');
    expect(chatInputSource).toContain('getChatInputSurfaceLabel(surface)');
    expect(surfaceSource).not.toContain("'graph-dock'");
    expect(chatInputSource).toContain('setComposerDraft(selectedWorkspaceId, nextPrompt)');
    expect(chatInputSource).toContain('clearComposerDraft(selectedWorkspaceId)');
    expect(chatInputSource).not.toContain('function GraphComposerSend');
  });

  it('keeps start-new-thread creation on graph controls instead of the composer reply target menu', () => {
    const chatInputSource = readSource('src/components/ChatInput.tsx');
    const graphViewSource = readSource('src/components/GraphView.tsx');
    const graphControlsSource = readSource('src/components/graph/GraphControls.tsx');

    expect(chatInputSource).not.toContain("window.addEventListener('agentree:startNewThread'");
    expect(chatInputSource).not.toContain('Start new thread</div>');
    expect(graphViewSource).toContain('setThreadComposerTarget({');
    expect(graphViewSource).toContain("reason: 'create-thread'");
    expect(graphViewSource).not.toContain('setPendingThreadRoots');
    expect(graphViewSource).toContain('setActiveThreadRootId(threadRootId)');
    expect(graphControlsSource).toContain('aria-label="Start new thread"');
  });

  it('keeps graph composer dock below composer popups and above graph minimap', () => {
    const graphComposerDockSource = readSource('src/components/GraphComposerDock.tsx');
    const chatInputSource = readSource('src/components/ChatInput.tsx');
    const miniMapPanelSource = readSource('src/components/graph/MiniMapPanel.tsx');

    expect(graphComposerDockSource).toContain('z-[45]');
    expect(chatInputSource).toContain('const composerPopupLayerClass = "z-[90]"');
    expect(miniMapPanelSource).toContain('const minimapLayerClass = "z-[30]"');
  });
});
