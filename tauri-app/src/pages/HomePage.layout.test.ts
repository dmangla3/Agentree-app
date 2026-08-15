import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('HomePage graph/chat split layout', () => {
  const readHomePageSource = () => readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');
  const readSidebarSource = () => readFileSync(join(process.cwd(), 'src/components/Sidebar.tsx'), 'utf8');

  it('initializes the graph/chat panels from the remembered 50/50 default split', () => {
    const source = readHomePageSource();

    expect(source).toContain('rememberedGraphChatSplitRef = useRef(readRememberedGraphChatSplit() ?? DEFAULT_GRAPH_CHAT_SPLIT)');
    expect(source).toContain('defaultSize={rememberedGraphChatSplitRef.current[0]}');
    expect(source).toContain('defaultSize={rememberedGraphChatSplitRef.current[1]}');
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

  it('keeps the navigation rail thin and icon-only', () => {
    const source = readSidebarSource();

    expect(source).toContain('w-16');
    expect(source).not.toContain('xl:w-[13.5rem]');
    expect(source).not.toContain('app-rail-button-label');
  });
});
