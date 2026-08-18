import { describe, expect, it } from 'vitest';
import { buildSendFlowSessionReport } from './sendFlow';
import type { PerfEvent } from './types';

const event = (
  name: string,
  ts: string,
  details: Record<string, unknown> = {},
): PerfEvent => ({
  name,
  ts,
  sessionId: 'session-1',
  sessionLabel: 'test-session',
  details,
});

describe('buildSendFlowSessionReport', () => {
  it('summarizes first text receive/project/visible timings separately', () => {
    const flowId = 'flow-1';
    const events: PerfEvent[] = [
      event('send-flow.flow.started', '2026-05-19T00:00:00.000Z', { flowId, workspaceId: 'workspace-1', useAgent: true }),
      event('send-flow.mark', '2026-05-19T00:00:01.000Z', { flowId, markName: 'first_tauri_event_received', nodeId: 'assistant-1' }),
      event('send-flow.mark', '2026-05-19T00:00:01.200Z', { flowId, markName: 'first_assistant_text_received', nodeId: 'assistant-1' }),
      event('send-flow.mark', '2026-05-19T00:00:01.240Z', { flowId, markName: 'first_assistant_text_projected', nodeId: 'assistant-1' }),
      event('send-flow.mark', '2026-05-19T00:00:01.280Z', { flowId, markName: 'first_visible_text_rendered', nodeId: 'assistant-1' }),
      event('send-flow.lifecycle.completed', '2026-05-19T00:00:02.000Z', { flowId, nodeId: 'assistant-1', finalStatus: 'completed' }),
    ];

    const [flow] = buildSendFlowSessionReport(events).flows;

    expect(flow.milestones['mark.first_assistant_text_received']).toBe('2026-05-19T00:00:01.200Z');
    expect(flow.milestones['mark.first_assistant_text_projected']).toBe('2026-05-19T00:00:01.240Z');
    expect(flow.milestones['mark.first_visible_text_rendered']).toBe('2026-05-19T00:00:01.280Z');
    expect(flow.durationsMs).toMatchObject({
      sendToFirstRuntimeEvent: 1000,
      sendToFirstAssistantText: 1200,
      firstRuntimeEventToFirstAssistantText: 200,
      firstAssistantTextToProjection: 40,
      firstProjectionToVisibleText: 40,
      firstAssistantTextToVisibleText: 80,
      sendToFirstVisibleText: 1280,
    });
  });

  it('summarizes runtime stalls separately from send-flow phase timings', () => {
    const report = buildSendFlowSessionReport([
      event('runtime.event-loop-stall', '2026-05-19T00:00:01.000Z', { severity: 'stall' }),
      { ...event('runtime.raf-stall', '2026-05-19T00:00:02.000Z', { severity: 'freeze' }), durationMs: 1250 },
      { ...event('browser.long-task', '2026-05-19T00:00:03.000Z'), durationMs: 80 },
      { ...event('runtime.long-task', '2026-05-19T00:00:04.000Z'), durationMs: 110 },
      { ...event('runtime.long-animation-frame', '2026-05-19T00:00:05.000Z'), durationMs: 340 },
    ]);

    expect(report.runtime).toEqual({
      eventLoopStallCount: 1,
      eventLoopFreezeCount: 0,
      maxEventLoopStallMs: null,
      rafStallCount: 1,
      rafFreezeCount: 1,
      maxRafStallMs: 1250,
      longTaskCount: 2,
      maxLongTaskMs: 110,
      longAnimationFrameCount: 1,
      maxLongAnimationFrameMs: 340,
    });
  });
});
