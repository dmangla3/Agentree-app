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
    render(<FlowsPanel />);

    expect(screen.getByRole('heading', { name: 'Parallel Review Until Satisfied' })).toBeTruthy();
    expect(screen.getByText('parallel_review_until_satisfied')).toBeTruthy();
    expect(screen.getByText('global')).toBeTruthy();
    expect(screen.getByText('input')).toBeTruthy();
    expect(screen.getByText('count')).toBeTruthy();
    expect(screen.getByText('1 to 5')).toBeTruthy();

    expect(screen.getByText('Implementer')).toBeTruthy();
    expect(screen.getByText('Judge')).toBeTruthy();
    expect(screen.getByText('Reviewer')).toBeTruthy();
    expect(screen.getByText('Fixer')).toBeTruthy();
    expect(screen.getByText('uses core.implementer@1')).toBeTruthy();
    expect(screen.getByText('uses core.selector@1')).toBeTruthy();
    expect(screen.getByText('uses core.reviewer@1')).toBeTruthy();
    expect(screen.getByText('uses core.fixer@1')).toBeTruthy();
    expect(screen.getAllByText('requires commit')).toHaveLength(2);
    expect(screen.getByText('selected: node')).toBeTruthy();
    expect(screen.getAllByText('verdict: pass, fail').length).toBeGreaterThan(0);

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
    expect(diagram.textContent).toContain('implementer1 --> judge');
    expect(diagram.textContent).toContain('implementer2 --> judge');
    expect(diagram.textContent).toContain('implementer3 --> judge');
    expect(diagram.textContent).not.toContain('parallel Implementers');
    expect(diagram.textContent).not.toContain('Parallel Implementer (n)');
    expect(diagram.textContent).toContain('Judge');
    expect(diagram.textContent).toContain('Reviewer');
    expect(diagram.textContent).toContain('Fixer');
    expect(diagram.textContent).toContain('fixer --> reviewer');
    expect(diagram.textContent).toContain('reviewer -->|pass| done');
    expect(diagram.textContent).not.toContain('if commit == null');
    expect(diagram.textContent).not.toContain('selected_implementation_has_no_commit');
    expect(diagram.textContent).not.toContain('set commit');
    expect(screen.queryByLabelText('Flow run sequence')).toBeNull();
    expect(screen.getByText(/use: core.implementer@1/)).toBeTruthy();
    expect(screen.getByText(/selected: <one candidate node>/)).toBeTruthy();
  });
});
