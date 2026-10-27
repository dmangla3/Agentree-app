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
    const chatWrapperSource = readFileSync(join(process.cwd(), 'src/components/nodes/chat/ChatCardWrapper.tsx'), 'utf8');
    const listWrapperSource = readFileSync(join(process.cwd(), 'src/components/nodes/list/ListRowWrapper.tsx'), 'utf8');

    expect(graphWrapperSource).toContain("borderColor: isFocused || isFocusFeedbackActive");
    expect(graphWrapperSource).toContain("'hsl(var(--app-selection) / 0.92)'");
    expect(graphWrapperSource).toContain('ring-2 ring-[hsl(var(--app-selection)/0.9)] shadow-md');
    expect(graphWrapperSource).toContain("? '#3b82f6'");
    expect(graphWrapperSource).toContain('ring-2 ring-blue-500');
    expect(graphWrapperSource).toContain('isSelected && !isFocused && !isFocusFeedbackActive');

    expect(chatWrapperSource).toContain("borderColor: isFocused");
    expect(chatWrapperSource).toContain("'hsl(var(--app-selection) / 0.92)'");
    expect(chatWrapperSource).toContain('ring-2 ring-[hsl(var(--app-selection)/0.9)]');
    expect(chatWrapperSource).toContain("? '#3b82f6'");
    expect(chatWrapperSource).toContain('ring-2 ring-blue-500/20');

    expect(listWrapperSource).toContain("borderColor: isFocused");
    expect(listWrapperSource).toContain("'hsl(var(--app-selection) / 0.92)'");
    expect(listWrapperSource).toContain('ring-2 ring-[hsl(var(--app-selection)/0.9)]');
    expect(listWrapperSource).not.toContain("'#6366f1'");
    expect(listWrapperSource).not.toContain('ring-indigo-500');
    expect(listWrapperSource).toContain("'#3b82f6'");
    expect(listWrapperSource).toContain('isSelected && !isFocused');
    expect(listWrapperSource).toContain('ring-2 ring-blue-500');
  });

  it('groups messages tightly within turns and separates adjacent turns', () => {
    const listSource = readFileSync(join(process.cwd(), 'src/components/ListView.tsx'), 'utf8');

    expect(listSource).toContain('group.turnGroupId ? "gap-1"');
    expect(listSource).toContain('border-b border-[hsl(var(--app-border)/0.46)]');
    expect(listSource).toContain('groupIndex < groups.length - 1');
  });
});
