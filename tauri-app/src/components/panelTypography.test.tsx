// @vitest-environment jsdom
import '../test/setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardDescription, CardTitle } from '../../@/components/ui/card';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('card and panel typography', () => {
  it('keeps shared card body copy regular while preserving semibold titles', () => {
    const view = render(
      <Card>
        <CardTitle>Heading</CardTitle>
        <CardDescription>Readable supporting copy</CardDescription>
        <p>Card body</p>
      </Card>
    );

    const card = view.container.querySelector<HTMLElement>('[data-slot="card"]');
    const title = view.container.querySelector<HTMLElement>('[data-slot="card-title"]');
    const description = view.container.querySelector<HTMLElement>('[data-slot="card-description"]');

    expect(card?.className).toContain('font-normal');
    expect(title?.className).toContain('font-semibold');
    expect(description?.className).toContain('font-normal');
    expect(description?.className).not.toContain('font-semibold');
  });

  it('uses medium weight for redesign-added body and field labels', () => {
    const agentConfig = readSource('src/components/AgentConfigPanel.tsx');
    const advancedSearch = readSource('src/components/AdvancedSearchPanel.tsx');
    const login = readSource('src/pages/auth/LoginPage.tsx');
    const onboarding = readSource('src/components/onboarding/FirstRunExperience.tsx');

    expect(agentConfig).toContain('className="text-sm font-medium text-foreground">{agentName}');
    expect(agentConfig).toContain('className="text-xs font-medium">\n                        CLI arguments');
    expect(advancedSearch).toContain('className="mb-1 text-sm font-medium text-foreground">No results found');
    expect(login).toContain('className="text-balance text-2xl font-semibold');
    expect(onboarding).toContain('className="text-sm font-medium text-foreground">{label}');
    expect(onboarding).toContain('data-design-part="onboarding-tip-title" className="text-xl font-semibold');
  });

  it('uses semantic off-white for ordinary dark panel actions', () => {
    const orchestration = readSource('src/components/orchestration/OrchestrationPanel.tsx');
    const newAction = orchestration.match(/className="[^"]+"\s*>\s*<Plus className="h-3 w-3" \/>\s*New/)?.[0] ?? '';

    expect(newAction).toContain('dark:text-foreground');
    expect(newAction).not.toContain('dark:text-white ');
  });

  it('uses layered near-black tokens instead of pure black on ordinary dark surfaces', () => {
    const surfaceSources = [
      'src/components/ConfigButton.tsx',
      'src/components/DiagnosticsButton.tsx',
      'src/components/WorktreePolicyButton.tsx',
      'src/components/WorkspaceDeleteDialog.tsx',
      'src/components/WorkspaceRenameDialog.tsx',
      'src/components/WorkspaceShareDialog.tsx',
      'src/components/orchestration/OrchestrationPanel.tsx',
      'src/pages/HomePage.tsx',
    ].map(readSource);

    for (const source of surfaceSources) {
      expect(source).not.toMatch(/\bdark:bg-black(?:\b|\/)/);
    }

    const config = surfaceSources[0];
    const worktreePolicy = surfaceSources[2];
    const orchestration = surfaceSources[6];

    expect(config).toContain('dark:bg-[hsl(var(--app-panel))]');
    expect(config).toContain('dark:bg-[hsl(var(--app-bg))]');
    expect(worktreePolicy).toContain('dark:bg-[hsl(var(--app-panel-strong))]');
    expect(worktreePolicy).toContain('dark:bg-[hsl(var(--app-panel))]');
    expect(orchestration).toContain('dark:bg-[hsl(var(--app-bg-elevated))]');
    expect(orchestration).toContain('dark:bg-[hsl(var(--app-panel))]');
  });
});
