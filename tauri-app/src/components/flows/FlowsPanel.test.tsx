// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowsPanel, applyInternalCompletionStreamUpdate } from './FlowsPanel';
import { ToastProvider } from '../Toast';
import { saveUserFlowSource, USER_FLOW_STORE_KEY } from '../../flows/userFlowStore';
import { USER_FLOW_NODE_REGISTRY_STORE_KEY } from '../../flows/userFlowNodeRegistryStore';
import { TooltipProvider } from '../../../@/components/ui/tooltip';

class MockResizeObserver implements ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: MockResizeObserver,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: MockResizeObserver,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

const renderFlowsPanel = (ui: ReactElement) => render(
  <TooltipProvider>
    <ToastProvider>{ui}</ToastProvider>
  </TooltipProvider>
);

const validYaml = `flow:
  id: single_implementation
  label: Single Implementation
inputs:
  input:
    type: string
nodes:
  - use: core.implementer@1
    as: Implementer
run:
  - set: implementation
    call: Implementer
    parent: root
    args:
      request: input.input`;

const editableYaml = `flow:
  id: editable_flow
  label: Editable Flow
inputs:
  input:
    type: string
nodes:
  - id: Worker
    parent: root
    params:
      request: string
    prompt: Original prompt {{ request }}
run:
  - set: worker
    call: Worker
    parent: root
    args:
      request: input.input`;

