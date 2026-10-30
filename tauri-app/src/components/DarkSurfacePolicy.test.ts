import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('dark UI surface policy', () => {
  it('uses the shared near-black panel token for the ordinary Shared nodes dialog', () => {
    const source = readSource('src/components/WorkspaceShareDialog.tsx');
    const reviewStyles = readSource('src/App.css');

    expect(source).toContain('data-design-part="workspace-share-dialog"');
    expect(source).toContain('bg-[hsl(var(--app-panel))]');
    expect(source).not.toContain('dark:bg-black');
    expect(reviewStyles).toContain('html.dark[data-design-panels="before"] [data-design-part="workspace-share-dialog"]');
  });

  it('keeps literal black limited to specialized code panes and dimming overlays in this scope', () => {
    const resolutionSource = readSource('src/components/integration/SmartResolutionStage.tsx');
    const integrationWorkspaceSource = readSource('src/components/integration/IntegrationWorkspace.tsx');
    const mergePreviewSource = readSource('src/components/MergePreviewDialog.tsx');
    const mergeProgressSource = readSource('src/components/MergeProgressDialog.tsx');

    expect(resolutionSource).toContain('bg-black/95 p-0 font-mono');
    expect(resolutionSource).toContain('bg-black/95 p-4 font-mono');
    expect(integrationWorkspaceSource).toContain('bg-black/40 backdrop-blur-sm');
    expect(mergePreviewSource).toContain('bg-black/50 backdrop-blur-sm');
    expect(mergeProgressSource).toContain('bg-black/50 backdrop-blur-sm');
  });
});
