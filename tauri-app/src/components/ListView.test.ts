import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ListView styling', () => {
  it('uses a dedicated matte list surface instead of the graph gradient', () => {
    const graphViewSource = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');
    const listSource = readFileSync(join(process.cwd(), 'src/components/ListView.tsx'), 'utf8');

    expect(graphViewSource).not.toContain("<div className={cn('h-full w-full', backgroundClass)}>");
    expect(listSource).not.toContain('dark:bg-slate-950');
    expect(listSource).toContain('hsl(var(--app-bg))');
    expect(listSource).toContain('No list items');
  });

  it('uses the same focus border color and ring rules as graph nodes', () => {
    const graphWrapperSource = readFileSync(join(process.cwd(), 'src/components/nodes/graph/GraphNodeWrapper.tsx'), 'utf8');
    const listWrapperSource = readFileSync(join(process.cwd(), 'src/components/nodes/list/ListRowWrapper.tsx'), 'utf8');

    expect(graphWrapperSource).toContain("borderColor: isFocused || isFocusFeedbackActive");
    expect(graphWrapperSource).toContain("'#6366f1'");
    expect(graphWrapperSource).toContain('ring-2 ring-indigo-500 shadow-md');

    expect(listWrapperSource).toContain("borderColor: isFocused");
    expect(listWrapperSource).toContain("'#6366f1'");
    expect(listWrapperSource).toContain('ring-2 ring-indigo-500');
    expect(listWrapperSource).toContain('ring-2 ring-blue-500');
  });
});
