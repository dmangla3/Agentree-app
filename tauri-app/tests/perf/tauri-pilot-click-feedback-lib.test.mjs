import { describe, expect, it } from 'vitest';
import {
  recordClickFeedbackMetricsFromSample,
  validateClickFeedbackReport,
} from './tauri-pilot-click-feedback-lib.mjs';

describe('Tauri Pilot click feedback validation', () => {
  it('rejects send feedback that appears after the 300ms budget', () => {
    const report = {
      clickReturnMs: 4,
      firstCancelMs: 41,
      firstComposerClearedMs: 301,
      firstPromptVisibleMs: 245,
    };

    const result = validateClickFeedbackReport(report, { thresholdMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      'firstComposerClearedMs exceeded 300ms: 301ms',
    ]);
  });

  it('accepts send feedback when all user-visible markers are within 300ms', () => {
    const report = {
      clickReturnMs: 7,
      firstCancelMs: 244,
      firstComposerClearedMs: 244,
      firstPromptVisibleMs: 244,
    };

    const result = validateClickFeedbackReport(report, { thresholdMs: 300 });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('records immediate cancel and composer clearing from the post-click sample', () => {
    const metrics = {
      clickReturnMs: 12,
      firstCancelMs: null,
      firstComposerClearedMs: null,
      firstPromptVisibleMs: null,
    };

    recordClickFeedbackMetricsFromSample(metrics, {
      elapsedMs: 12,
      promptVisible: false,
      textareas: [
        { testId: 'chat-composer-textarea', valueLength: 0 },
        { testId: null, valueLength: 1 },
      ],
      buttons: [
        { testId: 'chat-send-button', aria: 'Cancel sending message' },
      ],
    });

    expect(metrics).toEqual({
      clickReturnMs: 12,
      firstCancelMs: 12,
      firstComposerClearedMs: 12,
      firstPromptVisibleMs: null,
    });
  });
});
