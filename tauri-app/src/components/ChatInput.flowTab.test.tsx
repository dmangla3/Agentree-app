import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readChatInputSource = () => readFileSync(join(process.cwd(), 'src/components/ChatInput.tsx'), 'utf8');

describe('ChatInput flow selector integration', () => {
  it('renders flow as a selector instead of composer mode tabs', () => {
    const source = readChatInputSource();

    expect(source).toContain('const FLOW_NONE_ID');
    expect(source).toContain('aria-label="Select flow"');
    expect(source).toContain('handleFlowSelection(FLOW_NONE_ID)');
    expect(source).not.toContain("const [composerMode, setComposerMode]");
    expect(source).not.toContain('ComposerFlowTab');
    expect(source).not.toContain("onClick={() => setComposerMode('flow')}");
  });

  it('keeps normal chat send wired to handleSend', () => {
    const source = readChatInputSource();

    expect(source).toMatch(/showCancel\s*\?\s*handleCancel/);
    expect(source).toContain('onClick={handlePrimaryAction}');
    expect(source).toContain("handleRunFlow({ input: trimmedPrompt, count: flowParallelCount })");
  });

  it('keeps primary action running state owned by composer node status, not flow runner state', () => {
    const source = readChatInputSource();
    const start = source.indexOf('const isFlowRunDisabled =');
    const end = source.indexOf('// --- Render ---', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const primaryActionBlock = source.slice(start, end);
    expect(primaryActionBlock).not.toContain('flowRunner.isRunning');
    expect(primaryActionBlock).toContain('showCancel');
    expect(primaryActionBlock).toContain('? handleCancel');
  });

  it('uses single-model selection while a flow is active', () => {
    const source = readChatInputSource();

    expect(source).toContain('const isFlowSelected = Boolean(selectedComposerFlow);');
    expect(source).toContain('setSelectedAgentRunCounts({ [selectedAgentId]: 1 });');
    expect(source).toContain("renderAgentModelSelector({ mode: isFlowSelected ? 'flow' : 'chat' })");
  });

  it('keeps flow prompt state synced for ordinary composer text', () => {
    const source = readChatInputSource();
    const start = source.indexOf('const handlePromptChange =');
    const end = source.indexOf('const expandRepoMentionContext', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const body = source.slice(start, end);
    expect(body).toMatch(/promptRef\.current = newPrompt;\s*setPrompt\(newPrompt\);/);
  });
});
