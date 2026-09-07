import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GraphDockComposer structure', () => {
  it('does not stack tooltip and menu trigger refs on dock control buttons', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).not.toContain('TooltipTrigger asChild');
    expect(source).toContain('<DropdownMenuTrigger asChild>');
    expect(source).not.toContain('<PopoverTrigger asChild>');
    expect(source).toContain('<PopoverTrigger');
  });

  it('keeps prompt text in an isolated autosizing textarea and debounces draft persistence', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).toContain('function GraphDockPromptTextarea');
    expect(source).toContain('cacheMeasurements');
    expect(source).toContain('window.setTimeout(() => onDraftChange(value), GRAPH_DOCK_PROMPT_DRAFT_DEBOUNCE_MS)');
    expect(source).not.toContain('setPrompt(value);');
    expect(source).not.toContain('onChange={(event) => updatePrompt(event.target.value)}');
  });

  it('disables native text suggestions on the graph composer textarea', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).toContain('autoComplete="off"');
    expect(source).toContain('autoCorrect="off"');
    expect(source).toContain('autoCapitalize="off"');
    expect(source).toContain('spellCheck={false}');
  });

  it('keeps file and skill mention selectors wired through the isolated prompt textarea', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).toContain('getActiveFileMention');
    expect(source).toContain('getActiveSkillMention');
    expect(source).toContain('handleFileMentionSelect');
    expect(source).toContain('handleSkillMentionSelect');
    expect(source).toContain('activeMentionFiles');
    expect(source).toContain('activeMentionSkills');
    expect(source).toContain('agentClient.listInstalledSkills');
    expect(source).toContain('agentClient.listFilesAtCommit');
    expect(source).toContain('Type @ for files, # for orchestration, or $ for skills');
    expect(source).toContain('expandRepoMentionContext');
  });

  it('describes # templates as orchestration prompts instead of executable flows', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).toContain('Select reusable node prompts or orchestration prompts.');
    expect(source).toContain("'Orchestration' : 'Node'");
    expect(source).toContain('promptIncludesOrchestrationTemplate');
    expect(source).not.toContain('Select pre-defined nodes or flows');
    expect(source).not.toContain("'Flow' : 'Node'");
    expect(source).not.toContain('promptIncludesFlowTemplate');
  });

  it('does not clip mention selectors at the composer frame', () => {
    const source = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(source).toContain('data-testid="graph-dock-composer"');
    expect(source).toContain('overflow-visible rounded-xl');
    expect(source).not.toContain('max-w-4xl overflow-hidden rounded-xl');
  });

});
