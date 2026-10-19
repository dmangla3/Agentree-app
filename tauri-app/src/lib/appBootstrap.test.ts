import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('desktop app bootstrap', () => {
  test('starts session restoration without delaying the first React render', () => {
    const source = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
    const restoreStart = source.indexOf('const desktopSessionRestore = restoreDesktopCloudSession()');
    const renderStart = source.indexOf('root.render(');
    const deepLinkStart = source.indexOf('void initializeDeepLinkHandlers();');

    expect(restoreStart).toBeGreaterThan(-1);
    expect(renderStart).toBeGreaterThan(restoreStart);
    expect(deepLinkStart).toBeGreaterThan(renderStart);
    expect(source).not.toContain('await restoreDesktopCloudSession()');
  });
});
