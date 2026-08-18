import { describe, expect, it } from 'vitest';
import type { ExecutionTimelineModel } from './executionTimelineModel';
import {
  buildExecutionTimelineDisplayScale,
  buildTimelineRulerTicks,
  getTimelineDisplayFraction,
} from './executionTimelineDisplayScale';

const makeModel = (bars: ExecutionTimelineModel['bars']): ExecutionTimelineModel => ({
  bars,
  markers: [],
  laneCount: 1,
  minMs: Math.min(...bars.map((bar) => bar.startMs)),
  maxMs: Math.max(...bars.map((bar) => bar.endMs)),
});

const makeBar = (id: string, startMs: number, endMs: number): ExecutionTimelineModel['bars'][number] => ({
  id: `agent:${id}`,
  kind: 'agent_run',
  entityId: `assistant_message:${id}`,
  messageId: id,
  parentMessageId: null,
  label: id,
  status: 'completed',
  startMs,
  endMs,
  realEndMs: endMs,
  isActive: false,
  lane: 0,
});

describe('execution timeline display scale', () => {
  it('compresses long idle gaps into explicit break segments', () => {
    const model = makeModel([
      makeBar('early', 0, 100),
      makeBar('late', 900, 1000),
    ]);

    const scale = buildExecutionTimelineDisplayScale(model, {
      idleGapThresholdMs: 200,
      compressedGapMs: 50,
    });

    expect(scale.segments.some((segment) => segment.kind === 'break' && segment.startMs === 100 && segment.endMs === 900)).toBe(true);
    expect(getTimelineDisplayFraction(900, scale)).toBeLessThan(0.9);
  });

  it('keeps short gaps on the continuous scale', () => {
    const model = makeModel([
      makeBar('early', 0, 100),
      makeBar('late', 180, 280),
    ]);

    const scale = buildExecutionTimelineDisplayScale(model, {
      idleGapThresholdMs: 200,
      compressedGapMs: 50,
    });

    expect(scale.segments.some((segment) => segment.kind === 'break')).toBe(false);
    expect(getTimelineDisplayFraction(180, scale)).toBeCloseTo(180 / 280, 4);
  });

  it('compresses leading and trailing idle gaps inside the selected domain', () => {
    const model: ExecutionTimelineModel = {
      bars: [makeBar('middle', 500, 600)],
      markers: [],
      laneCount: 1,
      minMs: 0,
      maxMs: 1000,
    };

    const scale = buildExecutionTimelineDisplayScale(model, {
      idleGapThresholdMs: 200,
      compressedGapMs: 50,
    });

    expect(scale.segments.some((segment) => segment.kind === 'break' && segment.startMs === 0 && segment.endMs === 500)).toBe(true);
    expect(scale.segments.some((segment) => segment.kind === 'break' && segment.startMs === 600 && segment.endMs === 1000)).toBe(true);
  });

  it('thins ruler ticks so adjacent labels have enough display distance', () => {
    const hourMs = 60 * 60 * 1000;
    const bars = Array.from({ length: 16 }, (_, index) => makeBar(`run-${index}`, index * hourMs, index * hourMs + 60_000));
    const scale = buildExecutionTimelineDisplayScale(makeModel(bars));
    const ticks = buildTimelineRulerTicks(scale, 8);

    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index].fraction - ticks[index - 1].fraction).toBeGreaterThanOrEqual(0.075);
    }
  });

  it('prefers important event ticks over nearby generated ticks', () => {
    const scale = buildExecutionTimelineDisplayScale(makeModel([
      makeBar('only', 0, 1000),
    ]));

    const ticks = buildTimelineRulerTicks(scale, 8, {
      minDisplayGapFraction: 0.18,
      preferredTicks: [
        { timeMs: 100, priority: 0, label: 'random' },
        { timeMs: 115, priority: 2, label: 'user' },
        { timeMs: 130, priority: 3, label: 'agent' },
        { timeMs: 145, priority: 1, label: 'idle' },
      ],
    });

    expect(ticks.some((tick) => tick.timeMs === 130)).toBe(true);
    expect(ticks.some((tick) => tick.timeMs === 100)).toBe(false);
    expect(ticks.some((tick) => tick.timeMs === 115)).toBe(false);
    expect(ticks.some((tick) => tick.timeMs === 145)).toBe(false);
  });
});
