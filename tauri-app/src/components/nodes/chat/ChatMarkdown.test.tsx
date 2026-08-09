// @vitest-environment jsdom
import '../../../test/setup';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    markdownRenderSpy(children);
    return children;
  },
}));

describe('ChatMarkdown', () => {
  it('does not re-render markdown when parent rerenders with the same content', () => {
    const content = 'A **markdown** message with `code` and a [link](https://example.com).';
    const { rerender } = render(<ChatMarkdown>{content}</ChatMarkdown>);

    expect(markdownRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<ChatMarkdown>{content}</ChatMarkdown>);

    expect(markdownRenderSpy).toHaveBeenCalledTimes(1);
  });

  it('re-renders markdown when content changes', () => {
    const { rerender } = render(<ChatMarkdown>Initial **content**</ChatMarkdown>);

    expect(markdownRenderSpy).toHaveBeenCalledTimes(1);

    rerender(<ChatMarkdown>Updated **content**</ChatMarkdown>);

    expect(markdownRenderSpy).toHaveBeenCalledTimes(2);
  });
});
