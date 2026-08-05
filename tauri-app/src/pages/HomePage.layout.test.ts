import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('HomePage graph/chat split layout', () => {
  const readHomePageSource = () => readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');

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

  it('wires panel refs and layout persistence for remembered restore widths', () => {
    const source = readHomePageSource();

    expect(source).toContain('graphPanelRef');
    expect(source).toContain('chatPanelRef');
    expect(source).toContain('onLayout={handleGraphChatLayout}');
    expect(source).toContain('rememberGraphChatSplit');
    expect(source).toContain('readRememberedGraphChatSplit');
  });

  it('uses a wider inward-shifted collapsed-state restore target so it remains easy to click', () => {
    const source = readHomePageSource();

    expect(source).toContain("isChatCollapsed ? 'h-11 w-14 -translate-x-3'");
    expect(source).toContain("isChatCollapsed ? 'h-4 w-4'");
  });
});
