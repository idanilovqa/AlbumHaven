// Pure budget over the original rendered controls; the caller owns measurement.
export function headerActionsFit({availableWidth, identityWidth, actionsWidth, outsideWidth = 0, gap = 8}) {
  return [availableWidth, identityWidth, actionsWidth, outsideWidth, gap].every(value => Number.isFinite(value) && value >= 0)
    && availableWidth > 0 && identityWidth + actionsWidth + outsideWidth + gap * (outsideWidth > 0 ? 2 : 1) <= availableWidth;
}
