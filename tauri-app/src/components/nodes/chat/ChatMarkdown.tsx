import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { cn } from '../../../lib/utils';

const chatMarkdownPlugins = [remarkGfm, remarkBreaks];

export const chatMarkdownComponents = {
  code: (props: any) => {
    const { inline, className: codeClassName, children, ...rest } = props;
    const match = /language-(\w+)/.exec(codeClassName || '');
    const codeContent = String(children).replace(/\n$/, '');

    if (!inline && match) {
      return (
        <pre className="my-1.5 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border border-border/60 bg-muted/25 p-3 text-xs leading-relaxed">
          <code className="font-mono" {...rest}>
            {codeContent}
          </code>
        </pre>
      );
    }

    return (
      <code
        className={cn(
          "rounded-sm bg-muted/50 px-1 py-0.5 text-[0.9em] font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
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
      className="my-1.5 min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-transparent"
      {...props}
    />
  ),
  p: (props: any) => <p className="mb-1 min-w-0 max-w-full break-words [overflow-wrap:anywhere] last:mb-0" {...props} />,
  a: (props: any) => (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary hover:underline"
      {...props}
    />
  ),
  blockquote: (props: any) => (
    <blockquote className="my-1.5 min-w-0 max-w-full break-words [overflow-wrap:anywhere] border-l-2 border-border pl-3 italic" {...props} />
  ),
  ul: (props: any) => <ul className="my-1.5 min-w-0 max-w-full list-inside list-disc space-y-1 pl-2" {...props} />,
  ol: (props: any) => <ol className="my-1.5 min-w-0 max-w-full list-inside list-decimal space-y-1 pl-2" {...props} />,
  li: (props: any) => <li className="min-w-0 max-w-full break-words [overflow-wrap:anywhere] pl-1" {...props} />,
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

export const ChatMarkdown = memo(function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={chatMarkdownPlugins} components={chatMarkdownComponents}>
      {children}
    </ReactMarkdown>
  );
});

ChatMarkdown.displayName = 'ChatMarkdown';
