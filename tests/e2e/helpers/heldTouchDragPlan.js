// Plans a held-touch drag that crosses the root gallery's continuation threshold while the gallery
// bar keeps one artist context, so its height (and the gallery under it) cannot change mid-drag.
//
// geometry: { scrollTop, scrollHeight, clientHeight, labelBottoms } in content coordinates, where
// labelBottoms are the artist labels whose bottoms switch the bar's context once they reach scrollTop.
// The threshold scrollTop is where the remaining content equals `prefetchViewports` viewports.
export function planSingleArtistHeldDrag(geometry, {
  prefetchViewports,
  maximumDrag,
  minimumDrag = 96,
  boundaryMargin = 24,
  thresholdMargin = 24,
}) {
  const { scrollTop, scrollHeight, clientHeight } = geometry;
  const threshold = scrollHeight - clientHeight - prefetchViewports * clientHeight;
  const labels = [...geometry.labelBottoms].sort((left, right) => left - right);
  const contextStart = labels.filter(bottom => bottom <= threshold).at(-1) ?? -Infinity;
  const contextEnd = labels.find(bottom => bottom > threshold) ?? Infinity;
  const startFloor = contextStart + boundaryMargin;
  const endCeiling = contextEnd - boundaryMargin;
  const drag = Math.floor(Math.min(maximumDrag, endCeiling - startFloor));
  const evidence = { scrollTop, threshold, contextStart, contextEnd, drag };
  if (!(drag >= minimumDrag)) return { feasible: false, ...evidence };
  // The start leaves room before the threshold and the end passes it, both inside the context.
  const startLow = Math.max(startFloor, threshold - drag + thresholdMargin);
  const startHigh = Math.min(endCeiling - drag, threshold - thresholdMargin);
  if (!(startLow <= startHigh)) return { feasible: false, ...evidence, startLow, startHigh };
  return {
    feasible: true,
    ...evidence,
    startLow,
    startHigh,
    target: Math.round((startLow + startHigh) / 2),
    inStartBand: scrollTop >= startLow && scrollTop <= startHigh,
  };
}

// The gallery bar has one height per artist context (one row, or two when the name needs the
// controls' own row), and the threshold follows the gallery height under it. Plans the drag for every
// gallery height seen so far that has not been ruled out, nearest start first; a plan only holds once
// the bar settled at its start gives the gallery that height.
export function planHeldDragForObservedHeights(geometry, observedHeights, rejectedHeights, options) {
  return [...new Set(observedHeights)]
    .filter(clientHeight => !rejectedHeights.includes(clientHeight))
    .map(clientHeight => ({
      clientHeight,
      plan: planSingleArtistHeldDrag({ ...geometry, clientHeight }, {
        ...options,
        maximumDrag: Math.floor(clientHeight * options.maximumDragRatio),
      }),
    }))
    .sort((left, right) => (left.plan.target ?? Infinity) - (right.plan.target ?? Infinity));
}
