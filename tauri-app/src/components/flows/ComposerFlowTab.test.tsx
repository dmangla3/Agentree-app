// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRuntimeModelKey } from '../../lib/runtimeModels';
import { ComposerFlowTab } from './ComposerFlowTab';

const flows = [{ id: 'parallel_review_until_satisfied', label: 'Parallel Review Until Satisfied' }];

afterEach(() => cleanup());

describe('ComposerFlowTab', () => {
  it('lists the predefined flow and clamps count to 1..5', async () => {
    render(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId="workspace-1"
        selectedAgentId="agent-1"
        isRunning={false}
        events={[]}
        onRunFlow={vi.fn()}
      />
    );

    expect(screen.getByText('Parallel Review Until Satisfied')).toBeTruthy();
    const countInput = screen.getByLabelText('Parallel count') as HTMLInputElement;
    fireEvent.change(countInput, { target: { value: '9' } });
    expect(countInput.value).toBe('5');
    fireEvent.change(countInput, { target: { value: '0' } });
    expect(countInput.value).toBe('1');

    await userEvent.click(screen.getByLabelText('Increase flow count'));
    expect(countInput.value).toBe('2');
  });

  it('renders the supplied model selector in the flow controls', () => {
    render(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId="workspace-1"
        selectedAgentId="agent-1"
        isRunning={false}
        events={[]}
        modelSelector={<button type="button">GPT-5.5 High</button>}
        onRunFlow={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'GPT-5.5 High' })).toBeTruthy();
  });

  it('keeps the product default model at GPT-5.5 high', () => {
    expect(defaultRuntimeModelKey).toBe('codex:gpt-5.5:high');
  });

  it('disables run when prompt, workspace, or selected agent is missing', () => {
    const { rerender } = render(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt=""
        workspaceId="workspace-1"
        selectedAgentId="agent-1"
        isRunning={false}
        events={[]}
        onRunFlow={vi.fn()}
      />
    );
    expect((screen.getByRole('button', { name: 'Run Flow' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId={null}
        selectedAgentId="agent-1"
        isRunning={false}
        events={[]}
        onRunFlow={vi.fn()}
      />
    );
    expect((screen.getByRole('button', { name: 'Run Flow' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId="workspace-1"
        selectedAgentId={null}
        isRunning={false}
        events={[]}
        onRunFlow={vi.fn()}
      />
    );
    expect((screen.getByRole('button', { name: 'Run Flow' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs the selected flow with prompt and count', async () => {
    const onRunFlow = vi.fn();
    render(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId="workspace-1"
        selectedAgentId="agent-1"
        isRunning={false}
        events={[]}
        onRunFlow={onRunFlow}
      />
    );

    fireEvent.change(screen.getByLabelText('Parallel count'), { target: { value: '4' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Flow' }));

    expect(onRunFlow).toHaveBeenCalledWith({ input: 'Implement something', count: 4 });
  });

  it('shows stopped flow reasons in the progress area', () => {
    render(
      <ComposerFlowTab
        flows={flows}
        selectedFlowId="parallel_review_until_satisfied"
        onSelectFlow={() => undefined}
        prompt="Implement something"
        workspaceId="workspace-1"
        selectedAgentId="agent-1"
        isRunning={false}
        events={[{
          type: 'flow_stopped',
          message: 'Missing declared return "selected".',
        }]}
        onRunFlow={vi.fn()}
      />
    );

    expect(screen.getAllByText('Missing declared return "selected".')).toHaveLength(2);
  });
});
