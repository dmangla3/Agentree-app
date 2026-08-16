import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readChatInputSource = () => readFileSync(join(process.cwd(), 'src/components/ChatInput.tsx'), 'utf8');

describe('ChatInput flow tab integration', () => {
  it('renders chat and flow composer modes', () => {
    const source = readChatInputSource();

    expect(source).toContain("const [composerMode, setComposerMode] = useState<'chat' | 'flow'>('chat');");
    expect(source).toContain('ComposerFlowTab');
    expect(source).toContain('Chat');
    expect(source).toContain('Flow');
  });

  it('keeps normal chat send wired to handleSend', () => {
    const source = readChatInputSource();

    expect(source).toContain('onClick={showCancel ? handleCancel : handleSend}');
    expect(source).toContain("composerMode === 'chat'");
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
