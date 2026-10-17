// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolPayloadDisplay } from '../ExecutionTimeline';
import { ToolFileChangesDiff, makeRenderableToolFileChange, parseToolFileChanges } from './ToolFileChangesDiff';

vi.mock('./DiffViewer', () => ({
    DiffViewer: ({ oldCode, newCode, fileDiff }: { oldCode: string; newCode: string; fileDiff?: { hunks?: unknown[] } }) => (
        <div data-testid="diff-viewer" data-parsed-hunks={fileDiff?.hunks?.length ?? 0}>
            <span data-testid="old-code">{oldCode}</span>
            <span data-testid="new-code">{newCode}</span>
        </div>
    ),
}));

describe('ToolFileChangesDiff', () => {
    it('replaces the raw tool payload with the file-change diff UI', () => {
        render(
            <ToolPayloadDisplay
                variant="raw"
                payload={{
                    changes: [{ path: 'src/new.ts', kind: { type: 'add' }, diff: 'export const value = 1;\n' }],
                }}
            />,
        );

        expect(document.querySelector('[data-tool-file-changes-diff]')).toBeTruthy();
        expect(screen.queryByText(/"changes"/)).toBeNull();
        expect(screen.getByTestId('diff-viewer')).toBeTruthy();
    });

    it('renders Codex update hunks with the shared parsed diff viewer', () => {
        render(
            <ToolFileChangesDiff
                payload={{
                    changes: [{
                        path: '/Users/example/.agentree/worktrees/workspace/nodes/node/tauri-app/src/example.ts',
                        kind: { type: 'update', move_path: null },
                        diff: '@@ -10,2 +10,2 @@\n unchanged\n-before\n+after\n',
                    }],
                }}
            />,
        );

        expect(screen.getByText('tauri-app/src/example.ts')).toBeTruthy();
        expect(screen.getByTestId('diff-viewer').getAttribute('data-parsed-hunks')).toBe('1');
        expect(screen.getByTestId('old-code').textContent).toContain('before');
        expect(screen.getByTestId('new-code').textContent).toContain('after');
    });

    it('treats added-file payloads as new file contents', () => {
        const [change] = parseToolFileChanges({
            changes: [{ path: 'src/new.ts', kind: { type: 'add' }, diff: 'export const value = 1;\n' }],
        });

        expect(makeRenderableToolFileChange(change)).toEqual(expect.objectContaining({
            oldCode: '',
            newCode: 'export const value = 1;\n',
        }));
    });

    it('keeps multi-file payloads compact until a file is opened', () => {
        render(
            <ToolFileChangesDiff
                payload={{
                    changes: [
                        { path: 'src/a.ts', kind: { type: 'add' }, diff: 'a\n' },
                        { path: 'src/b.ts', kind: { type: 'add' }, diff: 'b\n' },
                    ],
                }}
            />,
        );

        expect(screen.queryByTestId('diff-viewer')).toBeNull();
        fireEvent.click(screen.getByText('src/a.ts'));
        expect(screen.getByTestId('diff-viewer')).toBeTruthy();
    });
});
