import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OrchestrationPanel structure', () => {
  it('labels saved orchestration records as prompts instead of executable flows', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/orchestration/OrchestrationPanel.tsx'), 'utf8');

    expect(source).toContain("'Node prompt' : 'Orchestration prompt'");
    expect(source).toContain("renderTemplateList('Node prompts'");
    expect(source).toContain("renderTemplateList('Orchestration prompts'");
    expect(source).toContain('orchestrationPromptTemplates');
    expect(source).not.toContain("'Pre-defined node' : 'Flow'");
    expect(source).not.toContain("renderTemplateList('Flows'");
    expect(source).not.toContain('flowTemplates');
  });
});
