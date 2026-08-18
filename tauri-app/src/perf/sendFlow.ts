import type { PerfEvent, SendFlowFinding, SendFlowSessionReport, SendFlowSummary } from './types';
import { recordPerfEvent } from './perfRecorder';

const SEND_FLOW_PREFIX = 'send-flow.';
const FLOW_ID_KEY = 'flowId';

const isPerfEvent = (value: unknown): value is PerfEvent => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PerfEvent>;
  return typeof candidate.ts === 'string' && typeof candidate.name === 'string';
};

const parseEventTimeMs = (event: PerfEvent | null | undefined): number | null => {
  if (!event?.ts) return null;
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : null;
};

const getFlowId = (event: PerfEvent): string | null => {
  const value = event.details?.[FLOW_ID_KEY];
  return typeof value === 'string' && value.trim() ? value : null;
};

const getStringDetail = (event: PerfEvent, key: string): string | null => {
  const value = event.details?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
};

const getBooleanDetail = (event: PerfEvent, key: string): boolean | null => {
  const value = event.details?.[key];
  return typeof value === 'boolean' ? value : null;
};

const getNumberDetail = (event: PerfEvent, key: string): number | null => {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const toIso = (value: number | null): string | null => (value == null ? null : new Date(value).toISOString());

const durationBetween = (startMs: number | null, endMs: number | null): number | null => {
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return Number((endMs - startMs).toFixed(2));
};

const getDuration = (event: PerfEvent): number | null => (
  typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
    ? event.durationMs
    : null
);

const maxDuration = (events: PerfEvent[]): number | null => {
  const values = events.map(getDuration).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return Number(Math.max(...values).toFixed(2));
};

const addFinding = (
  findings: SendFlowFinding[],
  summary: SendFlowSummary,
  finding: Omit<SendFlowFinding, 'flowId'>
) => {
  findings.push({
    ...finding,
    flowId: summary.flowId,
  });
};

export const createSendFlowId = () =>
  `sendflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const recordSendFlowEvent = (
  suffix: string,
  details: Record<string, unknown>,
  options?: { source?: string; durationMs?: number }
) => {
  recordPerfEvent(`${SEND_FLOW_PREFIX}${suffix}`, details, options);
};

export const recordSendFlowMark = (
  flowId: string,
  markName: string,
  details?: Record<string, unknown>,
  options?: { source?: string; durationMs?: number }
) => {
  recordSendFlowEvent('mark', { flowId, markName, ...(details || {}) }, options);
};

export const collectSessionFlowIds = (events: PerfEvent[]): string[] => {
  const ids = new Set<string>();
  for (const event of events.filter(isPerfEvent)) {
    const flowId = getFlowId(event);
    if (flowId) ids.add(flowId);
  }
  return [...ids];
};

const countByName = (events: PerfEvent[]) =>
  events.reduce<Record<string, number>>((acc, event) => {
    acc[event.name] = (acc[event.name] || 0) + 1;
    if (event.name === `${SEND_FLOW_PREFIX}mark`) {
      const markName = getStringDetail(event, 'markName');
      if (markName) {
        acc[`mark:${markName}`] = (acc[`mark:${markName}`] || 0) + 1;
      }
    }
    return acc;
  }, {});

const findFirstEvent = (events: PerfEvent[], predicate: (event: PerfEvent) => boolean) =>
  events.find(predicate) ?? null;

const findLastEvent = (events: PerfEvent[], predicate: (event: PerfEvent) => boolean) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
};

const buildSummary = (flowId: string, events: PerfEvent[]): SendFlowSummary => {
  const flowEvents = events
    .filter((event) => getFlowId(event) === flowId)
    .sort((a, b) => (parseEventTimeMs(a) ?? 0) - (parseEventTimeMs(b) ?? 0));

  const flowStarted = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}flow.started`);
  const optimisticUser = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}optimistic.user-created`);
  const optimisticAssistant = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}optimistic.assistant-created`);
  const apiStart = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}api.request-start`);
  const apiEnd = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}api.response-received`);
  const persistedAssistant = findFirstEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}assistant.persisted`);
  const firstEvent = findFirstEvent(
    flowEvents,
    (event) => event.name === `${SEND_FLOW_PREFIX}mark` && getStringDetail(event, 'markName') === 'first_tauri_event_received'
  );
  const firstAssistantText = findFirstEvent(
    flowEvents,
    (event) =>
      event.name === `${SEND_FLOW_PREFIX}mark` &&
      (
        getStringDetail(event, 'markName') === 'first_assistant_text_received' ||
        getStringDetail(event, 'markName') === 'first_assistant_delta'
      )
  );
  const firstProjectedText = findFirstEvent(
    flowEvents,
    (event) => event.name === `${SEND_FLOW_PREFIX}mark` && getStringDetail(event, 'markName') === 'first_assistant_text_projected'
  );
  const firstVisibleText = findFirstEvent(
    flowEvents,
    (event) => event.name === `${SEND_FLOW_PREFIX}mark` && getStringDetail(event, 'markName') === 'first_visible_text_rendered'
  );
  const terminalEvent = findLastEvent(
    flowEvents,
    (event) =>
      event.name === `${SEND_FLOW_PREFIX}lifecycle.completed`
      || event.name === `${SEND_FLOW_PREFIX}lifecycle.failed`
      || event.name === `${SEND_FLOW_PREFIX}lifecycle.cancelled`
  );
  const cleanupEvent = findLastEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}cleanup.finished`);
  const focusObserved = findLastEvent(
    flowEvents,
    (event) => event.name === 'chat.focus-scroll.end' && getBooleanDetail(event, 'targetFound') === true
  );
  const focusDispatch = findLastEvent(
    flowEvents,
    (event) => event.name === 'workspace.focus.dispatched'
  );

  const startedAtMs = parseEventTimeMs(flowStarted ?? flowEvents[0] ?? { ts: '', name: '' });
  const apiStartMs = parseEventTimeMs(apiStart);
  const apiEndMs = parseEventTimeMs(apiEnd);
  const assistantPersistedMs = parseEventTimeMs(persistedAssistant);
  const firstEventMs = parseEventTimeMs(firstEvent);
  const firstAssistantTextMs = parseEventTimeMs(firstAssistantText);
  const firstProjectedTextMs = parseEventTimeMs(firstProjectedText);
  const firstVisibleMs = parseEventTimeMs(firstVisibleText);
  const focusObservedMs = parseEventTimeMs(focusObserved);
  const terminalMs = parseEventTimeMs(terminalEvent);

  const summary: SendFlowSummary = {
    flowId,
    sessionId: flowEvents[0]?.sessionId ?? null,
    sessionLabel: flowEvents[0]?.sessionLabel ?? null,
    startedAt: toIso(startedAtMs),
    terminalAt: toIso(terminalMs),
    status: terminalEvent?.name === `${SEND_FLOW_PREFIX}lifecycle.completed`
      ? 'completed'
      : terminalEvent?.name === `${SEND_FLOW_PREFIX}lifecycle.failed`
        ? 'failed'
        : terminalEvent?.name === `${SEND_FLOW_PREFIX}lifecycle.cancelled`
          ? 'cancelled'
          : 'incomplete',
    workspaceId: getStringDetail(flowStarted ?? flowEvents[0] ?? { ts: '', name: '' } as PerfEvent, 'workspaceId'),
    promptLength: getNumberDetail(flowStarted ?? flowEvents[0] ?? { ts: '', name: '' } as PerfEvent, 'promptLength'),
    usedAgent: getBooleanDetail(flowStarted ?? flowEvents[0] ?? { ts: '', name: '' } as PerfEvent, 'useAgent'),
    optimisticUserMessageId: getStringDetail(optimisticUser ?? flowStarted ?? { ts: '', name: '' } as PerfEvent, 'messageId'),
    optimisticAssistantMessageId: getStringDetail(optimisticAssistant ?? flowStarted ?? { ts: '', name: '' } as PerfEvent, 'messageId'),
    persistedUserMessageId: getStringDetail(findLastEvent(flowEvents, (event) => event.name === `${SEND_FLOW_PREFIX}user.persisted`) ?? { ts: '', name: '' } as PerfEvent, 'messageId'),
    persistedAssistantMessageId: getStringDetail(persistedAssistant ?? { ts: '', name: '' } as PerfEvent, 'messageId'),
    finalFocusedMessageId: getStringDetail(focusObserved ?? focusDispatch ?? { ts: '', name: '' } as PerfEvent, 'focusedMessageId')
      ?? getStringDetail(focusObserved ?? focusDispatch ?? { ts: '', name: '' } as PerfEvent, 'messageId'),
    milestones: {},
    durationsMs: {},
    counts: countByName(flowEvents),
    findings: [],
  };

  const milestoneEvents: Array<[string, PerfEvent | null]> = [
    ['flow.started', flowStarted],
    ['optimistic.user-created', optimisticUser],
    ['optimistic.assistant-created', optimisticAssistant],
    ['api.request-start', apiStart],
    ['api.response-received', apiEnd],
    ['assistant.persisted', persistedAssistant],
    ['mark.first_tauri_event_received', firstEvent],
    ['mark.first_assistant_text_received', firstAssistantText],
    ['mark.first_assistant_text_projected', firstProjectedText],
    ['mark.first_visible_text_rendered', firstVisibleText],
    ['focus.observed', focusObserved],
    ['lifecycle.terminal', terminalEvent],
    ['cleanup.finished', cleanupEvent],
  ];

  for (const [key, event] of milestoneEvents) {
    if (event?.ts) {
      summary.milestones[key] = event.ts;
    }
  }

  const durationEntries: Array<[string, number | null]> = [
    ['sendToApiAck', durationBetween(startedAtMs, apiEndMs)],
    ['sendToAssistantPersisted', durationBetween(startedAtMs, assistantPersistedMs)],
    ['sendToFirstRuntimeEvent', durationBetween(startedAtMs, firstEventMs)],
    ['sendToFirstAssistantText', durationBetween(startedAtMs, firstAssistantTextMs)],
    ['sendToFirstVisibleText', durationBetween(startedAtMs, firstVisibleMs)],
    ['sendToFocusObserved', durationBetween(startedAtMs, focusObservedMs)],
    ['sendToTerminal', durationBetween(startedAtMs, terminalMs)],
    ['apiRoundTrip', durationBetween(apiStartMs, apiEndMs)],
    ['persistedToFirstVisibleText', durationBetween(assistantPersistedMs, firstVisibleMs)],
    ['firstRuntimeEventToFirstAssistantText', durationBetween(firstEventMs, firstAssistantTextMs)],
    ['firstAssistantTextToProjection', durationBetween(firstAssistantTextMs, firstProjectedTextMs)],
    ['firstProjectionToVisibleText', durationBetween(firstProjectedTextMs, firstVisibleMs)],
    ['firstAssistantTextToVisibleText', durationBetween(firstAssistantTextMs, firstVisibleMs)],
  ];

  for (const [key, value] of durationEntries) {
    if (value != null) {
      summary.durationsMs[key] = value;
    }
  }

  const findings: SendFlowFinding[] = [];
  if (!flowStarted) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'missing_flow_start',
      message: 'Send flow never recorded a start event.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}flow.started`],
    });
  }
  if (!optimisticUser) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'missing_optimistic_user',
      message: 'Optimistic user node was not recorded.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}optimistic.user-created`],
    });
  }
  if (summary.usedAgent && !optimisticAssistant) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'missing_optimistic_assistant',
      message: 'Optimistic assistant node was not recorded for an agent-backed send.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}optimistic.assistant-created`],
    });
  }
  if (!apiStart || !apiEnd) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'incomplete_api_lifecycle',
      message: 'Send request did not record both request start and response received.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}api.request-start`, `${SEND_FLOW_PREFIX}api.response-received`],
    });
  }
  if (summary.usedAgent && !persistedAssistant) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'missing_assistant_persisted',
      message: 'No persisted assistant node was recorded.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}assistant.persisted`],
    });
  }
  if (summary.usedAgent && !firstEvent) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'missing_first_runtime_event',
      message: 'Stream was started but no first runtime event was observed.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}mark`, 'first_tauri_event_received'],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  if (summary.status === 'completed' && !firstVisibleText) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'missing_first_visible_text',
      message: 'Run completed without recording first visible assistant text.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}mark`, 'first_visible_text_rendered'],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  if (!terminalEvent) {
    addFinding(findings, summary, {
      severity: 'error',
      code: 'missing_terminal_event',
      message: 'Send flow never reached a terminal lifecycle event.',
      relatedEventNames: [
        `${SEND_FLOW_PREFIX}lifecycle.completed`,
        `${SEND_FLOW_PREFIX}lifecycle.failed`,
        `${SEND_FLOW_PREFIX}lifecycle.cancelled`,
      ],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  if (terminalEvent && !cleanupEvent) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'missing_cleanup',
      message: 'Terminal send flow did not record cleanup completion.',
      relatedEventNames: [`${SEND_FLOW_PREFIX}cleanup.finished`],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  const assistantFocusDispatches = flowEvents.filter((event) =>
    event.name === 'workspace.focus.dispatched'
    && getStringDetail(event, 'messageId') === summary.persistedAssistantMessageId
  );
  if (assistantFocusDispatches.length === 0 && summary.persistedAssistantMessageId) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'assistant_focus_not_dispatched',
      message: 'Assistant node was never dispatched as focused.',
      relatedEventNames: ['workspace.focus.dispatched'],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  if (assistantFocusDispatches.length > 1) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'duplicate_assistant_focus_dispatch',
      message: `Assistant node focus was dispatched ${assistantFocusDispatches.length} times.`,
      relatedEventNames: ['workspace.focus.dispatched'],
      nodeId: summary.persistedAssistantMessageId,
    });
  }
  if (summary.persistedAssistantMessageId && !focusObserved) {
    addFinding(findings, summary, {
      severity: 'warn',
      code: 'assistant_focus_not_observed',
      message: 'Chat viewport never confirmed focus scroll to the assistant node.',
      relatedEventNames: ['chat.focus-scroll.end'],
      nodeId: summary.persistedAssistantMessageId,
    });
  }

  summary.findings = findings;
  return summary;
};

