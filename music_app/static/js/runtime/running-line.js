/* RunningLine: the one timing contract for text that pans when it overflows its row.
   Every surface (player, compact player, gallery cards, track credits) measures with
   resolveRunningLineMotion, sets --running-line-distance / --running-line-duration on the row
   (applyRunningLineMotion), and animates its text with the shared `running-line-pan` keyframes
   in base-layout.css. Speed is slow enough to read: 12 px/s while moving, holding at each end. */
const RUNNING_LINE_SPEED_PX_PER_SECOND = 12;
const RUNNING_LINE_MOVING_SHARE = 0.7; // running-line-pan holds 15% at each end.
const RUNNING_LINE_MIN_DURATION_MS = 4000;

function resolveRunningLineMotion({ scrollWidth, clientWidth } = {}) {
  const distance = Math.max(0, Math.ceil((Number(scrollWidth) || 0) - (Number(clientWidth) || 0)));
  if (distance <= 1) return { overflowing: false, distance: 0, durationMs: 0 };
  const movingMs = (distance / RUNNING_LINE_SPEED_PX_PER_SECOND) * 1000;
  return {
    overflowing: true,
    distance,
    durationMs: Math.max(RUNNING_LINE_MIN_DURATION_MS, Math.round(movingMs / RUNNING_LINE_MOVING_SHARE)),
  };
}

function applyRunningLineMotion(row, motion) {
  row.style.setProperty('--running-line-distance', `${motion.distance}px`);
  row.style.setProperty('--running-line-duration', `${motion.durationMs}ms`);
}

function clearRunningLineMotion(row) {
  row.style.removeProperty('--running-line-distance');
  row.style.removeProperty('--running-line-duration');
}
