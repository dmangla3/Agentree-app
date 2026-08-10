import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectLatestPerfSummary,
  formatPerfSummary,
} from './perf-latest-summary-lib.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('perf latest summary', () => {
  it('prints compact freeze, first-text, convergence, and graph metrics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentree-perf-summary-'));
    const captureDir = path.join(root, 'src-tauri/runtime-logs/tauri/perf-captures/perf-1');
    await writeJson(path.join(captureDir, 'send-flow-summary.json'), {
      generatedAt: '2026-05-19T00:00:05.000Z',
      sessionId: 'perf-1',
      sessionLabel: 'summary-fixture',
      runtime: {
        eventLoopStallCount: 2,
        eventLoopFreezeCount: 1,
        maxEventLoopStallMs: 1234,
        rafStallCount: 3,
        rafFreezeCount: 1,
        maxRafStallMs: 1500,
        longTaskCount: 1,
        maxLongTaskMs: 88,
      },
      flows: [{
        flowId: 'sendflow-abc123',
        status: 'completed',
        promptLength: 2,
        durationsMs: {
          sendToFirstRuntimeEvent: 100,
          sendToFirstAssistantText: 250,
          firstAssistantTextToProjection: 32,
          firstProjectionToVisibleText: 17,
          firstAssistantTextToVisibleText: 49,
          sendToTerminal: 900,
        },
        findings: [],
      }],
      findings: [],
    });

    await writeJson(path.join(root, 'runtime-logs/tauri-pilot-diagnostics/latest.json'), {
      label: 'pilot-fixture',
      collect: {
        validationErrors: [],
        convergence: {
          runRows: [{
            terminalStatus: 'completed',
            outputCommitSha: 'abc123',
            commitVisibleInLocalGraph: true,
          }],
        },
        graphEventContract: {
          graphChangingComputationPerSend: 2,
          graphComputationPerSend: 10,
          graphLayoutCount: 20,
        },
        probe: {
          maxIntervalGapMs: 321,
          maxRafGapMs: 654,
          intervalStallBreakdown: { maxActiveGapMs: 250, maxIdleGapMs: 321 },
          rafStallBreakdown: { maxActiveGapMs: 400, maxIdleGapMs: 654 },
        },
      },
      errors: [],
    });

    const summary = await collectLatestPerfSummary(root);
    const output = formatPerfSummary(summary);

    expect(output).toContain('Perf Capture');
    expect(output).toContain('event-loop: stalls=2 freezes=1 max=1234ms');
    expect(output).toContain('firstText=250ms');
    expect(output).toContain('text->project=32ms');
    expect(output).toContain('Pilot Report');
    expect(output).toContain('commitVisible=true');
    expect(output).toContain('graphChanging/send=2');
    expect(output.split('\n').length).toBeLessThan(70);
  });
});
