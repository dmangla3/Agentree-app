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

  it('routes the primary OpenCode setup through automatic auth discovery', () => {
    const source = readSource();

    expect(source).toContain("if (providerFilter === 'opencode' && importableCandidates.length === 1)");
    expect(source).toContain("? 'Add OpenCode'");
    expect(source).toContain('await importProfilesFromCandidates(importableCandidates)');
    expect(source).toContain('onLoadOpenCodeAuth={readOpenCodeAuth}');
    expect(source).toContain('openCodeAuthPath={detectedOpenCodeAuthPath}');
    expect(source).toContain('onImportExistingOpenCode={async () => {');
    expect(source).toContain(`onImportExistingOpenCode={async () => {
          await runDiscovery();
          setEditorOpen(false);
        }}`);
    expect(source).toContain('setDiscoveryError(error instanceof Error ? error.message : String(error));\n      throw error;');
    expect(source).toContain("providerFilter === 'opencode' && !importCandidates.some((candidate) => candidate.importable)");
    expect(source).toContain('onClick={openOpenCodeAdvancedSetup}');
    expect(source).toContain('Advanced setup');
    expect(source).toContain('Retry discovery');
    expect(source).not.toContain("? 'Import current auth.json' : 'Find existing'");
    expect(source).not.toContain('Paste auth.json');
    expect(source).not.toContain('Use current OpenCode login');
  });
});
