// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowsPanel } from './FlowsPanel';

vi.mock('../MermaidDiagram', () => ({
  default: ({ chart }: { chart: string }) => (
    <pre>{chart}</pre>
  ),
}));

afterEach(() => cleanup());

describe('FlowsPanel', () => {
  it('shows the predefined flow catalog with inputs, nodes, activity diagram, and source', () => {
    const { container } = render(<FlowsPanel />);

    expect(screen.getByRole('heading', { name: 'Parallel Synthesis Review' })).toBeTruthy();
    expect(screen.getByText('parallel_review_until_satisfied')).toBeTruthy();
    expect(screen.getByText('global')).toBeTruthy();
    expect(screen.getByText('input')).toBeTruthy();
    expect(screen.getByText('count')).toBeTruthy();
    expect(screen.getByText('1 to 5')).toBeTruthy();

    expect(screen.getAllByText('Implementer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Synthesizer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reviewer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fixer').length).toBeGreaterThan(0);
    expect(screen.getByText('uses core.implementer@1')).toBeTruthy();
    expect(screen.getByText('uses core.synthesizer@1')).toBeTruthy();
    expect(screen.getByText('uses core.reviewer@1')).toBeTruthy();
    expect(screen.getByText('uses core.fixer@1')).toBeTruthy();
    expect(screen.getAllByText('requires commit')).toHaveLength(3);
    expect(screen.queryByText('selected: node')).toBeNull();
    expect(screen.getAllByText('verdict: pass, fail')).toHaveLength(1);

    expect(screen.getByText('Run Shape')).toBeTruthy();
    expect(screen.getByText('Nodes')).toBeTruthy();
    expect(screen.queryByText('Node Templates')).toBeNull();
    const diagram = screen.getByLabelText('Flow run activity diagram');
    expect(diagram.textContent).toContain('flowchart LR');
    expect(diagram.textContent).toContain('subgraph implementers["parallel"]');
    expect(diagram.textContent).toContain('implementer1["Implementer 1"]');
    expect(diagram.textContent).toContain('implementer2["Implementer 2"]');
    expect(diagram.textContent).toContain('implementer3["Implementer 3"]');
    expect(diagram.textContent).toContain('start --> implementer1');
    expect(diagram.textContent).toContain('start --> implementer2');
    expect(diagram.textContent).toContain('start --> implementer3');
    expect(diagram.textContent).toContain('implementer1 --> synthesizer');
    expect(diagram.textContent).toContain('implementer2 --> synthesizer');
    expect(diagram.textContent).toContain('implementer3 --> synthesizer');
    expect(diagram.textContent).not.toContain('parallel Implementers');
    expect(diagram.textContent).not.toContain('Parallel Implementer (n)');
    expect(diagram.textContent).toContain('Synthesizer');
    expect(diagram.textContent).toContain('Reviewer');
    expect(diagram.textContent).toContain('Fixer');
    expect(diagram.textContent).toContain('fixer --> reviewer');
    expect(diagram.textContent).toContain('reviewer -->|pass| done');
    expect(diagram.textContent).not.toContain('if commit == null');
    expect(diagram.textContent).not.toContain('synthesized_implementation_has_no_commit');
    expect(diagram.textContent).not.toContain('set commit');
    expect(screen.queryByLabelText('Flow run sequence')).toBeNull();
    expect(screen.getByText(/use: core.implementer@1/)).toBeTruthy();
    expect(screen.getByText(/use: core.synthesizer@1/)).toBeTruthy();
    expect(screen.queryByText('Prompts')).toBeNull();
    expect(screen.queryByText('Compiled node prompts')).toBeNull();
    const nodePromptRows = Array.from(container.querySelectorAll('details[data-flow-node-prompt="true"]'));
    expect(nodePromptRows).toHaveLength(4);
    expect(nodePromptRows.every((row) => !(row as HTMLDetailsElement).open)).toBe(true);
    expect(nodePromptRows[1].querySelector('summary')?.textContent).toContain('Synthesizer');
    expect(screen.getByText(/Please implement:/)).toBeTruthy();
    expect(screen.getByText(/Produce one finalized implementation commit/)).toBeTruthy();
  });
});
