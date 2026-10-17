import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LoginProfilesPanel selected profile layout', () => {
  const readSource = () =>
    readFileSync(join(process.cwd(), 'src/components/logins/LoginProfilesPanel.tsx'), 'utf8');

  it('wraps selected profile status messages inside the sidebar card', () => {
    const source = readSource();

    expect(source).toContain(
      'className="min-w-0 break-words rounded-lg bg-muted/38 px-3 py-2 text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]"'
    );
  });
});
