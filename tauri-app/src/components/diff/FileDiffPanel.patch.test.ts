import { describe, expect, it } from 'vitest';
import { processFile } from '@pierre/diffs';
import { buildFileDiffPatch } from './FileDiffPanel';
import type { FileDiff } from '../../lib/agentClient';

describe('buildFileDiffPatch', () => {
    it('preserves source line positions across separate hunks', () => {
        const fileDiff: FileDiff = {
            path: 'src/example.ts',
            status: 'modified',
            additions: 2,
            deletions: 2,
            is_binary: false,
            hunks: [
                {
                    old_start: 10,
                    old_lines: 2,
                    new_start: 10,
                    new_lines: 2,
                    content: ' unchanged\n-old 11\n+new 11\n',
                },
                {
                    old_start: 100,
                    old_lines: 2,
                    new_start: 100,
                    new_lines: 2,
                    content: ' unchanged\n-old 101\n+new 101\n',
                },
            ],
        };

        const parsed = processFile(buildFileDiffPatch(fileDiff), {
            isGitDiff: true,
            throwOnError: true,
        });

        expect(parsed?.hunks.map((hunk) => ({
            deletionStart: hunk.deletionStart,
            additionStart: hunk.additionStart,
            collapsedBefore: hunk.collapsedBefore,
        }))).toEqual([
            { deletionStart: 10, additionStart: 10, collapsedBefore: 9 },
            { deletionStart: 100, additionStart: 100, collapsedBefore: 88 },
        ]);
    });
});
