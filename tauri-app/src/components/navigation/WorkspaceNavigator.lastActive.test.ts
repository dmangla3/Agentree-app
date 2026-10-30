import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorkspaceLastActive } from './WorkspaceNavigator';

const formatOptions = {
  now: new Date('2026-08-06T15:00:00.000Z'),
  locale: 'en-US',
  timeZone: 'UTC',
};

describe('formatWorkspaceLastActive', () => {
  it('uses the persisted last-used time when available', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-05-04T09:07:00.000Z',
      },
      Date.parse('2026-08-06T13:05:00.000Z'),
      formatOptions,
    )).toBe('Aug 6, 1:05 PM');
  });

  it('falls back to the workspace timestamp before its creation time', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-05-04T09:07:00.000Z',
      },
      undefined,
      formatOptions,
    )).toBe('May 4, 9:07 AM');
  });

  it('includes the year when the activity was in a different year', () => {
    expect(formatWorkspaceLastActive(
      {
        createdAt: '2025-12-31T23:08:00.000Z',
        updatedAt: '',
      },
      undefined,
      formatOptions,
    )).toBe('Dec 31, 2025, 11:08 PM');
  });
});

describe('WorkspaceNavigator surface styling', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/navigation/WorkspaceNavigator.tsx'), 'utf8');

  it('keeps the compact repo selector inside a subtle surface', () => {
    const pickerClass = source.match(/data-design-part="workspace-picker"\s+className="([^"]+)"/)?.[1] ?? '';

    expect(pickerClass).toContain('h-10');
    expect(pickerClass).toContain('rounded-lg');
    expect(pickerClass).toContain('bg-[hsl(var(--app-panel)/0.58)]');
    expect(pickerClass).toContain('shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.56)');
    expect(pickerClass).toContain('dark:bg-white/[0.045]');
  });

  it('restores the original dark-gray hierarchy without reverting compact navigation geometry', () => {
    const collapsedClass = source.match(/data-design-state="collapsed" className="([^"]+)"/)?.[1] ?? '';
    const expandedClass = source.match(/data-design-state="expanded" className="([^"]+)"/)?.[1] ?? '';
    const toolbarClass = source.match(/data-design-part="navigator-toolbar" className="([^"]+)"/)?.[1] ?? '';
    const threadIndexClass = source.match(/data-design-part="thread-index" className="([^"]+)"/)?.[1] ?? '';

    expect(collapsedClass).toContain('w-12');
    expect(collapsedClass).toContain('dark:bg-[hsl(var(--app-panel-strong)/0.46)]');
    expect(expandedClass).toContain('w-[16.5rem]');
    expect(expandedClass).toContain('dark:bg-[hsl(var(--app-panel-strong)/0.42)]');
    expect(toolbarClass).toContain('dark:bg-[hsl(var(--app-panel)/0.9)]');
    expect(threadIndexClass).toBe('space-y-1.5 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.24)] p-1.5 dark:border-white/10 dark:bg-zinc-800');
    expect(source).toContain('dark:bg-zinc-700 dark:text-white/90');
    expect(source).toContain('{runningCount} running');
    expect(source).not.toContain('{runningCount} live');
  });

  it('softens dark unread badges without changing the shared light treatment', () => {
    const badgeClass = source.match(/className="(workspace-thread-unread-badge[^"]+)"/)?.[1] ?? '';

    expect(badgeClass).toContain('dark:border-white/10');
    expect(badgeClass).toContain('dark:bg-white/[0.14]');
    expect(badgeClass).toContain('dark:text-white/80');
    expect(badgeClass).toContain('dark:ring-white/10');
    expect(badgeClass).not.toContain('dark:bg-white ');
    expect(badgeClass).not.toContain('dark:text-black');
  });

  it('uses medium weight for selected thread and compact picker text', () => {
    expect(source).toContain('data-design-part="thread-title"');
    expect(source).toContain("? 'font-medium text-foreground dark:text-white/90'");
    expect(source).toContain('data-design-part="workspace-picker-title" className="block truncate text-xs font-medium');
    expect(source).toContain('data-design-part="workspace-picker-count" className="shrink-0 font-mono text-[9px] font-medium');
  });

  it('avoids pure-white navigation text while retaining muted and semantic contrast', () => {
    expect(source).not.toMatch(/dark:(?:(?:hover|focus):)?text-white(?=[\s'"])/);
    expect(source).toContain('dark:text-white/90');
    expect(source).toContain("thread.done && 'text-[hsl(var(--app-accent))] opacity-100 dark:text-white/75'");
  });

  it('keeps repo dropdown item labels readable without semibold emphasis', () => {
    expect(source).toContain('data-design-part="repository-row-title" className="min-w-0 flex-1 truncate font-medium"');
    expect(source).toContain('data-design-part="workspace-row-title"');
    expect(source).toContain("workspace.id === selectedWorkspaceId && 'font-medium'");
    expect(source).not.toContain('min-w-0 flex-1 truncate font-semibold">{repository.name}');
    expect(source).not.toContain("workspace.id === selectedWorkspaceId && 'font-semibold'");
  });
});
