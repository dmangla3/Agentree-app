import { describe, expect, it } from 'vitest';
import { classifyRuntimeGap } from './freezeProbe';

describe('classifyRuntimeGap', () => {
  it('ignores normal scheduler gaps below the stall threshold', () => {
    expect(classifyRuntimeGap(249.9)).toBeNull();
  });

  it('classifies short pauses as stalls and long pauses as freezes', () => {
    expect(classifyRuntimeGap(250)).toEqual({ severity: 'stall', gapMs: 250 });
    expect(classifyRuntimeGap(999.99)).toEqual({ severity: 'stall', gapMs: 999.99 });
    expect(classifyRuntimeGap(1000)).toEqual({ severity: 'freeze', gapMs: 1000 });
  });

  it('supports custom thresholds for targeted pilot scenarios', () => {
    expect(classifyRuntimeGap(120, { stallThresholdMs: 100, freezeThresholdMs: 500 })).toEqual({
      severity: 'stall',
      gapMs: 120,
    });
    expect(classifyRuntimeGap(520, { stallThresholdMs: 100, freezeThresholdMs: 500 })).toEqual({
      severity: 'freeze',
      gapMs: 520,
    });
  });
});
