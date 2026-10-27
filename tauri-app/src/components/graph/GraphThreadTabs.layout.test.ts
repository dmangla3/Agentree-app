import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workspace navigator hierarchy', () => {
  const readGraphControlsSource = () => readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');
  const readGraphViewSource = () => readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');
  const readWorkspaceNavigatorSource = () => readFileSync(join(process.cwd(), 'src/components/navigation/WorkspaceNavigator.tsx'), 'utf8');

  it('groups repositories and workspaces in one compact disclosure hierarchy', () => {
    const source = readWorkspaceNavigatorSource();

    expect(source).toContain('aria-label="Repository and workspace navigation"');
    expect(source).toContain('data-repository-list');
    expect(source).toContain('<Collapsible');
    expect(source).toContain('<CollapsibleTrigger asChild>');
    expect(source).toContain('<CollapsibleContent className="overflow-hidden">');
    expect(source).toContain("expandedRepositoryIds.has(repository.id)");
    expect(source).toContain("handleRepositoryExpandedChange(repository.id, open)");
    expect(source).toContain("aria-label={`${expanded ? 'Collapse' : 'Expand'} repository ${repository.name}`}");
    expect(source).toContain('data-repository-disclosure-button={repository.id}');
    expect(source).not.toContain('aria-label={`Select repository ${repository.name}`}');
    expect(source).toContain('aria-label={`Workspaces in ${repository.name}`}');
    expect(source).toContain('aria-label={`Add workspace to ${repository.name}`}');
    expect(source).toContain('<ScrollArea className="min-h-0 flex-1"');
    expect(source).toContain('WorkspaceRow');
    expect(source).toContain('WorkspaceThreadSection');
    expect(source).not.toContain('workspace-navigation-heading');
    expect(source).not.toContain('>Workspaces</h2>');
    expect(source).toContain('aria-label="Threads in selected workspace"');
    expect(source).toContain('ThreadNodeHoverCard');
    expect(source).toContain('Closed threads');
    expect(source).toContain('aria-label="Collapse navigator"');
    expect(source).toContain('Collapse navigator');
    expect(source).toContain('CollapsedWorkspaceNavigator');
    expect(source).toContain('aria-label="Expand threads bar"');
    expect(source).toContain('repoCount={repoCount}');
    expect(source).toContain('workspaceCount={workspaces.length}');
    expect(source).not.toContain('lastWorkspaceByRepositoryRef');
    expect(source).not.toContain('handleSelectRepository');
    expect(source).toContain('onClick={() => onSelectWorkspace(workspace.id)}');
    expect(source).toContain("aria-label={threadsFocused ? 'Show workspaces' : 'Focus threads'}");
    expect(source).toContain('showFocusedThreads');
    expect(source).toContain('formatWorkspaceTime(activityTimestamp)');
    expect(source).toContain('selectedWorkspaceLastActiveAt');
    expect(source).toContain('numericTimestamp < 1_000_000_000_000 ? numericTimestamp * 1000 : numericTimestamp');
    expect(source).toContain("threadCount !== undefined ? `${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}` : null");
    expect(source).not.toContain("createdDate ? `Created ${createdDate}` : 'Workspace'");
    expect(source).not.toContain('RepoItem');
    expect(source).not.toContain('Search repositories');
    expect(source).not.toContain('data-repository-selector');
    expect(source).not.toContain('Choose repository');
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
