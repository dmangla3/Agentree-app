import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workspace navigator thread migration layout', () => {
  const readGraphControlsSource = () => readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');
  const readGraphViewSource = () => readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');
  const readWorkspaceNavigatorSource = () => readFileSync(join(process.cwd(), 'src/components/navigation/WorkspaceNavigator.tsx'), 'utf8');

  it('keeps thread rows and hover previews in the workspace navigator', () => {
    const source = readWorkspaceNavigatorSource();

    expect(source).toContain('RepoItem');
    expect(source).toContain('WorkspaceRow');
    expect(source).toContain('WorkspaceThreadSection');
    expect(source).toContain('ThreadNodeHoverCard');
    expect(source).toContain('Closed threads');
    expect(source).toContain('aria-label="Collapse navigator"');
    expect(source).toContain('Collapse navigator');
    expect(source).toContain('CollapsedWorkspaceNavigator');
    expect(source).toContain('aria-label="Expand threads bar"');
    expect(source).toContain('repoCount={repoCount}');
    expect(source).toContain('workspaceCount={workspaces.length}');
    expect(source).toContain("aria-label={threadsFocused ? 'Show workspace hierarchy' : 'Focus threads'}");
    expect(source).toContain('showFocusedThreads ? (');
    expect(source).toContain('const threadsFocused = controlledThreadsFocused ?? localThreadsFocused');
    expect(source).toContain('if (!selectedWorkspaceId) setThreadsFocused(false)');
    expect(source).not.toContain('if (!showThreadSections || !selectedWorkspaceId) setThreadsFocused(false)');
  });

  it('removes graph-owned visible thread navigation paths', () => {
    const graphViewSource = readGraphViewSource();
    const graphControlsSource = readGraphControlsSource();

    expect(graphViewSource).not.toContain('GraphThreadTabs');
    expect(graphViewSource).not.toContain('threadNavigationOrientation');
    expect(graphControlsSource).not.toContain('aria-label={`Threads (${threadItems.length})`}');
    expect(graphViewSource).toContain('onThreadNavigationModelChange');
    expect(graphViewSource).toContain('threadBarCollapsed ? \'thread-bar-collapsed\' : \'thread-bar-open\'');
    expect(graphViewSource).toContain('onThreadBarCollapsedChange: handleThreadBarCollapsedChange');
    expect(graphViewSource).toContain('closeThread: handleCloseCurrentThread');
    expect(graphViewSource).toContain('reopenLastClosedThread: handleReopenLastClosedThread');
  });
});
