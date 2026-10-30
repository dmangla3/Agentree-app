export const DESIGN_REVIEW_NAVIGATION_EVENT = 'agentree:open-design-review-surface';

export type DesignReviewSurfaceId =
  | 'auth'
  | 'onboarding'
  | 'shell'
  | 'navigation'
  | 'graph'
  | 'chat'
  | 'nodes'
  | 'panels'
  | 'controls';

export type DesignReviewVersion = 'before' | 'after';

export type DesignReviewNavigationDetail = {
  surface: DesignReviewSurfaceId;
  version?: DesignReviewVersion;
};

export function createDesignReviewLocation(
  surface: DesignReviewSurfaceId,
  currentPathname: string,
  currentSearch: string,
  runToken: string,
) {
  if (surface === 'auth') {
    return `/login?designReview=auth&designReviewRun=${encodeURIComponent(runToken)}`;
  }

  const mainPath = currentPathname.startsWith('/workspaces/') ? currentPathname : '/';
  const nextParams = new URLSearchParams(currentSearch);
  nextParams.set('designReview', surface);
  nextParams.set('designReviewRun', runToken);
  return `${mainPath}?${nextParams.toString()}`;
}

export function dispatchOpenDesignReviewSurface(
  surface: DesignReviewSurfaceId,
  version?: DesignReviewVersion,
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.CustomEvent<DesignReviewNavigationDetail>(DESIGN_REVIEW_NAVIGATION_EVENT, {
    detail: version ? { surface, version } : { surface },
  }));
}
