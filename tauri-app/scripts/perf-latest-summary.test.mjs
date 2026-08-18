import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectLatestPerfSummary,
  formatPerfSummary,
  summarizeRuntimeStallFrequencyBuckets,
  summarizeRuntimeStallsByActivity,
  summarizeRuntimeStallsByPhase,
} from './perf-latest-summary-lib.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('perf latest summary', () => {
  it('prints compact freeze, first-text, convergence, and graph metrics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentree-perf-summary-'));
    const captureDir = path.join(root, 'runtime-logs/perf-captures/perf-1');
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
        longAnimationFrameCount: 2,
        maxLongAnimationFrameMs: 456,
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
    await writeJson(path.join(captureDir, 'perf-events.json'), [
      {
        name: 'runtime.event-loop-stall',
        ts: '2026-05-19T00:00:01.000Z',
        durationMs: 260,
        details: { severity: 'stall' },
      },
      {
        name: 'runtime.event-loop-stall',
        ts: '2026-05-19T00:00:02.000Z',
        durationMs: 1234,
        details: { severity: 'freeze' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-19T00:00:03.000Z',
        durationMs: 499,
        details: { severity: 'stall' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-19T00:00:04.000Z',
        durationMs: 500,
        details: { severity: 'stall' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-19T00:00:05.000Z',
        durationMs: 1500,
        details: { severity: 'freeze' },
      },
    ]);

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
    expect(output).toContain('event-loop: stalls=2 freezes=1 max=1234ms >=250/500/1000=2/1/1');
    expect(output).toContain('raf: stalls=3 freezes=1 max=1500ms >=250/500/1000=3/2/1');
    expect(output).toContain('loaf=2 max=456ms');
    expect(output).toContain('firstText=250ms');
    expect(output).toContain('text->project=32ms');
    expect(output).toContain('Pilot Report');
    expect(output).toContain('commitVisible=true');
    expect(output).toContain('graphChanging/send=2');
    expect(output.split('\n').length).toBeLessThan(70);
  });

  it('counts runtime stall frequency buckets by threshold', () => {
    expect(summarizeRuntimeStallFrequencyBuckets([
      { name: 'runtime.event-loop-stall', durationMs: 249 },
      { name: 'runtime.event-loop-stall', durationMs: 250 },
      { name: 'runtime.event-loop-stall', durationMs: 500 },
      { name: 'runtime.event-loop-stall', durationMs: 1000 },
      { name: 'runtime.raf-stall', durationMs: 250 },
      { name: 'runtime.raf-stall', durationMs: 999 },
      { name: 'runtime.raf-stall', durationMs: 1000 },
      { name: 'runtime.raf-stall', durationMs: null },
      { name: 'runtime.long-task', durationMs: 2000 },
    ])).toEqual({
      eventLoop: {
        gte250Ms: 3,
        gte500Ms: 2,
        gte1000Ms: 1,
      },
      raf: {
        gte250Ms: 3,
        gte500Ms: 2,
        gte1000Ms: 1,
      },
    });
  });

  it('buckets runtime stalls by nearest lifecycle/worktree/finalization phase', () => {
    const buckets = summarizeRuntimeStallsByPhase([
      {
        name: 'send-flow.agent-setup.worktree-create.requested',
        ts: '2026-05-21T00:00:01.000Z',
        details: { flowId: 'flow-1' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-21T00:00:01.250Z',
        durationMs: 1200,
        details: { severity: 'freeze' },
      },
      {
        name: 'send-flow.agent-setup.spawn.returned',
        ts: '2026-05-21T00:00:04.000Z',
        details: { flowId: 'flow-1' },
      },
      {
        name: 'runtime.event-loop-stall',
        ts: '2026-05-21T00:00:04.300Z',
        durationMs: 650,
        details: { severity: 'stall' },
      },
      {
        name: 'query.messages.refresh.deferred',
        ts: '2026-05-21T00:00:08.000Z',
        details: { reason: 'agent-terminal' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-21T00:00:08.100Z',
        durationMs: 900,
        details: { severity: 'stall' },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-21T00:00:20.000Z',
        durationMs: 400,
        details: { severity: 'stall' },
      },
    ], { windowMs: 1000 });

    expect(buckets).toEqual({
      'cache-refresh': {
        eventLoopCount: 0,
        eventLoopMaxMs: null,
        eventLoopBuckets: {
          gte250Ms: 0,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        rafCount: 1,
        rafMaxMs: 900,
        rafBuckets: {
          gte250Ms: 1,
          gte500Ms: 1,
          gte1000Ms: 0,
        },
        totalCount: 1,
      },
      spawn: {
        eventLoopCount: 1,
        eventLoopMaxMs: 650,
        eventLoopBuckets: {
          gte250Ms: 1,
          gte500Ms: 1,
          gte1000Ms: 0,
        },
        rafCount: 0,
        rafMaxMs: null,
        rafBuckets: {
          gte250Ms: 0,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        totalCount: 1,
      },
      unclassified: {
        eventLoopCount: 0,
        eventLoopMaxMs: null,
        eventLoopBuckets: {
          gte250Ms: 0,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        rafCount: 1,
        rafMaxMs: 400,
        rafBuckets: {
          gte250Ms: 1,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        totalCount: 1,
      },
      worktree: {
        eventLoopCount: 0,
        eventLoopMaxMs: null,
        eventLoopBuckets: {
          gte250Ms: 0,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        rafCount: 1,
        rafMaxMs: 1200,
        rafBuckets: {
          gte250Ms: 1,
          gte500Ms: 1,
          gte1000Ms: 1,
        },
        totalCount: 1,
      },
    });
  });

  it('uses runtime activity details on stall events before nearest-event bucketing', () => {
    const buckets = summarizeRuntimeStallsByPhase([
      {
        name: 'runtime.event-loop-stall',
        ts: '2026-05-21T00:00:01.000Z',
        durationMs: 1178,
        details: {
          severity: 'freeze',
          runtimeActivityCategory: 'cache-refresh',
          runtimeActivityName: 'local-nodes.invalidate',
        },
      },
    ], { windowMs: 1000 });

    expect(buckets).toEqual({
      'cache-refresh': {
        eventLoopCount: 1,
        eventLoopMaxMs: 1178,
        eventLoopBuckets: {
          gte250Ms: 1,
          gte500Ms: 1,
          gte1000Ms: 1,
        },
        rafCount: 0,
        rafMaxMs: null,
        rafBuckets: {
          gte250Ms: 0,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        totalCount: 1,
      },
    });
  });

  it('summarizes stalls that happened during explicit runtime activities', () => {
    const buckets = summarizeRuntimeStallsByActivity([
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-21T00:00:01.000Z',
        durationMs: 1729,
        details: {
          runtimeActivityCategory: 'cache-refresh',
          runtimeActivityName: 'local-nodes.invalidate',
        },
      },
      {
        name: 'runtime.event-loop-stall',
        ts: '2026-05-21T00:00:02.000Z',
        durationMs: 488,
        details: {
          runtimeActivityCategory: 'cache-refresh',
          runtimeActivityName: 'local-nodes.invalidate',
        },
      },
      {
        name: 'runtime.raf-stall',
        ts: '2026-05-21T00:00:03.000Z',
        durationMs: 400,
        details: {},
      },
    ]);

    expect(buckets).toEqual({
      'cache-refresh:local-nodes.invalidate': {
        eventLoopCount: 1,
        eventLoopMaxMs: 488,
        eventLoopBuckets: {
          gte250Ms: 1,
          gte500Ms: 0,
          gte1000Ms: 0,
        },
        rafCount: 1,
        rafMaxMs: 1729,
        rafBuckets: {
          gte250Ms: 1,
          gte500Ms: 1,
          gte1000Ms: 1,
        },
        totalCount: 2,
      },
    });
  });
});
