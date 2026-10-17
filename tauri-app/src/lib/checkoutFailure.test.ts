import { describe, expect, it } from 'vitest';
import { describeCheckoutFailure } from './checkoutFailure';

describe('describeCheckoutFailure', () => {
  it('preserves the exact reason from a Tauri string rejection', () => {
    expect(describeCheckoutFailure(
      "git checkout failed: fatal: reference is not a tree: deadbeef",
      'manual',
    )).toEqual({
      title: 'Checkout Failed',
      description: "git checkout failed: fatal: reference is not a tree: deadbeef",
      variant: 'error',
    });
  });

  it('preserves Error messages for automatic checkout failures', () => {
    expect(describeCheckoutFailure(
      new Error('fatal: Unable to create index.lock: File exists.'),
      'auto',
    )).toEqual({
      title: 'Auto Checkout Failed',
      description: 'fatal: Unable to create index.lock: File exists.',
      variant: 'error',
    });
  });

  it('classifies uncommitted changes as a skipped checkout', () => {
    expect(describeCheckoutFailure(
      'Repository has Uncommitted Changes. Commit or stash them first.',
      'manual',
    )).toEqual({
      title: 'Checkout Skipped',
      description: 'Repository has Uncommitted Changes. Commit or stash them first.',
      variant: 'warning',
    });
  });

  it('explains when no provider reason is available', () => {
    expect(describeCheckoutFailure(null, 'manual')).toEqual({
      title: 'Checkout Failed',
      description: 'Git did not provide a reason for the checkout failure.',
      variant: 'error',
    });
  });
});
