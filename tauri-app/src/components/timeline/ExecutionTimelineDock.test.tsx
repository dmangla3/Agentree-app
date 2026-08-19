// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceProjection } from '../../domain/workspaceProjection';
import type { Message } from '../../stores/workspaceStore';
import { buildExecutionTimelineItems, packExecutionTimelineItems } from '../../lib/executionTimelineModel';
import { ExecutionTimelineDock } from './ExecutionTimelineDock';
import { resolveExecutionTimelineHoverEntity } from './ExecutionTimelineHoverCard';

vi.mock('../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({ entity }: { entity?: { kind?: string } }) => (
    <div>hover card: {entity?.kind}</div>
  ),
}));

const workspaceId = 'workspace-execution-timeline-dock';
const baseMs = Date.parse('2026-05-26T10:00:00.000Z');
const isoAt = (seconds: number) => new Date(baseMs + seconds * 1000).toISOString();

const makeMessage = (
  input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parentId'>,
  seconds: number,
): Message => ({
  id: input.id,
  role: input.role,
  content: input.content ?? `${input.role} ${input.id}`,
  parentId: input.parentId,
  workspaceId,
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  aiLabel: input.aiLabel ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  createdAt: input.createdAt ?? isoAt(seconds),
  updatedAt: input.updatedAt ?? isoAt(seconds),
});

const buildFixture = () => {
  const messages = [
    makeMessage({ id: 'user-1', role: 'user', parentId: null, content: 'Start work' }, 0),
    makeMessage({
      id: 'assistant-1',
      role: 'assistant',
      parentId: 'user-1',
      aiLabel: 'First run',
      content: 'First agent run',
      status: 'completed',
      agent_id: 'agent-1',
      execution_data: { started_at: isoAt(1), ended_at: isoAt(6) },
    }, 1),
    makeMessage({ id: 'user-2', role: 'user', parentId: 'assistant-1', content: 'Continue work' }, 8),
    makeMessage({
      id: 'assistant-2',
      role: 'assistant',
      parentId: 'user-2',
      aiLabel: 'Latest run',
      content: 'Latest agent run',
      status: 'completed',
      agent_id: 'agent-1',
      output_commit_sha: 'commit22222222',
      execution_data: {
        started_at: isoAt(3600),
        ended_at: isoAt(3900),
        meta: { commit_message: 'Ship latest run' },
      },
    }, 3600),
  ];
  const projection = buildWorkspaceProjection({
    messages,
    summaries: [],
    commits: [{
      sha: 'commit22222222',
      subject: 'Ship latest run',
      authored_at: isoAt(3910),
      source_kind: 'agent',
      produced_by_node_id: 'assistant-2',
    }],
    focusedMessageId: 'assistant-2',
  });
  const items = buildExecutionTimelineItems(projection, baseMs + 4000 * 1000);
  return {
    projection,
    model: packExecutionTimelineItems(items),
  };
};

const buildOverlappingFixture = () => {
  const messages = [
    makeMessage({ id: 'user-overlap', role: 'user', parentId: null, content: 'Start overlap' }, 0),
    makeMessage({
      id: 'assistant-lane-0',
      role: 'assistant',
      parentId: 'user-overlap',
      aiLabel: 'Lane zero run',
      content: 'Lane zero run',
      status: 'completed',
      agent_id: 'agent-1',
      execution_data: { started_at: isoAt(250), ended_at: isoAt(399) },
    }, 250),
    makeMessage({
      id: 'assistant-lane-1',
      role: 'assistant',
      parentId: 'user-overlap',
      aiLabel: 'Lane one run',
      content: 'Lane one run',
      status: 'completed',
      agent_id: 'agent-2',
      execution_data: { started_at: isoAt(320), ended_at: isoAt(390) },
    }, 320),
  ];
  const projection = buildWorkspaceProjection({
    messages,
    summaries: [],
    commits: [],
    focusedMessageId: 'assistant-lane-0',
  });
  const items = buildExecutionTimelineItems(projection, baseMs + 400 * 1000);
  return {
    projection,
    model: packExecutionTimelineItems(items),
  };
};

const renderDock = (overrides: Partial<React.ComponentProps<typeof ExecutionTimelineDock>> = {}) => {
  const fixture = buildFixture();
  const props: React.ComponentProps<typeof ExecutionTimelineDock> = {
    projection: fixture.projection,
    model: fixture.model,
    focusedMessageId: 'assistant-2',
    selectedNodeIds: new Set<string>(),
    onFocusMessage: vi.fn(),
    onSelectMessage: vi.fn(),
    onContextMenuMessage: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<ExecutionTimelineDock {...props} />),
    props,
  };
};

