import { describe, expect, it } from 'vitest';
import {
  analyticsFailureCategory,
  bucketCharacterCount,
  bucketCount,
  sanitizeAnalyticsEvent,
} from './analytics';

describe('privacy-preserving analytics', () => {
  it('drops unknown events and non-allowlisted properties', () => {
    expect(sanitizeAnalyticsEvent('Workspace Content Viewed', { prompt: 'secret' })).toBeNull();
    expect(sanitizeAnalyticsEvent('Screen Viewed', {
      screen: 'workspace',
      workspace_id: 'private-id',
      prompt: 'private prompt',
      node_id: 'private-node',
    })).toEqual({
      eventName: 'Screen Viewed',
      properties: { screen: 'workspace' },
    });
  });

  it('accepts only the expected primitive type and truncates strings', () => {
    expect(sanitizeAnalyticsEvent('Screen Viewed', {
      screen: 'x'.repeat(100),
      has_workspace: 'true',
      workspace_count_bucket: '2-5',
    })).toEqual({
      eventName: 'Screen Viewed',
      properties: {
        screen: 'x'.repeat(64),
        workspace_count_bucket: '2-5',
      },
    });
  });

  it('reports only coarse count buckets', () => {
    expect([0, 1, 2, 6, 21].map(bucketCount)).toEqual(['0', '1', '2-5', '6-20', '21+']);
    expect([0, 1, 101, 501, 2001].map(bucketCharacterCount)).toEqual([
      '0',
      '1-100',
      '101-500',
      '501-2000',
      '2001+',
    ]);
  });

  it('maps errors to predefined categories without sending error text', () => {
    expect(analyticsFailureCategory(new DOMException('cancelled', 'AbortError'))).toBe('aborted');
    expect(analyticsFailureCategory(new Error('network timeout at a private URL'))).toBe('network');
    expect(analyticsFailureCategory(new Error('private workspace failed'))).toBe('unknown');
  });
});
