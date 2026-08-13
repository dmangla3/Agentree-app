export type GraphNodeDetailLevel = 'full' | 'compact' | 'minimal';
export type GraphNodeDetailZoomBucket = 'overview' | 'mid' | 'reading';

interface GraphNodeDetailInput {
  zoom: number;
  renderedNodeCount: number;
  isFocused?: boolean;
  isSelected?: boolean;
  isComposerBaseCommit?: boolean;
}

interface GraphNodeHoverInput {
  detailLevel: GraphNodeDetailLevel;
  isFocused?: boolean;
  isSelected?: boolean;
  isComposerBaseCommit?: boolean;
}

interface GraphNodeDetailDensityInput {
  renderedNodeCount: number;
  visibleNodeCount?: number | null;
}

export const getGraphNodeDetailDensityCount = ({
  renderedNodeCount,
  visibleNodeCount,
}: GraphNodeDetailDensityInput): number => {
  if (typeof visibleNodeCount === 'number' && Number.isFinite(visibleNodeCount) && visibleNodeCount > 0) {
    return visibleNodeCount;
  }
  return renderedNodeCount;
};

export const getGraphNodeDetailZoomBucket = (zoom: number): GraphNodeDetailZoomBucket => {
  if (!Number.isFinite(zoom) || zoom < 0.3) return 'overview';
  if (zoom < 0.4) return 'mid';
  return 'reading';
};

export const getGraphNodeDetailZoomForBucket = (bucket: GraphNodeDetailZoomBucket): number => {
  if (bucket === 'overview') return 0.2;
  if (bucket === 'mid') return 0.45;
  return 1;
};

export const getGraphNodeDetailEffectiveZoom = ({
  bucket,
  isInDetailViewport,
}: {
  bucket: GraphNodeDetailZoomBucket;
  isInDetailViewport: boolean;
}): number => (
  isInDetailViewport
    ? getGraphNodeDetailZoomForBucket(bucket)
    : getGraphNodeDetailZoomForBucket('overview')
);

export const getGraphNodeDetailLevel = ({
  zoom,
  renderedNodeCount,
  isFocused = false,
  isSelected = false,
  isComposerBaseCommit = false,
}: GraphNodeDetailInput): GraphNodeDetailLevel => {
  if (isFocused || isSelected || isComposerBaseCommit) return 'full';

  if (zoom >= 0.4) return 'full';
  if (zoom < 0.3 || renderedNodeCount >= 180) return 'minimal';
  if (zoom < 0.4 || renderedNodeCount >= 96) return 'compact';

  return 'full';
};

export const shouldEnableGraphNodeHover = ({
  detailLevel: _detailLevel,
  isFocused: _isFocused = false,
  isSelected: _isSelected = false,
  isComposerBaseCommit: _isComposerBaseCommit = false,
}: GraphNodeHoverInput): boolean => true;
