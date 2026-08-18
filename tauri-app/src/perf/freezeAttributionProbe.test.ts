import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFreezeAttributionProbeEntryHandler,
  startFreezeAttributionProbe,
} from './freezeAttributionProbe';
import { resetRuntimeActivitiesForTest, startRuntimeActivity } from './runtimeActivityContext';

type RecordedEvent = {
  name: string;
  details?: Record<string, unknown>;
  options?: { source?: string; durationMs?: number };
};

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];

  callback: PerformanceObserverCallback;
  observed: PerformanceObserverInit[] = [];
  disconnected = false;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    FakePerformanceObserver.instances.push(this);
  }

  observe(options: PerformanceObserverInit) {
    this.observed.push(options);
  }

  disconnect() {
    this.disconnected = true;
  }
}

const record = (events: RecordedEvent[]) => (
  name: string,
  details?: Record<string, unknown>,
  options?: { source?: string; durationMs?: number },
) => {
  events.push({ name, details, options });
};

describe('freezeAttributionProbe', () => {
  afterEach(() => {
    resetRuntimeActivitiesForTest();
    vi.restoreAllMocks();
    FakePerformanceObserver.instances = [];
  });

  it('records LoAF entries with current runtime activity and script attribution', () => {
    vi.spyOn(performance, 'now').mockReturnValue(500);
    startRuntimeActivity({
      category: 'cache-refresh',
      name: 'messages.invalidate',
      details: { workspaceId: 'workspace-1' },
    });
    const events: RecordedEvent[] = [];
    const handleEntries = createFreezeAttributionProbeEntryHandler(record(events));

    handleEntries([{
      entryType: 'long-animation-frame',
      startTime: 120,
      duration: 456.78,
      blockingDuration: 234.56,
      renderStart: 300,
      styleAndLayoutStart: 360,
      scripts: [{
        invoker: 'MessagePort.onmessage',
        invokerType: 'event-listener',
        sourceURL: 'http://localhost/src/App.tsx',
        sourceFunctionName: 'renderMessages',
        duration: 210.12,
        pauseDuration: 1.23,
        forcedStyleAndLayoutDuration: 45.67,
      }],
    } as unknown as PerformanceEntry]);

    expect(events).toEqual([expect.objectContaining({
      name: 'runtime.long-animation-frame',
      options: { source: 'freeze-attribution-probe', durationMs: 456.78 },
      details: expect.objectContaining({
        entryType: 'long-animation-frame',
        startTime: 120,
        blockingDuration: 234.56,
        renderStart: 300,
        styleAndLayoutStart: 360,
        runtimeActivityCategory: 'cache-refresh',
        runtimeActivityName: 'messages.invalidate',
        runtimeActivityDetails: { workspaceId: 'workspace-1' },
        scripts: [expect.objectContaining({
          invoker: 'MessagePort.onmessage',
          sourceFunctionName: 'renderMessages',
          duration: 210.12,
          forcedStyleAndLayoutDuration: 45.67,
        })],
      }),
    })]);
  });

  it('records Long Task entries with current runtime activity as a fallback signal', () => {
    vi.spyOn(performance, 'now').mockReturnValue(800);
    startRuntimeActivity({
      category: 'host',
      name: 'agent-setup.worktree-spawn',
      details: { runId: 'run-1' },
    });
    const events: RecordedEvent[] = [];
    const handleEntries = createFreezeAttributionProbeEntryHandler(record(events));

    handleEntries([{
      entryType: 'longtask',
      startTime: 250,
      duration: 95.55,
      attribution: [{
        name: 'self',
        entryType: 'taskattribution',
        containerType: 'window',
      }],
    } as unknown as PerformanceEntry]);

    expect(events).toEqual([expect.objectContaining({
      name: 'runtime.long-task',
      options: { source: 'freeze-attribution-probe', durationMs: 95.55 },
      details: expect.objectContaining({
        entryType: 'longtask',
        startTime: 250,
        runtimeActivityCategory: 'host',
        runtimeActivityName: 'agent-setup.worktree-spawn',
        runtimeActivityDetails: { runId: 'run-1' },
        attribution: [expect.objectContaining({
          name: 'self',
          entryType: 'taskattribution',
          containerType: 'window',
        })],
      }),
    })]);
  });

  it('installs LoAF and Long Task observers and disconnects both on stop', () => {
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);

    const controller = startFreezeAttributionProbe(() => {});

    expect(FakePerformanceObserver.instances).toHaveLength(2);
    expect(FakePerformanceObserver.instances.map((observer) => observer.observed[0])).toEqual([
      { entryTypes: ['long-animation-frame'] },
      { entryTypes: ['longtask'] },
    ]);

    controller.stop();

    expect(FakePerformanceObserver.instances.every((observer) => observer.disconnected)).toBe(true);
  });
});
