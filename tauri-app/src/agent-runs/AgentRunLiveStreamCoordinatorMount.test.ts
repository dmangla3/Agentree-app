import { describe, expect, it } from 'vitest';
import { buildLandingWarningToast } from './AgentRunLiveStreamCoordinatorMount';

describe('AgentRunLiveStreamCoordinator landing warnings', () => {
  it('builds a persistent toast for a commit that was not landed', () => {
    expect(buildLandingWarningToast({
      message: 'Target branch main moved while the merge was running.',
      outputCommitSha: '4a5b11e3ef6b78ec',
    })).toEqual({
      title: 'Commit created, but target branch was not updated',
      description: 'Commit 4a5b11e3 was saved. Target branch main moved while the merge was running.',
      variant: 'warning',
      persistent: true,
    });
  });
});
