import { describe, expect, it } from 'vitest';
import { bucketCount, sanitizeAnalyticsEvent } from './analytics';

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
  });
});