describe('ExecutionTimelineDock', () => {
  it('renders counts, timezone, and a latest-region viewport on mount', () => {
    renderDock();

    expect(screen.getByText('Execution timeline')).toBeTruthy();
    expect(screen.getByText(/2 runs/)).toBeTruthy();
    expect(screen.getByText(/2 prompts/)).toBeTruthy();
    expect(screen.getByText(/1 commit/)).toBeTruthy();

    const viewport = screen.getByTestId('execution-timeline-viewport');
    expect(Number(viewport.getAttribute('data-end-ms'))).toBe(baseMs + 3910 * 1000);
    expect(Number(viewport.getAttribute('data-start-ms'))).toBeGreaterThan(baseMs);
  });

  it('renders a time ruler and visible idle break bands', () => {
    renderDock();

    const minimap = screen.getByTestId('execution-timeline-minimap');
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(minimap, { clientX: 300, pointerId: 8, button: 0 });

    expect(screen.getByTestId('execution-timeline-ruler')).toBeTruthy();
    expect(screen.getAllByTestId('execution-timeline-ruler-tick').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('execution-timeline-break').length).toBeGreaterThan(0);
    expect(screen.getByText(/idle/)).toBeTruthy();
  });

  it('leaves the viewport unchanged when the detailed timeline background is pressed without dragging', () => {
    renderDock();

    const detail = screen.getByTestId('execution-timeline-detail');
    const viewport = screen.getByTestId('execution-timeline-viewport');
    const initialStart = viewport.getAttribute('data-start-ms');
    const initialEnd = viewport.getAttribute('data-end-ms');
    vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 180,
      right: 1000,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(detail, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerUp(window, { clientX: 500, pointerId: 1 });

    expect(viewport.getAttribute('data-start-ms')).toBe(initialStart);
    expect(viewport.getAttribute('data-end-ms')).toBe(initialEnd);
  });

  it('pans the detailed viewport when the detailed timeline background is dragged', () => {
    renderDock();

    const detail = screen.getByTestId('execution-timeline-detail');
    const viewport = screen.getByTestId('execution-timeline-viewport');
    const initialStart = Number(viewport.getAttribute('data-start-ms'));
    vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 180,
      right: 1000,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(detail, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: 650, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 650, pointerId: 1 });

    expect(Number(viewport.getAttribute('data-start-ms'))).toBeLessThan(initialStart);
  });

  it('focuses on normal item click and toggles selection on modified click', () => {
    const onFocusMessage = vi.fn();
    const onSelectMessage = vi.fn();
    renderDock({ onFocusMessage, onSelectMessage });

    fireEvent.click(screen.getByRole('button', { name: /Latest run/ }));
    fireEvent.click(screen.getByRole('button', { name: /Ship latest run/ }), { metaKey: true });

    expect(onFocusMessage).toHaveBeenCalledWith('assistant-2');
    expect(onSelectMessage).toHaveBeenCalledWith('assistant-2', true);
  });

  it('resolves generated commit markers to commit hover content instead of the owner message', () => {
    const fixture = buildFixture();
    const commitMarker = fixture.model.markers.find((marker) => marker.kind === 'commit');

    expect(commitMarker).toBeTruthy();
    const entity = resolveExecutionTimelineHoverEntity(fixture.projection, commitMarker!);

    expect(entity?.kind).toBe('commit_message');
    expect(entity?.messageId).toBe('commit:commit22222222:hover');
    expect(entity?.messageId).not.toBe('assistant-2');
  });

  it('renders lane zero below higher overlapping lanes', () => {
    const fixture = buildOverlappingFixture();
    renderDock({
      projection: fixture.projection,
      model: fixture.model,
      focusedMessageId: 'assistant-lane-0',
    });

    const laneZeroTop = Number.parseFloat(screen.getByRole('button', { name: /Lane zero run/ }).style.top);
    const laneOneTop = Number.parseFloat(screen.getByRole('button', { name: /Lane one run/ }).style.top);

    expect(laneZeroTop).toBeGreaterThan(laneOneTop);
    expect(laneOneTop).toBeCloseTo(55, 1);
    expect(laneZeroTop).toBeCloseTo(89, 1);
    expect(screen.getByRole('button', { name: /Lane zero run/ }).style.height).toBe('28px');
  });

  it('renders contextual relation connectors only while an item is hovered', () => {
    renderDock();

    expect(screen.queryByTestId('execution-timeline-connectors')).toBeNull();

    fireEvent.pointerEnter(screen.getByRole('button', { name: /Latest run/ }));

    expect(screen.getByTestId('execution-timeline-connectors').querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('pans the detailed viewport when the minimap brush is dragged', () => {
    renderDock();

    const viewport = screen.getByTestId('execution-timeline-viewport');
    const initialStart = Number(viewport.getAttribute('data-start-ms'));
    const minimap = screen.getByTestId('execution-timeline-minimap');
    const brush = screen.getByTestId('execution-timeline-brush');
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(brush, { clientX: 400, pointerId: 2, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 300, pointerId: 2 });

    expect(Number(viewport.getAttribute('data-start-ms'))).toBeLessThan(initialStart);
  });

  it('centers the detailed viewport when the minimap background is clicked', () => {
    renderDock();

    const viewport = screen.getByTestId('execution-timeline-viewport');
    const initialStart = Number(viewport.getAttribute('data-start-ms'));
    const minimap = screen.getByTestId('execution-timeline-minimap');
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(minimap, { clientX: 0, pointerId: 3, button: 0 });

    expect(Number(viewport.getAttribute('data-start-ms'))).toBeLessThan(initialStart);
  });

  it('keeps the minimap brush bounded and preserves its display span on minimap click', () => {
    renderDock();

    const brush = screen.getByTestId('execution-timeline-brush');
    const minimap = screen.getByTestId('execution-timeline-minimap');
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const initialDisplaySpan = brush.getAttribute('data-display-span-pct');

    fireEvent.pointerDown(minimap, { clientX: 40, pointerId: 4, button: 0 });

    expect(brush.style.left).toMatch(/%$/);
    expect(brush.style.right).toMatch(/%$/);
    expect(brush.style.width).toBe('');
    expect(brush.getAttribute('data-display-span-pct')).toBe(initialDisplaySpan);
  });

  it('exposes distinct resize handles on the minimap brush', () => {
    renderDock();

    expect(screen.getByTestId('execution-timeline-brush').className).toContain('cursor-grab');
    expect(screen.getByTestId('execution-timeline-brush-left-handle').className).toContain('cursor-ew-resize');
    expect(screen.getByTestId('execution-timeline-brush-right-handle').className).toContain('cursor-ew-resize');
  });

  it('limits the minimap domain through the range selector', () => {
    renderDock();

    const brush = screen.getByTestId('execution-timeline-brush');
    const initialSpanPct = Number(brush.getAttribute('data-display-span-pct'));

    fireEvent.pointerDown(screen.getByRole('button', { name: /Timeline range:/ }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByText('Last 3 hours'));

    const viewport = screen.getByTestId('execution-timeline-viewport');
    expect(screen.getByRole('button', { name: /Timeline range: Last 3 hours/ })).toBeTruthy();
    expect(Number(viewport.getAttribute('data-end-ms')) - Number(viewport.getAttribute('data-start-ms'))).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
    expect(Number(brush.getAttribute('data-display-span-pct'))).toBeLessThanOrEqual(30);
    expect(Number(brush.getAttribute('data-display-span-pct'))).toBeCloseTo(initialSpanPct, 0);
  });

  it('caps viewport size at thirty percent when the brush is resized', () => {
    renderDock();

    const minimap = screen.getByTestId('execution-timeline-minimap');
    const rightHandle = screen.getByTestId('execution-timeline-brush-right-handle');
    const brush = screen.getByTestId('execution-timeline-brush');
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(rightHandle, { clientX: 100, pointerId: 5, button: 0 });
    fireEvent.pointerMove(window, { clientX: 980, pointerId: 5 });
    fireEvent.pointerUp(window, { clientX: 980, pointerId: 5 });

    expect(Number(brush.getAttribute('data-display-span-pct'))).toBeLessThanOrEqual(30);
  });

  it('keeps the remembered viewport percentage when remounted', () => {
    const first = renderDock();
    const initialSpan = screen.getByTestId('execution-timeline-brush').getAttribute('data-display-span-pct');

    first.unmount();
    renderDock();

    expect(screen.getByTestId('execution-timeline-brush').getAttribute('data-display-span-pct')).toBe(initialSpan);
  });

  it('filters timeline items to the current thread through the segmented scope control', () => {
    const fixture = buildOverlappingFixture();
    renderDock({
      projection: fixture.projection,
      model: fixture.model,
      currentThreadRootId: 'user-overlap',
      threadRootIdByMessageId: new Map([
        ['assistant-lane-0', 'user-overlap'],
        ['assistant-lane-1', 'other-thread'],
      ]),
    });

    expect(screen.getByRole('button', { name: /Lane zero run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lane one run/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'This thread' }));

    expect(screen.getByRole('button', { name: /Lane zero run/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lane one run/ })).toBeNull();
  });
});
