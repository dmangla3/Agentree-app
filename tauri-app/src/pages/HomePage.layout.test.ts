import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('HomePage graph/chat split layout', () => {
  const readHomePageSource = () => readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');
  const readSidebarSource = () => readFileSync(join(process.cwd(), 'src/components/Sidebar.tsx'), 'utf8');

  it('opens the workspace in graph-only mode while keeping a remembered chat restore split', () => {
    const source = readHomePageSource();

    expect(source).toContain('const [isChatCollapsed, setIsChatCollapsed] = useState(true)');
    expect(source).toContain('rememberedGraphChatSplitRef = useRef(readRememberedGraphChatSplit() ?? DEFAULT_GRAPH_CHAT_SPLIT)');
    expect(source).toContain('defaultSize={isChatCollapsed ? 100 : rememberedGraphChatSplitRef.current[0]}');
    expect(source).toContain('defaultSize={isChatCollapsed ? 0 : rememberedGraphChatSplitRef.current[1]}');
  });

  it('renders an accessible divider pill that toggles chat collapse and restore', () => {
    const source = readHomePageSource();

    expect(source).toContain('aria-label={isChatCollapsed ? \'Restore chat panel\' : \'Hide chat panel\'}');
    expect(source).toContain('title={isChatCollapsed ? \'Restore chat panel\' : \'Hide chat panel\'}');
    expect(source).toContain('onClick={toggleChatPanelCollapsed}');
    expect(source).toContain('PanelRightClose');
    expect(source).toContain('PanelRightOpen');
  });

  it('keeps the visible divider thin and positions the chat toggle on the left of the divider', () => {
    const source = readHomePageSource();

    expect(source).toContain("isChatCollapsed ? 'h-10 w-10 -translate-x-2'");
    expect(source).toContain("isChatCollapsed ? 'h-4 w-4'");
    expect(source).toContain("className={`app-split-handle group ${isChatCollapsed ? 'h-10 w-10 -translate-x-2' : 'h-7 w-4 -translate-x-2'}`}");
  });

  it('wires panel refs and layout persistence for remembered restore widths', () => {
    const source = readHomePageSource();

    expect(source).toContain('graphPanelRef');
    expect(source).toContain('chatPanelRef');
    expect(source).toContain('onLayout={handleGraphChatLayout}');
    expect(source).toContain('rememberGraphChatSplit');
    expect(source).toContain('readRememberedGraphChatSplit');
  });

  it('uses a compact chat restore target that remains reachable on the graph side of the divider', () => {
    const source = readHomePageSource();

    expect(source).toContain("isChatCollapsed ? 'h-10 w-10 -translate-x-2'");
    expect(source).toContain("isChatCollapsed ? 'h-4 w-4'");
  });

  it('renders a single shell navigator and publishes graph thread navigation into it', () => {
    const source = readHomePageSource();

    expect(source).toContain('<WorkspaceNavigator');
    expect(source).toContain('threadNavigation={selectedThreadNavigationModel}');
    expect(source).toContain('<GraphView onThreadNavigationModelChange={handleThreadNavigationModelChange} />');
    expect(source).not.toContain('threadNavigationOrientation');
    expect(source).not.toContain('WorkspaceSelectionDialog');
  });

  it('keeps thread-focus state in the shell so it survives navigator remounts', () => {
    const source = readHomePageSource();

    expect(source).toContain('workspaceNavigatorThreadsFocused');
    expect(source).toContain('threadsFocused={workspaceNavigatorThreadsFocused}');
    expect(source).toContain('onThreadsFocusedChange={setWorkspaceNavigatorThreadsFocused}');
  });

  it('keeps the workspace navigator and graph mounted across primary-view navigation', () => {
    const source = readHomePageSource();

    expect(source).toContain("<div className={activeView === 'chat' ? 'contents' : 'hidden'} aria-hidden={activeView !== 'chat'}>");
    expect(source).toContain("className={`absolute inset-0 h-full ${activeView === 'chat' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}");
    expect(source).toContain("inert={activeView !== 'chat'}");
    expect(source).toContain("{activeView === 'chat' ? null : activeView === 'orchestration' ? (");
  });

  it('keeps the app header as persistent workspace chrome across primary views', () => {
    const source = readHomePageSource();

    expect(source).toContain('aria-label="Agentree workspace shell"');
    expect(source).toContain('app-shell-content');
    expect(source).not.toContain("{activeView === 'chat' && (");
  });

  it('keeps terminal tab presence separate from dock visibility', () => {
    const source = readHomePageSource();

    expect(source).toContain('const [hasTerminalTabs, setHasTerminalTabs] = useState(false)');
    expect(source).toContain('onTabsChange={handleTerminalTabsChange}');
    expect(source).toContain('onRequestShow={showTerminalDock}');
    expect(source).toContain('onCollapse={() => setIsTerminalDockVisible(false)}');
    expect(source).toContain('onExpand={() => setIsTerminalDockVisible(true)}');
  });

  it('exposes terminal restore controls only while tabs are alive', () => {
    const source = readHomePageSource();
    const headerSource = readFileSync(join(process.cwd(), 'src/components/AppHeader.tsx'), 'utf8');

    expect(source).toContain('hasTerminalTabs={hasTerminalTabs}');
    expect(source).toContain('onToggleTerminalDock={toggleOrOpenTerminalDock}');
    expect(source).toContain('useToggleTerminalDockHotkey(toggleOrOpenTerminalDock)');
    expect(headerSource).toContain('{hasTerminalTabs ? (');
    expect(headerSource).toContain("aria-label={isTerminalDockVisible ? 'Hide terminal dock' : 'Show terminal dock'}");
  });

  it('does not add extra product or view text next to the logo', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/AppHeader.tsx'), 'utf8');

    expect(source).not.toContain('viewTitles');
    expect(source).not.toContain('Workspace graph');
    expect(source).not.toContain('<span className="text-sm font-semibold tracking-[-0.01em] text-foreground">Agentree</span>');
  });

  it('uses shared shell surfaces for secondary app views', () => {
    const source = readHomePageSource();

    expect(source).toContain('app-view-surface');
    expect(source).toContain('app-view-header');
    expect(source).toContain('Manage reusable node prompts and natural-language orchestration prompts for the graph composer.');
  });

  it('wires tracking as a primary shell view without replacing the workspace split', () => {
    const homePageSource = readHomePageSource();
    const sidebarSource = readSidebarSource();

    expect(homePageSource).toContain("const TrackingDashboard = lazy");
    expect(homePageSource).toContain("activeView === 'tracking'");
    expect(homePageSource).toContain('<TrackingDashboard workspace={selectedWorkspace} />');
    expect(sidebarSource).toContain("label: 'Tracking'");
    expect(sidebarSource).toContain("id: 'tracking'");
  });

  it('does not expose executable flows as a primary shell view', () => {
    const homePageSource = readHomePageSource();
    const sidebarSource = readSidebarSource();

    expect(homePageSource).not.toContain("const FlowsPanel = lazy");
    expect(homePageSource).not.toContain("activeView === 'flows'");
    expect(homePageSource).not.toContain('<FlowsPanel workspaceId={selectedWorkspaceId} />');
    expect(homePageSource).toContain('Manage reusable node prompts and natural-language orchestration prompts for the graph composer.');
    expect(homePageSource).not.toContain('Manage pre-defined nodes and flows');
    expect(sidebarSource).not.toContain("label: 'Flows'");
    expect(sidebarSource).not.toContain("id: 'flows'");
    expect(sidebarSource).not.toContain('GitBranch');
  });

  it('keeps the navigation rail thin and icon-only', () => {
    const source = readSidebarSource();

    expect(source).toContain('w-16');
    expect(source).not.toContain('xl:w-[13.5rem]');
    expect(source).not.toContain('app-rail-button-label');
  });

  it('hides knowledge and skills from the primary sidebar', () => {
    const source = readSidebarSource();

    expect(source).not.toContain("label: 'Skills'");
    expect(source).not.toContain("id: 'skills'");
    expect(source).not.toContain("label: 'Knowledge'");
    expect(source).not.toContain("id: 'knowledge', icon");
  });

  it('mounts the graph composer dock only while the chat panel is collapsed', () => {
    const source = readHomePageSource();

    expect(source).toContain("const GraphComposerDock = lazy");
    expect(source).toContain('<GraphComposerDock');
    expect(source).toContain('isVisible={isChatCollapsed}');
    expect(source).not.toContain('onRestoreChatPanel={restoreChatPanel}');
  });

  it('unmounts chat panel content while graph-only mode is active', () => {
    const source = readHomePageSource();

    expect(source).toContain('{!isChatCollapsed && (');
    expect(source).toContain('<ChatInterface');
    expect(source).toContain('onMarkThreadDone={(threadRootId) => selectedThreadNavigationModel?.onThreadDoneChange(threadRootId, true)}');
    expect(source).not.toContain('<ChatPanelHeader');
    expect(source).not.toContain('<MergePanel');
  });

  it('does not keep ChatInterface mounted behind a collapsed chat panel', () => {
    const source = readHomePageSource();
    const chatInterfaceIndex = source.indexOf('<ChatInterface');
    const collapsedGuardIndex = source.lastIndexOf('{!isChatCollapsed && (', chatInterfaceIndex);

    expect(chatInterfaceIndex).toBeGreaterThan(0);
    expect(collapsedGuardIndex).toBeGreaterThan(0);
  });
});
