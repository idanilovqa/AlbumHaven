import { evaluateTimingBudget } from '../helpers/timingBudget.js';

// 6.5 (FTC-COVERS-019P): projection-pending answers are judged against the page's own /status readiness.
// Before the first relation_projection.ready=true they are only counted. After it, each read scope gets one
// window from its first pending answer to its first success, held to the selected-artist API budget.
export const PROJECTION_PENDING_WINDOW_METRIC_ID = 'selected-artist.selectedArtistApiMs';
export const PROJECTION_READ_PATH = /^\/view-data$|\/search(?:\/|$)/;
export const STATUS_PATH = '/status';

const SCOPE_PARAMS = Object.freeze([
  'surface', 'artist', 'all_artists', 'root_sidebar', 'related_artist', 'category', 'primary_filter',
  'gallery_scope', 'include_non_album', 'q', 'playlist_id', 'duration_min', 'duration_max',
]);

export function projectionReadScope(url) {
  const { pathname, searchParams } = new URL(url);
  const parts = SCOPE_PARAMS.flatMap((name) => (
    searchParams.getAll(name).map((value) => value.trim()).sort().map((value) => `${name}=${value}`)
  ));
  return [pathname, ...parts].join('&');
}

// events: { atMs, kind: 'ready' } | { atMs, kind: 'pending', scope, code } | { atMs, kind: 'success', scope }
export function evaluateProjectionPendingTimeline(events, budget) {
  const ordered = [...events].sort((left, right) => left.atMs - right.atMs);
  const readyAtMs = ordered.find((event) => event.kind === 'ready')?.atMs ?? null;
  const scopes = new Map();
  const violations = [];
  let preReadyPendingCount = 0;
  for (const event of ordered) {
    if (event.kind === 'ready') continue;
    const scope = scopes.get(event.scope) ?? { served: false, window: null };
    scopes.set(event.scope, scope);
    if (event.kind === 'success') {
      if (scope.window && scope.window.endMs === null) scope.window.endMs = event.atMs;
      scope.served = true;
      continue;
    }
    if (readyAtMs === null || event.atMs < readyAtMs) {
      preReadyPendingCount += 1;
      continue;
    }
    if (scope.served) {
      violations.push(`${event.code} for ${event.scope} at ${Math.round(event.atMs)} ms after it had already served.`);
    } else if (!scope.window) {
      scope.window = { scope: event.scope, code: event.code, startMs: event.atMs, endMs: null };
    }
  }
  const windows = [];
  for (const { window } of scopes.values()) {
    if (!window) continue;
    if (window.endMs === null) {
      violations.push(`${window.code} for ${window.scope} at ${Math.round(window.startMs)} ms never served.`);
      continue;
    }
    const durationMs = window.endMs - window.startMs;
    windows.push({ ...window, durationMs, outcome: evaluateTimingBudget(durationMs, budget) });
  }
  return { readyAtMs, preReadyPendingCount, windows, violations };
}
