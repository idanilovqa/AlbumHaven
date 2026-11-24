// Plans a held-touch drag that crosses the root gallery's continuation threshold while the gallery
// bar keeps one artist context, so its height (and the gallery under it) cannot change mid-drag.
//
// geometry: { scrollTop, scrollHeight, clientHeight, labelBottoms } in content coordinates, where
// labelBottoms are the artist labels whose bottoms switch the bar's context once they reach scrollTop,
// and scrollGranularity is the smallest scrollTop step the browser lands on (1 / devicePixelRatio).
// The threshold scrollTop is where the remaining content equals `prefetchViewports` viewports.
// A whole-pixel swipe lands within half a pixel of its target, then snaps to the scroll granularity,
// so a start band narrower than 1 px plus that granularity cannot be reached and is not planned.
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
  const minimumStartBand = 1 + (geometry.scrollGranularity ?? 1);
  if (!(startHigh - startLow >= minimumStartBand)) {
    return { feasible: false, ...evidence, startLow, startHigh, minimumStartBand };
  }
  return {
    feasible: true,
    ...evidence,
    startLow,
    startHigh,
    target: (startLow + startHigh) / 2,
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

// The whole-pixel swipe toward a plan's start, at most `maximumStep` px. A swipe that would round to
// zero cannot move the gallery, so the preposition stops with the numbers instead of repeating it.
export function prepositionSwipeDistance(plan, scrollTop, maximumStep = 280) {
  const distance = Math.round(Math.max(-maximumStep, Math.min(maximumStep, plan.target - scrollTop)));
  if (distance === 0) {
    throw new Error(`Held-drag start is closer than the 1 px swipe resolution but outside its band: ${
      JSON.stringify({ scrollTop, plan })}`);
  }
  return distance;
}
