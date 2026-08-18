import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GraphThreadTabs orientation layout', () => {
  const readGraphControlsSource = () => readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');
  const readGraphViewSource = () => readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

  it('supports horizontal and vertical thread navigation orientations', () => {
    const source = readGraphControlsSource();

    expect(source).toContain("orientation?: 'horizontal' | 'vertical'");
    expect(source).toContain("orientation = 'horizontal'");
    expect(source).toContain("const isVertical = orientation === 'vertical'");
    expect(source).toContain('aria-orientation={orientation}');
  });

  it('keeps horizontal tabs scrollable across the graph chrome and vertical tabs as a left rail', () => {
    const source = readGraphControlsSource();

    expect(source).not.toContain('absolute bottom-3 left-3 top-3');
    expect(source).toContain('w-[16rem]');
    expect(source).toContain('border-r border-[hsl(var(--app-border)/0.48)]');
    expect(source).toContain('min-h-0 flex-col items-stretch overflow-y-auto overscroll-y-contain');
    expect(source).toContain('items-center overflow-x-auto overscroll-x-contain');
  });

  it('renders horizontal tabs in the graph chrome and vertical tabs as a sibling before the graph canvas', () => {
    const source = readGraphViewSource();

    expect(source).toContain("threadNavigationOrientation?: 'horizontal' | 'vertical'");
    expect(source).toContain("threadNavigationOrientation = 'horizontal'");
    expect(source).toContain("threadNavigationOrientation === 'horizontal'");
    expect(source).toContain("threadNavigationOrientation === 'vertical'");
    expect(source).toContain('orientation="vertical"');
    expect(source).toContain("threadNavigationOrientation === 'vertical' ? 'flex min-h-0' : 'relative'");
    expect(source).toContain("threadNavigationOrientation === 'vertical' ? 'min-w-0 flex-1 overflow-hidden' : 'h-full w-full'");
  });
});
