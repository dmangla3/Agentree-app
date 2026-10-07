// @vitest-environment jsdom

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffViewer } from './DiffViewer';

const pierreMocks = vi.hoisted(() => ({
    rendererOptions: [] as Array<Record<string, unknown>>,
    renderedFileDiffs: [] as Array<Record<string, unknown>>,
    renderContainers: [] as HTMLElement[],
    cleanupCount: 0,
    parseDiffFromFile: vi.fn(() => ({ name: 'file', type: 'change', hunks: [] })),
}));

vi.mock('@pierre/diffs', () => ({
    FileDiff: class {
        private renderedNode?: HTMLElement;

        constructor(options: Record<string, unknown>) {
            pierreMocks.rendererOptions.push(options);
        }

        render({ fileDiff, containerWrapper }: { fileDiff: Record<string, unknown>; containerWrapper: HTMLElement }) {
            this.renderedNode = document.createElement('div');
            this.renderedNode.dataset.pierreMock = 'rendered';
            containerWrapper.appendChild(this.renderedNode);
            pierreMocks.renderContainers.push(containerWrapper);
            pierreMocks.renderedFileDiffs.push(fileDiff);
            return true;
        }

        cleanUp() {
            this.renderedNode?.remove();
            pierreMocks.cleanupCount += 1;
        }
    },
    parseDiffFromFile: pierreMocks.parseDiffFromFile,
}));

const latestOptions = (): Record<string, unknown> => (
    pierreMocks.rendererOptions[pierreMocks.rendererOptions.length - 1]
);

describe('DiffViewer', () => {
    beforeEach(() => {
        pierreMocks.rendererOptions.length = 0;
        pierreMocks.renderedFileDiffs.length = 0;
        pierreMocks.renderContainers.length = 0;
        pierreMocks.cleanupCount = 0;
        pierreMocks.parseDiffFromFile.mockClear();
        document.documentElement.classList.remove('dark');
    });

    afterEach(() => {
        cleanup();
    });

    it('maps Agentree diff settings to Pierre', () => {
        render(
            <DiffViewer
                oldCode={'const value = 1;\n'}
                newCode={'const value = 2;\n'}
                language="typescript"
                showLineNumbers={false}
            />,
        );

        expect(pierreMocks.parseDiffFromFile).toHaveBeenCalledWith(
            { name: 'file', contents: 'const value = 1;\n', lang: 'typescript' },
            { name: 'file', contents: 'const value = 2;\n', lang: 'typescript' },
        );
        expect(latestOptions()).toMatchObject({
            diffStyle: 'split',
            disableFileHeader: true,
            disableLineNumbers: true,
            expandUnchanged: false,
            collapsedContextThreshold: 3,
            lineDiffType: 'word',
            overflow: 'scroll',
            themeType: 'light',
        });
    });

    it('renders parsed patch metadata without re-diffing synthetic files', () => {
        const fileDiff = {
            name: 'src/example.ts',
            type: 'change' as const,
            hunks: [{ deletionStart: 100, additionStart: 100 }],
            splitLineCount: 1,
            unifiedLineCount: 2,
            isPartial: true,
            deletionLines: ['old'],
            additionLines: ['new'],
        };

        render(<DiffViewer oldCode="old" newCode="new" fileDiff={fileDiff as never} />);

        expect(pierreMocks.parseDiffFromFile).not.toHaveBeenCalled();
        expect(pierreMocks.renderedFileDiffs[pierreMocks.renderedFileDiffs.length - 1]).toBe(fileDiff);
    });

    it('keeps the imperative renderer mounted through React Strict Mode cleanup', () => {
        render(
            <StrictMode>
                <DiffViewer oldCode="before" newCode="after" />
            </StrictMode>,
        );

        expect(pierreMocks.renderContainers.length).toBeGreaterThanOrEqual(2);
        expect(pierreMocks.cleanupCount).toBeGreaterThanOrEqual(1);
        expect(document.querySelector('[data-pierre-mock="rendered"]')).not.toBeNull();
    });

    it('applies max height to the scrolling diff region', () => {
        render(<DiffViewer oldCode="before" newCode="after" maxHeight="500px" />);

        expect(document.querySelector('[data-diff-renderer="pierre"]')?.parentElement?.style.maxHeight).toBe('500px');
    });

    it('updates the Pierre theme when the Agentree theme changes', async () => {
        render(<DiffViewer oldCode="before" newCode="after" />);
        expect(latestOptions().themeType).toBe('light');

        document.documentElement.classList.add('dark');

        await waitFor(() => expect(latestOptions().themeType).toBe('dark'));
    });

    it('passes valid highlighted lines into the renderer styles', () => {
        render(
            <DiffViewer
                oldCode="before"
                newCode="after"
                highlightLines={[3, 1, 3, 0, -1, 1.5]}
            />,
        );

        const highlightStyles = String(latestOptions().unsafeCSS);
        expect(highlightStyles).toContain('[data-line="1"]');
        expect(highlightStyles).toContain('[data-line="3"]');
        expect(highlightStyles).not.toContain('[data-line="0"]');
        expect(highlightStyles.match(/\[data-line="3"\]/g)).toHaveLength(1);
    });

    it('switches Pierre between split and unified views', () => {
        const onViewModeChange = vi.fn();
        render(
            <DiffViewer
                oldCode="before"
                newCode="after"
                onViewModeChange={onViewModeChange}
            />,
        );

        fireEvent.click(screen.getByTitle('Unified view'));

        expect(latestOptions().diffStyle).toBe('unified');
        expect(onViewModeChange).toHaveBeenCalledWith(false);
    });
});
