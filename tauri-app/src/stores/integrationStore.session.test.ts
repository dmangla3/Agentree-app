import { beforeEach, describe, expect, it } from 'vitest';
import { useIntegrationStore, type MergeSource, type MergeTarget } from './integrationStore';

const source = (id: string, commitSha = id): MergeSource => ({
  id,
  type: 'graph-node',
  label: id,
  commitSha,
  nodeId: id,
});

const target = (id: string, commitSha = id): MergeTarget => ({
  id,
  type: 'tracked-ref',
  label: id,
  commitSha,
  branchName: id,
});

describe('integration merge session lifecycle', () => {
  beforeEach(() => {
    useIntegrationStore.getState().closeMergeSession();
  });

  it('keeps queued sources when ensuring the same merge session again', () => {
    const store = useIntegrationStore.getState();

    store.ensureMergeSession('workspace-1', '/repo');
    useIntegrationStore.getState().addSource(source('source-1', 'abc123'));
    useIntegrationStore.getState().setTarget(target('main', 'def456'));

    useIntegrationStore.getState().ensureMergeSession('workspace-1', '/repo');

    const session = useIntegrationStore.getState().session;
    expect(session?.sources).toEqual([source('source-1', 'abc123')]);
    expect(session?.target).toEqual(target('main', 'def456'));
  });

  it('starts a fresh session when explicitly opening a merge session', () => {
    const store = useIntegrationStore.getState();

    store.ensureMergeSession('workspace-1', '/repo');
    useIntegrationStore.getState().addSource(source('source-1', 'abc123'));
    useIntegrationStore.getState().setTarget(target('main', 'def456'));

    useIntegrationStore.getState().openMergeSession('workspace-1', '/repo');

    const session = useIntegrationStore.getState().session;
    expect(session?.sources).toEqual([]);
    expect(session?.target).toBeNull();
  });

  it('clears target-dependent state without clearing queued sources', () => {
    const store = useIntegrationStore.getState();

    store.openMergeSession('workspace-1', '/repo');
    useIntegrationStore.getState().addSource(source('source-1', 'abc123'));
    useIntegrationStore.getState().setTarget(target('main', 'def456'));

    useIntegrationStore.getState().clearTarget();

    const session = useIntegrationStore.getState().session;
    expect(session?.target).toBeNull();
    expect(session?.sources).toEqual([source('source-1', 'abc123')]);
    expect(session?.preview).toBeNull();
    expect(session?.fileDecisions).toEqual([]);
  });

  it('keeps the target but clears stale result state when changing sources', () => {
    const store = useIntegrationStore.getState();

    store.openMergeSession('workspace-1', '/repo');
    useIntegrationStore.getState().setTarget(target('main', 'def456'));
    useIntegrationStore.getState().moveToStage('result');
    useIntegrationStore.getState().setApplyState({ status: 'passed', log: 'done' });
    useIntegrationStore.getState().setResult('result-node', 'result-sha');

    useIntegrationStore.getState().addSource(source('source-1', 'abc123'));

    const session = useIntegrationStore.getState().session;
    expect(session?.target).toEqual(target('main', 'def456'));
    expect(session?.sources).toEqual([source('source-1', 'abc123')]);
    expect(session?.stage).toBe('setup');
    expect(session?.applyState).toEqual({ status: 'not-run' });
    expect(session?.resultNodeId).toBeNull();
    expect(session?.resultCommitSha).toBeNull();
  });
});
