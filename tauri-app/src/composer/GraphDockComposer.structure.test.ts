import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GraphDockComposer structure', () => {
  it('does not stack tooltip and menu trigger refs on dock control buttons', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).not.toContain('TooltipTrigger asChild');
    expect(source).toContain('<DropdownMenuTrigger asChild>');
    expect(source).toContain('<PopoverTrigger asChild>');
  });
});
