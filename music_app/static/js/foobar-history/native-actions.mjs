import {BASE, uuid, decimal, hex} from './contract.mjs';

const VERSION = 'foobar_account_history_native_v1';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => new Error('Playback is unavailable. Check again before trying Play.');
const aborted = () => Object.assign(new Error('Playback was superseded.'), {name: 'AbortError'});
const text = value => typeof value === 'string' && value.length <= 4096
  && !/[\u0000\r\n]/.test(value) && new TextEncoder().encode(value).byteLength <= 4096
  && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));

// Home-only private owner. No target, path, native identity or playback capture
// crosses into the history controller, panel, DOM, storage or navigation.
// Eligibility is deliberately lazy: one explicit check, one retained grant.
export function createFoobarHistoryNativeActions({controller, transport, tracks, isCurrent}) {
  if (!controller || !['request', 'context', 'generation', 'subscribe'].every(key => typeof transport?.[key] === 'function')
    || !['scope', 'canPlay', 'play'].every(key => typeof tracks?.[key] === 'function') || typeof isCurrent !== 'function') return null;
  let disposed = false, sequence = 0, pending = null, grant = null, notice = '';
  const listeners = new Set();
  const notify = () => {for (const listener of [...listeners]) {try {listener();} catch {}}};
  function invalidate() {sequence++; pending?.abort.abort(); pending = null; grant = null; notice = ''; notify();}
  function originalRevision(row) {
    return row.enhanced ? row.enhanced.observation_revision : row.projection?.source_revision;
  }
  function capture(row) {
    const state = controller.getSnapshot(), scope = tracks.scope();
    if (disposed || isCurrent() !== true || state.status !== 'ready' || state.sourcesStatus !== 'ready'
      || !state.page?.items.includes(row) || !uuid(row.observation_ref) || !decimal(originalRevision(row))
      || !uuid(state.selectedSource?.source_ref) || state.page.source_ref !== state.selectedSource.source_ref
      || !decimal(state.page.source_revision) || !scope.token || !scope.actor || !/^[1-9]\d*$/.test(scope.library)) throw aborted();
    const context = transport.context(), generation = transport.generation();
    if (!hex(context)) throw aborted();
    return {state, row, scope, context, generation, source: state.selectedSource.source_ref,
      revision: state.page.source_revision, family: state.family, mode: state.mode};
  }
  function current(captureValue, token, signal) {
    try {
      if (signal?.aborted || sequence !== token) return false;
      const next = capture(captureValue.row);
      return next.state === captureValue.state && next.source === captureValue.source && next.revision === captureValue.revision
        && next.family === captureValue.family && next.mode === captureValue.mode
        && next.scope.token === captureValue.scope.token && next.scope.actor === captureValue.scope.actor
        && next.scope.library === captureValue.scope.library && next.context === captureValue.context
        && next.generation === captureValue.generation && sequence === token && !signal?.aborted;
    } catch {return false;}
  }
  function available(row) {return Boolean(grant?.row === row && current(grant.capture, grant.token));}
  async function run(row, operation) {
    if (operation === 'play' && !available(row)) return;
    invalidate();
    const token = sequence, abort = new AbortController();
    let captured;
    try {captured = capture(row);} catch {return;}
    const active = () => current(captured, token, abort.signal);
    pending = {row, abort}; notify();
    const timeout = setTimeout(() => abort.abort(), 60000);
    try {
      const body = {version: VERSION, source_ref: captured.source, source_revision: captured.revision,
        observations: [[row.observation_ref, originalRevision(row)]]};
      if (!active()) throw aborted();
      const response = await transport.request(BASE + '/history/native/' + operation,
        {method: 'POST', body, signal: abort.signal, expected: captured.context, isCurrent: active});
      if (!active()) throw aborted();
      if (!exact(response, ['protocol', 'operation', 'context_ref', 'result']) || response.protocol !== VERSION
        || response.operation !== operation || response.context_ref !== captured.context) throw invalid();
      if (operation === 'eligibility') {
        const result = response.result;
        if (!Array.isArray(result) || result.length !== 1 || !exact(result[0], ['observation_ref', 'can_attempt_play'])
          || result[0].observation_ref !== row.observation_ref || typeof result[0].can_attempt_play !== 'boolean') throw invalid();
        if (!active()) throw aborted();
        if (result[0].can_attempt_play) grant = {row, capture: captured, token};
        else notice = 'No permitted native playback attempt is available for this imported record.';
      } else {
        const target = response.result;
        if (!exact(target, ['track_ref', 'path', 'title', 'artist', 'album_title', 'duration_seconds', 'inventory_track_ref', 'playback_state'])
          || !['track_ref', 'path', 'inventory_track_ref'].every(key => text(target[key]))
          || !['title', 'artist', 'album_title'].every(key => target[key] === null || text(target[key]))
          || !target.track_ref.trim() || !target.path.trim()
          || !new RegExp('^inventory-track:' + captured.scope.library + ':[1-9]\\d*$').test(target.inventory_track_ref)
          || target.path !== target.track_ref
          || (target.duration_seconds !== null && (typeof target.duration_seconds !== 'number'
            || !Number.isFinite(target.duration_seconds) || target.duration_seconds < 0
            || target.duration_seconds > 9223372036854775807))
          || !exact(target.playback_state, ['can_start_here']) || target.playback_state.can_start_here !== true) throw invalid();
        if (!active() || tracks.canPlay(target) !== true || !active()) throw aborted();
        // Synchronous native dispatch only, immediately after all continuity
        // checks. A lost response never causes an automatic retry or play.
        tracks.play(target);
        if (active()) notice = 'Playback requested.';
      }
    } catch (error) {
      if (sequence === token && !disposed) {grant = null; notice = error?.name === 'AbortError' ? '' : 'Playback unavailable. Check again to retry.';}
    } finally {
      clearTimeout(timeout); abort.abort();
      if (sequence === token) {pending = null; notify();}
    }
  }
  const releaseController = controller.subscribe(invalidate);
  let releaseTransport;
  try {releaseTransport = transport.subscribe(invalidate);} catch (error) {releaseController(); throw error;}
  return Object.freeze({
    state(row) {return Object.freeze({canAttemptPlay: available(row), busy: Boolean(pending), notice});},
    check: row => run(row, 'eligibility'), play: row => run(row, 'play'),
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    dispose() {
      if (disposed) return; disposed = true;
      try {releaseController();} finally {try {releaseTransport();} finally {invalidate(); listeners.clear();}}
    },
  });
}
