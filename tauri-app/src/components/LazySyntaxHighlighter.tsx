import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface LazySyntaxHighlighterProps {
  language: string | undefined;
  code: string;
}

export default function LazySyntaxHighlighter({ language, code }: LazySyntaxHighlighterProps) {
  return (
    <SyntaxHighlighter
      style={vscDarkPlus}
      language={language}
      PreTag="pre"
      className="code-block !p-3 !m-0 text-sm !bg-transparent"
      showLineNumbers={false}
      wrapLongLines={true}
      customStyle={{ background: 'transparent', overflowX: 'auto', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}
      codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' } }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
