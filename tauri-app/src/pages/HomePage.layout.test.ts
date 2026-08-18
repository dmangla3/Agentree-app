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

  it('passes chat collapse state into the graph so thread navigation can change orientation', () => {
    const source = readHomePageSource();

    expect(source).toContain('<GraphView threadNavigationOrientation={isChatCollapsed ? \'vertical\' : \'horizontal\'} />');
  });

  it('keeps the app header as persistent workspace chrome across primary views', () => {
    const source = readHomePageSource();

    expect(source).toContain('aria-label="Agentree workspace shell"');
    expect(source).toContain('app-shell-content');
    expect(source).not.toContain("{activeView === 'chat' && (");
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
    expect(source).toContain('Manage installed skills and workspace knowledge from the same shell.');
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

  it('wires flows as a primary shell view for inspecting predefined flows', () => {
    const homePageSource = readHomePageSource();
    const sidebarSource = readSidebarSource();

    expect(homePageSource).toContain("const FlowsPanel = lazy");
    expect(homePageSource).toContain("activeView === 'flows'");
    expect(homePageSource).toContain('<FlowsPanel />');
    expect(sidebarSource).toContain("label: 'Flows'");
    expect(sidebarSource).toContain("id: 'flows'");
    expect(sidebarSource).toContain('Workflow');
    expect(sidebarSource).not.toContain('GitBranch');
  });

  it('keeps the navigation rail thin and icon-only', () => {
    const source = readSidebarSource();

    expect(source).toContain('w-16');
    expect(source).not.toContain('xl:w-[13.5rem]');
    expect(source).not.toContain('app-rail-button-label');
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
    expect(source).toContain('<ChatInterface key={selectedWorkspaceId} />');
    expect(source).not.toContain('<ChatPanelHeader');
    expect(source).not.toContain('<MergePanel');
  });

  it('does not keep ChatInterface mounted behind a collapsed chat panel', () => {
    const source = readHomePageSource();
    const chatInterfaceIndex = source.indexOf('<ChatInterface key={selectedWorkspaceId} />');
    const collapsedGuardIndex = source.lastIndexOf('{!isChatCollapsed && (', chatInterfaceIndex);

    expect(chatInterfaceIndex).toBeGreaterThan(0);
    expect(collapsedGuardIndex).toBeGreaterThan(0);
  });
});
