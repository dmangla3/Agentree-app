import { describe, expect, it } from 'vitest';
import type { Message } from '../../stores/workspaceStore';
import { getCommitStatsForMessage } from './commitStats';

const message = (overrides: Partial<Message>): Message => ({
  id: 'commit-message',
  role: 'assistant',
  content: 'Generated commit',
  parentId: 'assistant-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

describe('getCommitStatsForMessage', () => {
  it('prefers authoritative commit-row totals over execution payloads', () => {
    expect(getCommitStatsForMessage(message({
      commit: {
        sha: 'abc123',
        files_changed_count: 3,
        total_additions: 12,
        total_deletions: 4,
      },
      execution_data: {
        files_changed_count: 1,
        files_changed: ['src/old.ts'],
      },
    }))).toEqual({ filesChanged: 3, totalAdditions: 12, totalDeletions: 4 });
  });

  it('supports current run payloads whose changed-file list contains paths', () => {
    expect(getCommitStatsForMessage(message({
      execution_data: {
        files_changed_count: 2,
        files_changed: ['src/a.ts', 'src/b.ts'],
        meta: { total_additions: 8, total_deletions: 3 },
      },
    }))).toEqual({ filesChanged: 2, totalAdditions: 8, totalDeletions: 3 });
  });

  it('fills missing commit-row fields from the execution metadata', () => {
    expect(getCommitStatsForMessage(message({
      commit: {
        sha: 'abc123',
        files_changed_count: 2,
        total_additions: null,
        total_deletions: null,
      },
      execution_data: {
        meta: { total_additions: 9, total_deletions: 1 },
      },
    }))).toEqual({ filesChanged: 2, totalAdditions: 9, totalDeletions: 1 });
  });

  it('retains compatibility with detailed file-stat payloads', () => {
    expect(getCommitStatsForMessage(message({
      execution_data: {
        files_changed: [
          { additions: 5, deletions: 1 },
          { additions: 2, deletions: 4 },
        ],
      },
    }))).toEqual({ filesChanged: 2, totalAdditions: 7, totalDeletions: 5 });
  });
});