describe('FlowsPanel', () => {
  it('appends internal completion deltas without inserting line breaks', () => {
    let output = '';

    output = applyInternalCompletionStreamUpdate(
      output,
      JSON.stringify({ type: 'message_delta', delta: 'flow' }),
      'stdout'
    );
    output = applyInternalCompletionStreamUpdate(
      output,
      JSON.stringify({ type: 'message_delta', delta: ' yaml' }),
      'stdout'
    );
    output = applyInternalCompletionStreamUpdate(
      output,
      JSON.stringify({ type: 'message_delta', delta: '\nrun:' }),
      'stdout'
    );

    expect(output).toBe('flow yaml\nrun:');
  });

  it('merges internal completion snapshots like main agent streaming output', () => {
    const output = applyInternalCompletionStreamUpdate(
      'flow yaml',
      JSON.stringify({ type: 'message_completed', content: 'flow yaml\nrun:' }),
      'stdout'
    );

    expect(output).toBe('flow yaml\nrun:');
  });

  it('shows the predefined flow catalog with inputs, nodes, flow canvas, and source', () => {
    const { container } = renderFlowsPanel(<FlowsPanel />);

    expect(screen.getByRole('heading', { name: 'Parallel Synthesis Review' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Create flow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Draft/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Select a model before drafting a flow.')).toBeTruthy();
    expect(screen.getByText('parallel_review_until_satisfied')).toBeTruthy();
    expect(screen.getByText('global')).toBeTruthy();
    expect(screen.getByText('predefined')).toBeTruthy();
    expect(screen.getByText('version 1')).toBeTruthy();
    expect(screen.getByText('input')).toBeTruthy();
    expect(screen.getByText('count')).toBeTruthy();
    expect(screen.getByText('1 to 5')).toBeTruthy();

    expect(screen.getAllByText('Implementer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Synthesizer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reviewer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Handoff').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fixer').length).toBeGreaterThan(0);
    expect(screen.getByText('uses core.implementer@1')).toBeTruthy();
    expect(screen.getByText('uses core.synthesizer@1')).toBeTruthy();
    expect(screen.getByText('uses core.reviewer@1')).toBeTruthy();
    expect(screen.getByText('uses core.handoff@1')).toBeTruthy();
    expect(screen.getByText('uses core.fixer@1')).toBeTruthy();
    expect(screen.getAllByText('requires commit')).toHaveLength(3);
    expect(screen.queryByText('selected: node')).toBeNull();
    expect(screen.getAllByText('verdict: pass, fail')).toHaveLength(1);

    expect(screen.getByText('Run Shape')).toBeTruthy();
    expect(screen.getByText('Nodes')).toBeTruthy();
    expect(screen.queryByText('Node Templates')).toBeNull();
    expect(screen.getByText('Flow canvas')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand flow canvas' })).toBeTruthy();
    expect(screen.getByText('commit == null')).toBeTruthy();
    expect(screen.getByText('stop: synthesized_implementation_has_no_commit')).toBeTruthy();
    expect(screen.getByText('Loop')).toBeTruthy();
    expect(screen.getByText('max 3 · 6 steps')).toBeTruthy();
    expect(screen.getByText('reviewer.verdict == pass')).toBeTruthy();
    expect(screen.getAllByText('break').length).toBeGreaterThan(0);
    expect(screen.queryByText('parallel Implementers')).toBeNull();
    expect(screen.queryByText('Parallel Implementer (n)')).toBeNull();
    expect(screen.queryByText('set commit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    expect(screen.getAllByText('set commit').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Flow run activity diagram')).toBeNull();
    expect(screen.queryByLabelText('Flow run sequence')).toBeNull();
    expect(screen.getByText(/use: core.implementer@1/)).toBeTruthy();
    expect(screen.getByText(/use: core.synthesizer@1/)).toBeTruthy();
    expect(screen.queryByText('Prompts')).toBeNull();
    expect(screen.queryByText('Compiled node prompts')).toBeNull();
    const nodePromptRows = Array.from(container.querySelectorAll('details[data-flow-node-prompt="true"]'));
    expect(nodePromptRows).toHaveLength(5);
    expect(nodePromptRows.every((row) => !(row as HTMLDetailsElement).open)).toBe(true);
    expect(nodePromptRows[1].querySelector('summary')?.textContent).toContain('Synthesizer');
    expect(screen.getByText(/Please implement:/)).toBeTruthy();
    expect(screen.getByText(/Produce one finalized commit that best satisfies the request/)).toBeTruthy();
    expect(screen.getByText(/You are an Agentree handoff checkpoint/)).toBeTruthy();
  });

  it('shows string errors returned by internal flow authoring', async () => {
    renderFlowsPanel(
      <FlowsPanel
        authoringAgent={{
          complete: async () => {
            throw 'Codex login profile is not ready.';
          },
        }}
      />
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Create a test flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Draft/ }));

    expect(await screen.findByText('Codex login profile is not ready.')).toBeTruthy();
  });

  it('resets the create flow draft and shows a toast after approval', async () => {
    renderFlowsPanel(
      <FlowsPanel
        authoringAgent={{
          complete: async () => validYaml,
        }}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, {
      target: { value: 'Create a single implementation flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Draft/ }));

    expect(await screen.findByText('Single Implementation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    expect(screen.getByText('Flow saved and enabled')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('edits and saves prompts for user flow nodes', async () => {
    saveUserFlowSource({
      id: 'editable_flow',
      label: 'Editable Flow',
      scope: 'global',
      source: editableYaml,
      version: 1,
      enabled: true,
      workspaceId: null,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
    });
    renderFlowsPanel(<FlowsPanel />);

    fireEvent.click(screen.getAllByText('Worker')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Worker prompt' }));
    fireEvent.change(screen.getByLabelText('Worker prompt editor'), {
      target: { value: 'Updated prompt {{ request }}' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('Prompt saved')).toBeTruthy();
    expect(screen.getByText('Updated prompt {{ request }}')).toBeTruthy();
    expect(screen.queryByText('Original prompt {{ request }}')).toBeNull();
  });

  it('resets user flows back to app defaults', async () => {
    saveUserFlowSource({
      id: 'editable_flow',
      label: 'Editable Flow',
      scope: 'global',
      source: editableYaml,
      version: 1,
      enabled: true,
      workspaceId: null,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
    });
    renderFlowsPanel(<FlowsPanel />);

    expect(screen.getByRole('heading', { name: 'Editable Flow' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to app default flows' }));

    expect(screen.getByText('Reset to app default flows')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Editable Flow' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Parallel Synthesis Review' })).toBeTruthy();
  });

  it('keeps reset available when stored user flow artifacts are corrupt', () => {
    window.localStorage.setItem(USER_FLOW_STORE_KEY, '{"sources":[\u0000');
    window.localStorage.setItem(USER_FLOW_NODE_REGISTRY_STORE_KEY, '{"definitions":[\u0000');
    renderFlowsPanel(<FlowsPanel />);

    const reset = screen.getByRole('button', { name: 'Reset to app default flows' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);

    expect(window.localStorage.getItem(USER_FLOW_STORE_KEY)).toBeNull();
    expect(window.localStorage.getItem(USER_FLOW_NODE_REGISTRY_STORE_KEY)).toBeNull();
    expect(screen.getByText('Reset to app default flows')).toBeTruthy();
  });
});
