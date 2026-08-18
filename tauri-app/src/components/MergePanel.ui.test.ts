import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Merge panel UI shell', () => {
  it('keeps the graph header merge dropdown on the app panel surface', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');

    expect(source).toContain('w-[min(1020px,calc(100vw-2rem))]');
    expect(source).toContain('bg-[linear-gradient(180deg,hsl(var(--app-panel)/0.98),hsl(var(--app-bg)/0.96))]');
  });

  it('uses explicit merge panel unavailable and loading states', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/MergePanel.tsx'), 'utf8');

    expect(source).toContain('Merge panel unavailable');
    expect(source).toContain('Preparing merge workspace');
  });

  it('uses compact selectable commit rows and setup spacing', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/integration/SetupStage.tsx'), 'utf8');

    expect(source).toContain('min-h-8 w-full');
    expect(source).toContain('flex-1 space-y-3 overflow-y-auto pb-20');
    expect(source).toContain('gap-2 overflow-hidden');
    expect(source).toContain('p-2.5 shadow');
    expect(source).toContain('CardHeader className="p-0"');
    expect(source).toContain('CardContent className="space-y-2 p-0"');
    expect(source).toContain('ScrollArea className="h-52');
    expect(source).toContain('Choose a target before selecting sources.');
    expect(source).toContain('lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]');
  });

  it('keeps merge footer actions compact', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/integration/SetupStage.tsx'), 'utf8');

    expect(source).toContain('Merge Directly');
    expect(source).toContain('AI model');
    expect(source).toContain('flex min-w-[188px] flex-col gap-1');
    expect(source).toContain('h-7 w-full justify-between rounded-lg');
    expect(source).toContain('h-8 w-full gap-1.5 rounded-lg');
    expect(source).not.toContain('h-10 min-w-[220px]');
  });

  it('gives direct clean merge a persistent footer action', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/integration/SetupStage.tsx'), 'utf8');

    expect(source).toContain('canMergeCleanDirect');
    expect(source).toContain('Clean git merge ready');
    expect(source).toContain('Merge directly or use AI');
    expect(source).toContain('bg-[hsl(var(--app-success))]');
    expect(source).not.toContain('Merge Now');
    expect(source).not.toContain('onMergeClean={handleMergeClean}');
  });
});