export const buildSendFlowSessionReport = (events: PerfEvent[]): SendFlowSessionReport => {
  const validEvents = events.filter(isPerfEvent);
  const flowIds = collectSessionFlowIds(validEvents);
  const flows = flowIds.map((flowId) => buildSummary(flowId, validEvents));
  const eventLoopStalls = validEvents.filter((event) => event.name === 'runtime.event-loop-stall');
  const rafStalls = validEvents.filter((event) => event.name === 'runtime.raf-stall');
  const longTasks = validEvents.filter((event) => event.name === 'browser.long-task' || event.name === 'runtime.long-task');
  const longAnimationFrames = validEvents.filter((event) => event.name === 'runtime.long-animation-frame');
  return {
    generatedAt: new Date().toISOString(),
    sessionId: flows[0]?.sessionId ?? null,
    sessionLabel: flows[0]?.sessionLabel ?? null,
    flowCount: flows.length,
    runtime: {
      eventLoopStallCount: eventLoopStalls.length,
      eventLoopFreezeCount: eventLoopStalls.filter((event) => getStringDetail(event, 'severity') === 'freeze').length,
      maxEventLoopStallMs: maxDuration(eventLoopStalls),
      rafStallCount: rafStalls.length,
      rafFreezeCount: rafStalls.filter((event) => getStringDetail(event, 'severity') === 'freeze').length,
      maxRafStallMs: maxDuration(rafStalls),
      longTaskCount: longTasks.length,
      maxLongTaskMs: maxDuration(longTasks),
      longAnimationFrameCount: longAnimationFrames.length,
      maxLongAnimationFrameMs: maxDuration(longAnimationFrames),
    },
    findings: flows.flatMap((flow) => flow.findings),
    flows,
  };
};
