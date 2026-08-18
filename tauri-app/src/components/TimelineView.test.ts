import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TimelineView styling', () => {
  it('uses a dedicated matte timeline surface instead of the graph gradient', () => {
    const graphViewSource = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');
    const timelineSource = readFileSync(join(process.cwd(), 'src/components/TimelineView.tsx'), 'utf8');

    expect(graphViewSource).not.toContain("<div className={cn('h-full w-full', backgroundClass)}>");
    expect(timelineSource).not.toContain('dark:bg-slate-950');
    expect(timelineSource).toContain('hsl(var(--app-bg))');
    expect(timelineSource).toContain('No timeline items');
  });
});
