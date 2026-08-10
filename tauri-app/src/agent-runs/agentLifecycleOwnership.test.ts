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
    const localFirstRegionStart = source.indexOf(
      'if (hasLocalAgentRuntime && optimisticAssistantMessageIds.length > 0)'
    );
    const localFirstRegionEnd = source.indexOf(
      "releaseSendAcceptance('local-first-persisted');",
      localFirstRegionStart
    );
    expect(localFirstRegionStart).toBeGreaterThan(-1);
    expect(localFirstRegionEnd).toBeGreaterThan(localFirstRegionStart);
    const localFirstRegion = source.slice(localFirstRegionStart, localFirstRegionEnd);

    expect(callIndexes).toHaveLength(2);
    for (const index of callIndexes) {
      expect(index).toBeGreaterThanOrEqual(localFirstRegionStart);
      expect(index).toBeLessThan(localFirstRegionEnd);
    }
    expect(localFirstRegion).toContain('optimisticPair');
    expect(localFirstRegion).toContain('optimisticUserMessages');
    expect(localFirstRegion).toContain('assistantMessages');
  });

  it('keeps stream projection dispatch outside ChatInput', () => {
    const source = readChatInputSource();
    expect(source).not.toContain('const processAgentEvent');
    expect(source).not.toContain('const addTimelineEvent');
    expect(source).not.toContain('const updateAgentRunUsage');
    expect(source).toContain('agentRunStreamDispatch');
  });
});
