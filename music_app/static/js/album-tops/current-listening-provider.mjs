import {recordedTrackDetails} from './recorded-track-details.mjs';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const revision = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) && integer(Number(value));
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = () => Object.assign(new Error('Listening progress unavailable.'), {status: 502});
const aborted = () => Object.assign(new Error('Listening view changed.'), {name: 'AbortError'});

function project(value, options, context) {
  const {detail, itemRefs, accountId, libraryId} = options;
  if (!record(value) || value.version !== 'current-top-listening-v1' || value.context_ref !== context
    || value.top_ref !== detail.top_ref || value.top_revision !== detail.revision
    || value.account_id !== accountId || value.library_id !== libraryId
    || value.scope !== 'requested-current-items' || value.whole_top_complete !== false
    || !Array.isArray(value.items) || value.items.length !== itemRefs.length
    || !record(value.settings) || !integer(value.settings.completed_target) || value.settings.completed_target < 1
    || !positive(value.settings.settings_revision) || !['default', 'saved'].includes(value.settings.preference_status)
    || value.settings.preference_status === 'default' && (value.settings.completed_target !== 5 || value.settings.settings_revision !== '1')) throw failure();
  const seen = new Set(), items = new Map();
  for (const row of value.items) {
    const source = detail.items.find(item => item.item_ref === row?.item_ref);
    if (!record(row) || !source || !itemRefs.includes(row.item_ref) || seen.has(row.item_ref)
      || row.album_ref !== source.album_ref || typeof row.manual_completed !== 'boolean') throw failure();
    seen.add(row.item_ref);
    if (row.status === 'unavailable') {
      items.set(row.item_ref, {unavailable: true, revision: null, continuation: false,
        presentation: {protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
          top_ref: detail.top_ref, top_revision: detail.revision, album_ref: row.album_ref,
          target: value.settings.completed_target, target_preference_revision: value.settings.settings_revision,
          manual_completed: row.manual_completed,
          predicates: {has_plays: null, listened: null, completed: row.manual_completed ? true : null, rated: null},
          metrics: {}, recorded_scope: 'manual-only-current-membership'}});
      continue;
    }
    if (row.status !== 'ready' || row.local_album_ref !== source.native_album?.inventory_album_ref
      || !(row.membership_revision === null || digest(row.membership_revision)) || !record(row.predicates)
      || !['has_plays', 'listened', 'completed', 'rated'].every(key => row.predicates[key] === null || typeof row.predicates[key] === 'boolean')
      || !['ready', 'needs_explicit_start'].includes(row.baseline_status)
      || typeof row.automatic_completed !== 'boolean') throw failure();
    const full = row.full_progress;
    const reported = row.reported_evidence;
    if (!record(reported) || reported.provenance !== 'own_account_foobar_reported_evidence'
      || reported.count_family !== 'standard' || typeof reported.incomplete !== 'boolean'
      || !['available', 'unavailable', 'not_requested'].includes(reported.status)
      || !(reported.has_plays === null || reported.has_plays === true)
      || reported.has_plays === true && reported.status !== 'available') throw failure();
    // A read receipt identifies its exact UI owner, not an import revision or
    // authority lease. A subsequent measured POST does not refresh this fact.
    const reportedEvidence = {...reported, freshness: 'last-read', binding: JSON.stringify([
      context, accountId, libraryId, detail.top_ref, detail.revision, row.item_ref,
      row.album_ref, row.local_album_ref, value.settings.settings_revision])};
    if (!record(full) || typeof full.available !== 'boolean') throw failure();
    let supported = false;
    if (full.available) {
      if (!revision(full.state_revision) || typeof full.continuation !== 'boolean') throw failure();
      if (!['not_started', 'recalculating'].includes(full.status)) {
        if (full.policy_version !== 'local-edition-overlap-total-margin-v1' || full.basis !== 'healthy-local-inventory-version-v1'
          || full.history_complete !== false || !integer(full.full) || !integer(full.uninterrupted_full)
          || full.uninterrupted_full > full.full || full.partial !== null
          || !['processing', 'complete_at_cutoff', 'lower_bound_at_cutoff', 'blocked'].includes(full.status)) throw failure();
        if (!digest(row.membership_revision)) throw failure();
        supported = true;
      }
    }
    if (row.predicates.listened === true && (!supported || full.full < 1)
      || row.automatic_completed && (!supported || full.full < value.settings.completed_target
        || row.fresh_rating !== true || row.fresh_play !== true || row.baseline_status !== 'ready')
      || row.predicates.completed === true && !row.manual_completed && !row.automatic_completed) throw failure();
    if (full.recorded_details_reason != null && full.recorded_details_reason !== 'derived_detail_capacity') throw failure();
    const details=full.recorded_details == null ? null : recordedTrackDetails(full.recorded_details,value.settings.completed_target);
    if (full.recorded_details != null && !details) throw failure();
    const metric = count => ({status: 'at_least_recorded', value: count});
    items.set(row.item_ref, {revision: full.available ? full.state_revision : null,
      continuation: full.available && full.continuation, baselineStatus: row.baseline_status,
      unavailable: !full.available,
      reportedEvidence,
      presentation: {protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
        top_ref: detail.top_ref, top_revision: detail.revision, album_ref: row.album_ref,
        target: value.settings.completed_target, target_preference_revision: value.settings.settings_revision,
          manual_completed: row.manual_completed,
        predicates: {...row.predicates}, metrics: {...(supported ? {full: metric(full.full), uninterrupted_full: metric(full.uninterrupted_full)} : {}),
          ...(details?.partial_stretches != null ? {partial:{status:'processed_window',value:details.partial_stretches}} : {}),
          ...(details?.tracks_at_target != null ? {tracks_at_target:metric(details.tracks_at_target)} : {})},
        recorded_details:details,recorded_details_reason:full.recorded_details_reason ?? null,uneven_track_coverage:details?.uneven_track_coverage,
        reported_evidence: reportedEvidence,
        recorded_scope: 'retained-local-lower-bound'}});
  }
  return {items, baselineChanged: value.items.some(row => row.baseline_changed === true), settings: {value: value.settings.completed_target, revision: value.settings.settings_revision,
    status: value.settings.preference_status}};
}

