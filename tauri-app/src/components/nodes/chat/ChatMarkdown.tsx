import { memo, useEffect, useId, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { cn } from '../../../lib/utils';
import { createMarkdownLinkClickHandler } from '../../../lib/linkActivation';
import { ChatMermaidBlock } from './ChatMermaidBlock';
import type { MessageHighlightAnnotation } from '../../../stores/workspaceStore';
import { MESSAGE_HIGHLIGHT_COLORS } from '../../../lib/messageHighlights';
import { useActiveMessageHighlightId } from '../../highlights/MessageHighlightActiveContext';
import {
  createRangeFromHighlightOffsets,
  HIGHLIGHT_SCROLL_CONTAINER_SELECTOR,
} from '../../highlights/messageHighlightDom';

const chatMarkdownPlugins = [remarkGfm, remarkBreaks];
const HIGHLIGHT_REGISTRY_NAMES = {
  yellow: 'agentree-message-highlight-yellow',
  green: 'agentree-message-highlight-green',
  blue: 'agentree-message-highlight-blue',
  rose: 'agentree-message-highlight-rose',
  active: 'agentree-message-highlight-active',
} as const;

type HighlightColorName = keyof typeof HIGHLIGHT_REGISTRY_NAMES;
type HighlightBucket = Record<HighlightColorName, Range[]>;
const mountedHighlightBuckets = new Map<string, HighlightBucket>();

const createEmptyHighlightBucket = (): HighlightBucket => ({
  yellow: [],
  green: [],
  blue: [],
  rose: [],
  active: [],
});

const getCssHighlightApi = () => {
  const cssHighlights = typeof CSS !== 'undefined' ? (CSS as any).highlights : null;
  const HighlightCtor = typeof window !== 'undefined' ? (window as any).Highlight : null;
  if (!cssHighlights || !HighlightCtor) return null;
  return { cssHighlights, HighlightCtor };
};

const refreshCssHighlights = () => {
  const api = getCssHighlightApi();
  if (!api) return;
  const allBuckets = createEmptyHighlightBucket();
  mountedHighlightBuckets.forEach((bucket) => {
    MESSAGE_HIGHLIGHT_COLORS.forEach((color) => {
      allBuckets[color].push(...bucket[color]);
    });
    allBuckets.active.push(...bucket.active);
  });
  (Object.keys(HIGHLIGHT_REGISTRY_NAMES) as HighlightColorName[]).forEach((name) => {
    const ranges = allBuckets[name];
    if (ranges.length > 0) {
      api.cssHighlights.set(HIGHLIGHT_REGISTRY_NAMES[name], new api.HighlightCtor(...ranges));
    } else {
      api.cssHighlights.delete(HIGHLIGHT_REGISTRY_NAMES[name]);
    }
  });
};

const getHighlightScrollContainer = (root: HTMLElement): HTMLElement | null => {
  const explicitContainer = root.closest<HTMLElement>(HIGHLIGHT_SCROLL_CONTAINER_SELECTOR);
  if (explicitContainer && explicitContainer.scrollHeight > explicitContainer.clientHeight) {
    return explicitContainer;
  }

  let container: HTMLElement | null = root.parentElement;
  while (container) {
    const style = window.getComputedStyle(container);
    const canScroll = /(auto|scroll)/.test(`${style.overflow}${style.overflowY}`) && container.scrollHeight > container.clientHeight;
    if (canScroll) return container;
    container = container.parentElement;
  }

  return null;
};

const scrollRangeIntoView = (root: HTMLElement, range: Range) => {
  const rangeRect = range.getBoundingClientRect();
  if (!rangeRect.width && !rangeRect.height) return;
  const container = getHighlightScrollContainer(root);
  if (container) {
    const containerRect = container.getBoundingClientRect();
    const delta = rangeRect.top - containerRect.top - (containerRect.height / 2) + (rangeRect.height / 2);
    const nextScrollTop = Math.max(0, Math.min(
      container.scrollTop + delta,
      container.scrollHeight - container.clientHeight
    ));
    container.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    return;
  }
  rangeRect.top && window.scrollBy({ top: rangeRect.top - (window.innerHeight / 2), behavior: 'auto' });
};

const scheduleActiveHighlightScroll = (
  root: HTMLElement,
  highlight: MessageHighlightAnnotation
) => {
  let cancelled = false;
  const timeoutIds: number[] = [];
  const frameIds: number[] = [];

  const scroll = () => {
    if (cancelled) return;
    const range = createRangeFromHighlightOffsets(root, highlight.range.start, highlight.range.end);
    if (!range) return;
    scrollRangeIntoView(root, range);
  };

  scroll();
  frameIds.push(window.requestAnimationFrame(() => {
    scroll();
    frameIds.push(window.requestAnimationFrame(scroll));
  }));
  timeoutIds.push(window.setTimeout(scroll, 80));
  timeoutIds.push(window.setTimeout(scroll, 220));

  return () => {
    cancelled = true;
    frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
    timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
  };
};

export const createChatMarkdownComponents = (repoPath?: string | null) => {
  const handleLinkClick = createMarkdownLinkClickHandler(repoPath);
  return {
  code: (props: any) => {
    const { inline, className: codeClassName, children, ...rest } = props;
    const match = /language-(\w+)/.exec(codeClassName || '');
    const codeContent = String(children).replace(/\n$/, '');

    if (!inline && match) {
      if (match[1]?.toLowerCase() === 'mermaid') {
        return <ChatMermaidBlock chart={codeContent} />;
      }

      return (
        <pre className="my-2 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border border-border/60 bg-muted/25 p-3 text-xs leading-[1.55]">
          <code className="font-mono" {...rest}>
            {codeContent}
          </code>
        </pre>
      );
    }

    return (
      <code
        className={cn(
          "rounded-sm bg-muted/50 px-1 py-0.5 text-[0.9em] font-mono whitespace-pre-wrap break-words leading-[1.45] [overflow-wrap:anywhere]",
          codeClassName
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: (props: any) => (
    <pre
      className="my-2 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-transparent"
      {...props}
    />
  ),
  p: (props: any) => <p className="mb-1.5 min-w-0 max-w-full break-words [text-wrap:pretty] [overflow-wrap:anywhere] last:mb-0" {...props} />,
  a: (props: any) => (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary hover:underline"
      {...props}
      onClick={handleLinkClick}
    />
  ),
  blockquote: (props: any) => (
    <blockquote className="my-2 min-w-0 max-w-full break-words [overflow-wrap:anywhere] border-l-2 border-border pl-3 italic" {...props} />
  ),
  ul: (props: any) => <ul className="my-2 min-w-0 max-w-full list-inside list-disc space-y-1.5 pl-2" {...props} />,
  ol: (props: any) => <ol className="my-2 min-w-0 max-w-full list-inside list-decimal space-y-1.5 pl-2" {...props} />,
  li: (props: any) => <li className="min-w-0 max-w-full break-words pl-1 leading-[1.58] [overflow-wrap:anywhere]" {...props} />,
  table: (props: any) => (
    <div className="my-1.5 min-w-0 max-w-full overflow-x-auto">
      <table className="min-w-0 max-w-full table-auto border-collapse border border-border" {...props} />
    </div>
  ),
  th: (props: any) => (
    <th className="min-w-0 break-words [overflow-wrap:anywhere] border border-border bg-muted/50 px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: (props: any) => <td className="min-w-0 break-words [overflow-wrap:anywhere] border border-border px-2 py-1" {...props} />,
  img: (props: any) => <img className="h-auto max-w-full" {...props} />,
  hr: (props: any) => <hr className="my-3 max-w-full border-border/70" {...props} />,
  };
};

export const chatMarkdownComponents = createChatMarkdownComponents();

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  repoPath = null,
  messageId = null,
  highlights = [],
  activeHighlightId,
  highlightEnabled = false,
}: {
  children: string;
  repoPath?: string | null;
  messageId?: string | null;
  highlights?: MessageHighlightAnnotation[];
  activeHighlightId?: string | null;
  highlightEnabled?: boolean;
}) {
  const components = useMemo(() => createChatMarkdownComponents(repoPath), [repoPath]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootId = useId();
  const contextActiveHighlightId = useActiveMessageHighlightId();
  const resolvedActiveHighlightId = activeHighlightId ?? contextActiveHighlightId;

  useEffect(() => {
    const root = rootRef.current;
    const api = getCssHighlightApi();
    if (!root || !api || !highlightEnabled || highlights.length === 0) {
      mountedHighlightBuckets.delete(rootId);
      refreshCssHighlights();
      return;
    }

    const bucket = createEmptyHighlightBucket();
    let cancelActiveHighlightScroll: (() => void) | null = null;
    highlights.forEach((highlight) => {
      const range = createRangeFromHighlightOffsets(root, highlight.range.start, highlight.range.end);
      if (!range) return;
      bucket[highlight.color].push(range);
      if (highlight.id === resolvedActiveHighlightId) {
        bucket.active.push(range);
        cancelActiveHighlightScroll = scheduleActiveHighlightScroll(root, highlight);
      }
    });
    mountedHighlightBuckets.set(rootId, bucket);
    refreshCssHighlights();

    return () => {
      cancelActiveHighlightScroll?.();
      mountedHighlightBuckets.delete(rootId);
      refreshCssHighlights();
    };
  }, [rootId, highlights, highlightEnabled, resolvedActiveHighlightId, children]);

  return (
    <div
      ref={rootRef}
      className="contents"
      data-agentree-highlight-content-root={highlightEnabled ? 'true' : undefined}
      data-agentree-highlight-message-id={messageId || undefined}
    >
      <ReactMarkdown remarkPlugins={chatMarkdownPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

ChatMarkdown.displayName = 'ChatMarkdown';
