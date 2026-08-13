import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyRuntimeGap, createRuntimeFreezeProbeDetails } from './freezeProbe';
import { resetRuntimeActivitiesForTest, startRuntimeActivity } from './runtimeActivityContext';

describe('classifyRuntimeGap', () => {
  afterEach(() => {
    resetRuntimeActivitiesForTest();
    vi.restoreAllMocks();
  });

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

  it('includes the active runtime activity in stall details', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(350);
    startRuntimeActivity({
      category: 'cache-refresh',
      name: 'commit-graph.refetch',
      details: { workspaceId: 'workspace-1' },
    });

    expect(createRuntimeFreezeProbeDetails()).toMatchObject({
      runtimeActivityCategory: 'cache-refresh',
      runtimeActivityName: 'commit-graph.refetch',
      runtimeActivityAgeMs: 250,
      runtimeActivityDepth: 1,
      runtimeActivityDetails: { workspaceId: 'workspace-1' },
    });
  });
});