export function createCurrentTopListeningProvider({transport, acceptsScope, isDisposed}) {
  async function request(options, advance) {
    const {detail, itemRefs, scopeKey, signal} = options;
    if (!record(detail) || !Array.isArray(detail.items) || !Array.isArray(itemRefs) || !itemRefs.length
      || itemRefs.length > 4 || new Set(itemRefs).size !== itemRefs.length
      || !itemRefs.every(ref => detail.items.some(item => item.item_ref === ref))
      || !positive(options.accountId) || !positive(options.libraryId)) throw failure();
    const context = transport.context();
    const current = () => !isDisposed() && !signal?.aborted && acceptsScope(scopeKey)
      && transport.context() === context && options.isCurrent() === true;
    if (!current()) throw aborted();
    let path = '/playback/capture/position/top-metrics', body;
    if (advance !== undefined) {
      if (itemRefs.length !== 1 || !revision(advance)) throw failure();
      path += '/advance'; body = {top_ref: detail.top_ref, top_revision: detail.revision,
        item_ref: itemRefs[0], state_revision: advance};
    } else {
      const query = new URLSearchParams({top_ref: detail.top_ref, top_revision: detail.revision});
      for (const ref of itemRefs) query.append('item_ref', ref);
      path += '?' + query;
    }
    const value = await transport.request(path, {signal, expected: context, ...(body ? {method: 'POST', body} : {})});
    if (!current()) throw aborted();
    return project(value, options, context);
  }
  return {readTopListening: options => request(options),
    advanceTopListening: (options, revision) => request(options, revision)};
}
