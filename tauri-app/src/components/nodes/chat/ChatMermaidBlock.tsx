import { memo, useEffect, useMemo, useState } from 'react';

let mermaidInitPromise: Promise<typeof import('mermaid').default> | null = null;

const loadMermaid = async () => {
  if (!mermaidInitPromise) {
    mermaidInitPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
      });
      return mermaid;
    });
  }
  return mermaidInitPromise;
};

interface ChatMermaidBlockProps {
  chart: string;
}

export const ChatMermaidBlock = memo(function ChatMermaidBlock({ chart }: ChatMermaidBlockProps) {
  const chartId = useMemo(() => `chat-mermaid-${Math.random().toString(36).slice(2)}`, []);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    loadMermaid()
      .then((mermaid) => mermaid.render(chartId, chart))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [chart, chartId]);

  if (failed) {
    return (
      <pre className="my-2 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border border-border/60 bg-muted/25 p-3 text-xs leading-[1.55]">
        <code className="font-mono">{chart}</code>
      </pre>
    );
  }

  return (
    <div className="my-2 min-w-0 max-w-full overflow-x-auto rounded-md border border-border/60 bg-background/70 p-3">
      {svg ? (
        <div
          className="min-w-fit [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="text-xs text-muted-foreground">Rendering diagram...</div>
      )}
    </div>
  );
});
