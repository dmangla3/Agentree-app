import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('desktop app bootstrap', () => {
  test('skips cloud session work under the existing development auth bypass', () => {
    const source = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
    const restoreStart = source.indexOf('const desktopSessionRestore = devAuthBypass');
    const renderStart = source.indexOf('root.render(');
    const deepLinkStart = source.indexOf('void initializeDeepLinkHandlers();');

    expect(source).toContain("const devAuthBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true'");
    expect(source).toContain('? Promise.resolve()');
    expect(source).toContain('if (!devAuthBypass) {');
    expect(restoreStart).toBeGreaterThan(-1);
    expect(renderStart).toBeGreaterThan(restoreStart);
    expect(deepLinkStart).toBeGreaterThan(renderStart);
    expect(source).not.toContain('await restoreDesktopCloudSession()');
  });
});
