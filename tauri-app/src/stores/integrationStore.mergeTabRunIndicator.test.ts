import { describe, expect, it } from 'vitest';
import {
  defaultApplyState,
  defaultReviewRun,
  getMergeTabRunIndicator,
  type IntegrationSession,
} from './integrationStore';

const createSession = (overrides?: Partial<IntegrationSession>): IntegrationSession => ({
  id: 'session-1',
  workspaceId: 'workspace-1',
  repoPath: '/tmp/repo',
  stage: 'smart-resolution',
  target: null,
  sources: [],
  baseCommit: null,
  resolutionMode: 'smart',
  policy: {
    preserveTargetBehavior: true,
    preferSourceForPaths: [],
    doNotModifyLockfiles: true,
    stopOnBinaryConflicts: true,
    runTestsAfterMerge: false,
    summarizeRiskyResolutions: true,
  },
  preview: null,
  fileDecisions: [],
  agentActivities: [],
  selectedFilePath: null,
  smartResolutions: {},
  reviewRun: { ...defaultReviewRun },
  reviewSummary: null,
  reviewIssues: [],
  issueSelections: {},
  reviewTimeline: [],
  synthesizedSummaryText: null,
  applyState: { ...defaultApplyState },
  resultNodeId: null,
  resultCommitSha: null,
  promotionTarget: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('getMergeTabRunIndicator', () => {
  it('returns idle without a merge session', () => {
    expect(getMergeTabRunIndicator(null)).toBe('idle');
  });

  it('returns running while AI review is running', () => {
    const session = createSession({
      reviewRun: {
        ...defaultReviewRun,
        status: 'running',
      },
    });

    expect(getMergeTabRunIndicator(session)).toBe('running');
  });

  it('returns running while merge apply is running', () => {
    const session = createSession({
      reviewRun: {
        ...defaultReviewRun,
        status: 'completed',
      },
      applyState: {
        ...defaultApplyState,
        status: 'running',
      },
    });

    expect(getMergeTabRunIndicator(session)).toBe('running');
  });

  it('returns completed after AI review completes and before merge is applied', () => {
    const session = createSession({
      reviewRun: {
        ...defaultReviewRun,
        status: 'completed',
      },
    });

    expect(getMergeTabRunIndicator(session)).toBe('completed');
  });

  it('returns idle after approved merge has been applied', () => {
    const session = createSession({
      reviewRun: {
        ...defaultReviewRun,
        status: 'completed',
      },
      applyState: {
        ...defaultApplyState,
        status: 'passed',
      },
      stage: 'result',
      resultCommitSha: 'abc123',
    });

    expect(getMergeTabRunIndicator(session)).toBe('idle');
  });
});
