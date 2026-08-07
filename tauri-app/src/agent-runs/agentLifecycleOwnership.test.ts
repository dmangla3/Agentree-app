import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readChatInputSource = () => readFileSync(join(process.cwd(), 'src/components/ChatInput.tsx'), 'utf8');

describe('agent lifecycle ownership boundaries', () => {
  it('does not persist terminal agent payloads directly from ChatInput', () => {
    const source = readChatInputSource();
    const terminalRegionStart = source.indexOf('const finalizeAgentRunMessage =');
    const terminalRegionEnd = source.indexOf('const resolveRunIdForReplay =');
    expect(terminalRegionStart).toBeGreaterThan(-1);
    expect(terminalRegionEnd).toBeGreaterThan(terminalRegionStart);

    const terminalRegion = source.slice(terminalRegionStart, terminalRegionEnd);
    expect(terminalRegion).not.toContain('upsertLocalNode');
    expect(terminalRegion).not.toContain('patchPersistedMessageLocally');
  });

  it('limits ChatInput local-node writes to optimistic node creation', () => {
    const source = readChatInputSource();
    const callIndexes = [...source.matchAll(/agentClient\.upsertLocalNode/g)].map((match) => match.index ?? -1);
    expect(callIndexes).toHaveLength(2);
    for (const index of callIndexes) {
      const surroundingSource = source.slice(Math.max(0, index - 160), index + 220);
      expect(surroundingSource).toContain('optimisticPair');
    }
  });
});
