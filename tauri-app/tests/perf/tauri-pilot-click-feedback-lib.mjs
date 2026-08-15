const numericOrNull = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const CLICK_FEEDBACK_FIELDS = [
  'clickReturnMs',
  'firstCancelMs',
  'firstComposerClearedMs',
  'firstPromptVisibleMs',
];

export const recordClickFeedbackMetricsFromSample = (metrics, sample) => {
  if (!metrics || !sample || typeof sample.elapsedMs !== 'number') return metrics;
  const elapsedMs = sample.elapsedMs;
  const composer = sample.textareas?.find((textarea) => textarea.testId === 'chat-composer-textarea') ??
    sample.textareas?.[0] ??
    null;
  const sendControl = sample.buttons?.find((button) => button.testId === 'chat-send-button') ??
    sample.buttons?.find((button) => button.aria === 'Cancel sending message' || button.aria === 'Send') ??
    null;

  if (metrics.firstCancelMs === null && sendControl?.aria === 'Cancel sending message') {
    metrics.firstCancelMs = elapsedMs;
  }
  if (metrics.firstComposerClearedMs === null && composer?.valueLength === 0) {
    metrics.firstComposerClearedMs = elapsedMs;
  }
  if (metrics.firstPromptVisibleMs === null && sample.promptVisible === true) {
    metrics.firstPromptVisibleMs = elapsedMs;
  }

  return metrics;
};

export const validateClickFeedbackReport = (
  report,
  { thresholdMs = 300, fields = CLICK_FEEDBACK_FIELDS } = {},
) => {
  const failures = [];
  for (const field of fields) {
    const value = numericOrNull(report?.[field]);
    if (value === null) {
      failures.push(`${field} missing`);
      continue;
    }
    if (value > thresholdMs) {
      failures.push(`${field} exceeded ${thresholdMs}ms: ${value}ms`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    thresholdMs,
  };
};
