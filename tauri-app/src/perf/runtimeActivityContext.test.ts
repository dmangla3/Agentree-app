import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRuntimeActivitySnapshot,
  resetRuntimeActivitiesForTest,
  startRuntimeActivity,
  withRuntimeActivity,
} from './runtimeActivityContext';

describe('runtimeActivityContext', () => {
  afterEach(() => {
    resetRuntimeActivitiesForTest();
    vi.restoreAllMocks();
  });

  it('reports the current activity with depth and age', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(175);

    const activity = startRuntimeActivity({
      category: 'cache-refresh',
      name: 'local-nodes.invalidate',
      details: { workspaceId: 'workspace-1' },
    });

    expect(getRuntimeActivitySnapshot()).toEqual({
      id: activity.id,
      category: 'cache-refresh',
      name: 'local-nodes.invalidate',
      ageMs: 75,
      depth: 1,
      details: { workspaceId: 'workspace-1' },
    });
  });

  it('restores the previous activity when nested work finishes', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);

    const outer = startRuntimeActivity({ category: 'cache-refresh', name: 'messages.invalidate' });
    const inner = startRuntimeActivity({ category: 'cache-refresh', name: 'commit-graph.refetch' });

    expect(getRuntimeActivitySnapshot()?.name).toBe('commit-graph.refetch');
    inner.end();
    expect(getRuntimeActivitySnapshot()?.name).toBe('messages.invalidate');
    outer.end();
    expect(getRuntimeActivitySnapshot()).toBeNull();
  });

  it('clears async activity after the wrapped promise settles', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);

    await withRuntimeActivity(
      { category: 'cache-refresh', name: 'messages.invalidate' },
      async () => {
        expect(getRuntimeActivitySnapshot()?.name).toBe('messages.invalidate');
      },
    );

    expect(getRuntimeActivitySnapshot()).toBeNull();
  });
});
