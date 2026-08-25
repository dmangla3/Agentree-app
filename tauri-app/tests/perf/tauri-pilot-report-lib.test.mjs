import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { compactPilotReport, writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

describe('Tauri Pilot report compaction', () => {
  it('moves large repeated arrays to sidecar artifacts while keeping a useful tail inline', () => {
    const report = {
      label: 'pilot-report-test',
      collect: {
        perfEvents: Array.from({ length: 8 }, (_, index) => ({ name: `event-${index}`, ts: index })),
        probe: {
          samples: Array.from({ length: 6 }, (_, index) => ({ label: `sample-${index}`, elapsedMs: index })),
          actions: Array.from({ length: 5 }, (_, index) => ({ type: 'action', index })),
          rafStalls: Array.from({ length: 4 }, (_, index) => ({ gapMs: 250 + index })),
          maxRafGapMs: 253,
        },
      },
    };

    const compacted = compactPilotReport(report, {
      artifactDir: 'runtime-logs/tauri-pilot-diagnostics/pilot-report-test.artifacts',
      limits: {
        perfEvents: 3,
        samples: 2,
        actions: 2,
        stalls: 2,
      },
    });

    expect(compacted.collect.perfEvents).toEqual([
      { name: 'event-5', ts: 5 },
      { name: 'event-6', ts: 6 },
      { name: 'event-7', ts: 7 },
    ]);
    expect(compacted.collect.perfEventsSummary).toEqual({
      total: 8,
      inline: 3,
      omitted: 5,
      artifactPath: 'runtime-logs/tauri-pilot-diagnostics/pilot-report-test.artifacts/collect-perfEvents.json',
    });
    expect(compacted.collect.probe.samples).toEqual([
      { label: 'sample-4', elapsedMs: 4 },
      { label: 'sample-5', elapsedMs: 5 },
    ]);
    expect(compacted.collect.probe.samplesSummary.omitted).toBe(4);
    expect(compacted.collect.probe.actions).toEqual([
      { type: 'action', index: 3 },
      { type: 'action', index: 4 },
    ]);
    expect(compacted.collect.probe.actionsSummary.omitted).toBe(3);
    expect(compacted.collect.probe.rafStalls).toEqual([
      { gapMs: 252 },
      { gapMs: 253 },
    ]);
    expect(report.collect.perfEvents).toHaveLength(8);
  });

  it('writes sidecar files and a compact main report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-report-'));
    try {
      const reportPath = join(dir, 'report.json');
      const result = writeCompactPilotReport({
        reportPath,
        report: {
          collect: {
            perfEvents: Array.from({ length: 5 }, (_, index) => ({ name: `event-${index}` })),
          },
        },
        limits: { perfEvents: 2 },
      });

      const main = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(main.collect.perfEvents).toEqual([{ name: 'event-3' }, { name: 'event-4' }]);
      expect(main.collect.perfEventsSummary.total).toBe(5);
      expect(result.artifacts).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, 'report.artifacts', 'collect-perfEvents.json'), 'utf8'))).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
