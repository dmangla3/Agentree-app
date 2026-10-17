import { memo, useEffect, useState } from 'react';
import { cn } from '../../../lib/utils';

let katexPromise: Promise<typeof import('katex')> | null = null;
const renderedMath = new Map<string, string>();
const MAX_CACHED_FORMULAS = 200;

const cacheRenderedMath = (key: string, html: string) => {
  if (renderedMath.size >= MAX_CACHED_FORMULAS) {
    const oldestKey = renderedMath.keys().next().value;
    if (oldestKey) renderedMath.delete(oldestKey);
  }
  renderedMath.set(key, html);
};

const loadKatex = () => {
  katexPromise ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([katex]) => katex);
  return katexPromise;
};

export const ChatMath = memo(function ChatMath({
  formula,
  displayMode = false,
}: {
  formula: string;
  displayMode?: boolean;
}) {
  const cacheKey = `${displayMode ? 'display' : 'inline'}:${formula}`;
  const [html, setHtml] = useState<string | null>(() => renderedMath.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cached = renderedMath.get(cacheKey);
    if (cached) {
      setHtml(cached);
      setFailed(false);
      return;
    }

    setHtml(null);
    setFailed(false);
    loadKatex()
      .then((katex) => katex.renderToString(formula, {
        displayMode,
        throwOnError: true,
        trust: false,
        strict: 'warn',
      }))
      .then((rendered) => {
        cacheRenderedMath(cacheKey, rendered);
        if (!cancelled) setHtml(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, displayMode, formula]);

  const className = cn(
    'max-w-full align-middle [&_.katex]:text-[1.02em]',
    displayMode && 'my-2 block overflow-x-auto overflow-y-hidden py-1 text-center',
  );

  if (!html || failed) {
    return (
      <span className={cn(className, 'font-mono text-[0.9em]')} data-chat-math-fallback="true">
        {formula}
      </span>
    );
  }

  return (
    <span
      className={className}
      data-chat-math-rendered="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

ChatMath.displayName = 'ChatMath';
