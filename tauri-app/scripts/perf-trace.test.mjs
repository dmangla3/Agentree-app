import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTraceFromArtifacts,
  findLatestPerfCaptureDir,
  writeTraceForCapture,
} from './perf-trace-lib.mjs';

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

describe('perf trace export', () => {
  it('converts perf events and pilot actions into Chrome trace events', () => {
    const trace = buildTraceFromArtifacts({
      sessionLabel: 'trace-fixture',
      perfEvents: [
        {
          name: 'perf.capture.start',
          ts: '2026-05-26T00:00:00.000Z',
          source: 'perf-recorder',
          details: { startedAt: '2026-05-26T00:00:00.000Z' },
        },
        {
          name: 'query.cache-refresh.phase.start',
          ts: '2026-05-26T00:00:00.100Z',
          source: 'agentRunWorkspaceRefresh',
          details: { operationId: 7, phase: 'messages.invalidate', reason: 'terminal' },
        },
        {
          name: 'runtime.raf-stall',
          ts: '2026-05-26T00:00:00.250Z',
          durationMs: 1250,
          source: 'runtime-freeze-probe',
          details: { severity: 'freeze', runtimeActivityName: 'messages.invalidate' },
        },
        {
          name: 'runtime.long-animation-frame',
          ts: '2026-05-26T00:00:00.300Z',
          durationMs: 450,
          source: 'freeze-attribution-probe',
          details: {
            blockingDuration: 300,
            runtimeActivityName: 'messages.invalidate',
            scripts: [{ sourceFunctionName: 'renderMessages', duration: 275 }],
          },
        },
        {
          name: 'runtime.long-task',
          ts: '2026-05-26T00:00:00.325Z',
          durationMs: 90,
          source: 'freeze-attribution-probe',
          details: { runtimeActivityName: 'messages.invalidate' },
        },
        {
          name: 'query.cache-refresh.phase.end',
          ts: '2026-05-26T00:00:00.450Z',
          durationMs: 350,
          source: 'agentRunWorkspaceRefresh',
          details: { operationId: 7, phase: 'messages.invalidate', reason: 'terminal' },
        },
        {
          name: 'send-flow.mark',
          ts: '2026-05-26T00:00:00.500Z',
          source: 'send-flow',
          details: { flowId: 'flow-1', markName: 'first_assistant_text_projected' },
        },
      ],
      pilotReport: {
        label: 'pilot-fixture',
        wait: {
          summary: {
            actions: [{
              at: '2026-05-26T00:00:00.600Z',
              type: 'pan',
              actionLabel: 'wait-terminals',
              elapsedMs: 600,
            }],
          },
        },
      },
    });

    expect(trace.displayTimeUnit).toBe('ms');
    expect(trace.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ ph: 'M', name: 'process_name' }),
      expect.objectContaining({ ph: 'M', name: 'thread_name', args: { name: 'runtime' } }),
      expect.objectContaining({
        ph: 'X',
        name: 'runtime.raf-stall',
        cat: 'runtime,freeze',
        dur: 1_250_000,
      }),
      expect.objectContaining({
        ph: 'X',
        name: 'runtime.long-animation-frame',
        cat: 'runtime,freeze-attribution',
        dur: 450_000,
        tid: 1,
      }),
      expect.objectContaining({
        ph: 'X',
        name: 'runtime.long-task',
        cat: 'runtime,freeze-attribution',
        dur: 90_000,
        tid: 1,
      }),
      expect.objectContaining({
        ph: 'X',
        name: 'query.cache-refresh.phase:messages.invalidate',
        cat: 'query,cache-refresh',
        dur: 350_000,
      }),
      expect.objectContaining({
        ph: 'i',
        name: 'send-flow.mark:first_assistant_text_projected',
        cat: 'send-flow',
      }),
      expect.objectContaining({
        ph: 'i',
        name: 'pilot.pan',
        cat: 'pilot',
      }),
    ]));
  });

  it('finds the latest capture and writes a trace beside it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentree-perf-trace-'));
    const oldCapture = path.join(root, 'runtime-logs/perf-captures/perf-old');
    const newCapture = path.join(root, 'runtime-logs/perf-captures/perf-new');
    await writeJson(path.join(oldCapture, 'perf-events.json'), []);
    await writeJson(path.join(newCapture, 'perf-events.json'), [{
      name: 'runtime.event-loop-stall',
      ts: '2026-05-26T00:00:00.000Z',
      durationMs: 400,
      details: { severity: 'stall' },
    }]);

    const latest = await findLatestPerfCaptureDir(root);
    expect(latest).toBe(newCapture);

    const result = await writeTraceForCapture({ root, captureDir: latest });
    const written = JSON.parse(await readFile(result.outputPath, 'utf8'));

    expect(path.basename(result.outputPath)).toBe('perfetto-trace.json');
    expect(written.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'runtime.event-loop-stall', ph: 'X' }),
    ]));
  });

  it('prefers the pilot report that matches the capture session label', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentree-perf-trace-match-'));
    const capture = path.join(root, 'runtime-logs/perf-captures/perf-1');
    await writeJson(path.join(capture, 'send-flow-summary.json'), {
      sessionLabel: 'matching-label',
    });
    await writeJson(path.join(capture, 'perf-events.json'), []);
    await writeJson(path.join(root, 'runtime-logs/tauri-pilot-diagnostics/matching.json'), {
      label: 'matching-label',
      wait: { summary: { actions: [{ at: '2026-05-26T00:00:00.000Z', type: 'pan' }] } },
    });
    await writeJson(path.join(root, 'runtime-logs/tauri-pilot-diagnostics/newer.json'), {
      label: 'newer-label',
      wait: { summary: { actions: [{ at: '2026-05-26T00:00:01.000Z', type: 'click-node' }] } },
    });

    const result = await writeTraceForCapture({ root, captureDir: capture });
    const written = JSON.parse(await readFile(result.outputPath, 'utf8'));

    expect(path.basename(result.pilotReportPath)).toBe('matching.json');
    expect(written.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pilot.pan' }),
    ]));
    expect(written.traceEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pilot.click-node' }),
    ]));
  });
});
