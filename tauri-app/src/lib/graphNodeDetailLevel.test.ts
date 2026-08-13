import { describe, expect, it } from 'vitest';
import {
  getGraphNodeDetailDensityCount,
  getGraphNodeDetailEffectiveZoom,
  getGraphNodeDetailLevel,
  getGraphNodeDetailZoomBucket,
  shouldEnableGraphNodeHover,
} from './graphNodeDetailLevel';

describe('graph node detail level', () => {
  it('keeps interactive anchor nodes full detail even in dense or zoomed-out views', () => {
    expect(getGraphNodeDetailLevel({ zoom: 0.1, renderedNodeCount: 500, isFocused: true })).toBe('full');
    expect(getGraphNodeDetailLevel({ zoom: 0.1, renderedNodeCount: 500, isSelected: true })).toBe('full');
    expect(getGraphNodeDetailLevel({ zoom: 0.1, renderedNodeCount: 500, isComposerBaseCommit: true })).toBe('full');
  });

  it('drops detail as the viewport zooms out or the mid-zoom view contains many rendered nodes', () => {
    expect(getGraphNodeDetailLevel({ zoom: 0.8, renderedNodeCount: 40 })).toBe('full');
    expect(getGraphNodeDetailLevel({ zoom: 0.38, renderedNodeCount: 40 })).toBe('compact');
    expect(getGraphNodeDetailLevel({ zoom: 0.38, renderedNodeCount: 110 })).toBe('compact');
    expect(getGraphNodeDetailLevel({ zoom: 0.25, renderedNodeCount: 40 })).toBe('minimal');
    expect(getGraphNodeDetailLevel({ zoom: 0.38, renderedNodeCount: 200 })).toBe('minimal');
  });

  it('restores full detail in the zoomed-in reading bucket even for large graphs', () => {
    expect(getGraphNodeDetailLevel({ zoom: 0.4, renderedNodeCount: 600 })).toBe('full');
  });

  it('uses visible viewport density when available instead of total graph size', () => {
    expect(getGraphNodeDetailDensityCount({ renderedNodeCount: 500, visibleNodeCount: 20 })).toBe(20);
    expect(getGraphNodeDetailLevel({
      zoom: 0.8,
      renderedNodeCount: getGraphNodeDetailDensityCount({ renderedNodeCount: 500, visibleNodeCount: 20 }),
    })).toBe('full');
    expect(getGraphNodeDetailDensityCount({ renderedNodeCount: 500, visibleNodeCount: 0 })).toBe(500);
    expect(getGraphNodeDetailDensityCount({ renderedNodeCount: 500, visibleNodeCount: null })).toBe(500);
  });

  it('keeps hover cards available at every detail level', () => {
    expect(shouldEnableGraphNodeHover({ detailLevel: 'full' })).toBe(true);
    expect(shouldEnableGraphNodeHover({ detailLevel: 'compact' })).toBe(true);
    expect(shouldEnableGraphNodeHover({ detailLevel: 'minimal' })).toBe(true);
    expect(shouldEnableGraphNodeHover({ detailLevel: 'minimal', isFocused: true })).toBe(true);
    expect(shouldEnableGraphNodeHover({ detailLevel: 'compact', isSelected: true })).toBe(true);
  });

  it('groups zoom into coarse buckets so tiny zoom changes do not alter card detail', () => {
    expect(getGraphNodeDetailZoomBucket(0.19)).toBe('overview');
    expect(getGraphNodeDetailZoomBucket(0.24)).toBe('overview');
    expect(getGraphNodeDetailZoomBucket(0.31)).toBe('mid');
    expect(getGraphNodeDetailZoomBucket(0.39)).toBe('mid');
    expect(getGraphNodeDetailZoomBucket(0.4)).toBe('reading');
    expect(getGraphNodeDetailZoomBucket(1.2)).toBe('reading');
  });

  it('keeps offscreen nodes cheap even when the settled viewport is zoomed in', () => {
    expect(getGraphNodeDetailEffectiveZoom({ bucket: 'reading', isInDetailViewport: true })).toBe(1);
    expect(getGraphNodeDetailEffectiveZoom({ bucket: 'reading', isInDetailViewport: false })).toBe(0.2);
  });
});
