import { useEffect, useMemo, useRef } from 'react';

// Optional: Configure Mermaid defaults once
// try {
//   mermaid.initialize({
//     startOnLoad: false, // We'll trigger it manually
//     theme: 'neutral', // Or 'default', 'dark', 'forest'
//     // securityLevel: 'loose', // If needed, be careful with this
//   });
// } catch (e) {
//   console.error("Failed to initialize Mermaid", e);
// }

interface MermaidDiagramProps {
  chart: string; // The raw Mermaid code
}

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart }) => {
  const mermaidRef = useRef<HTMLPreElement>(null);
  // Generate a unique ID for each diagram container to avoid conflicts
  const chartId = useMemo(() => `mermaid-chart-${Math.random().toString(36).substring(2, 15)}`, []);


  useEffect(() => {
    let isMounted = true;
    const renderDiagram = async () => {
      const { default: mermaid } = await import('mermaid');
      // Initialize Mermaid here if not done globally
      try {
           mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
      } catch (e) {
          console.error("Failed to initialize Mermaid", e);
      }

    if (mermaidRef.current && chart) {
        // Attempt to render the diagram
        try {
            // Use mermaid.render to get SVG code directly
            mermaid.render(chartId, chart).then(({ svg }) => {
                if (isMounted && mermaidRef.current) {
                    // Ensure the ref is still valid before setting innerHTML
                    mermaidRef.current.innerHTML = svg;
                }
            }).catch((err) => {
                console.error('Mermaid render error:', err);
                if (isMounted && mermaidRef.current) {
                    mermaidRef.current.innerHTML = `<p style="color: red;">Error rendering diagram.</p>`;
                }
            });

             // Deprecated approach: mermaid.run() might be simpler but less controlled
             // mermaidRef.current.innerHTML = chart; // Put raw code in first
             // mermaid.run({ nodes: [mermaidRef.current] });

        } catch (error) {
            console.error('Mermaid rendering failed:', error);
            // Optionally display an error message in the ref
            if (isMounted && mermaidRef.current) {
                mermaidRef.current.innerHTML = `<p style="color: red;">Error rendering diagram.</p>`;
            }
        }
    }
    };

    void renderDiagram();

    // Cleanup function (optional, might not be necessary with render)
    return () => {
      isMounted = false;
      if (mermaidRef.current) {
         mermaidRef.current.innerHTML = '';
      }
    };

  }, [chart, chartId]); // Re-run if the chart content changes

  // Render a pre tag for Mermaid to target.
  // Using a key forces React to re-mount if chart content changes drastically,
  // helping Mermaid re-render correctly.
  return (
    <pre
      ref={mermaidRef}
      key={chart} // Force re-render on chart change
      className="mermaid" // Mermaid library might look for this class
      // Initial content is empty or the raw code, Mermaid populates it via JS
      // style={{ lineHeight: 'initial' }} // Reset line height if needed
    >
      {/* Initial placeholder or raw chart code - Mermaid will replace this */}
      {/* {chart} */}
    </pre>
  );
};

export default MermaidDiagram;
