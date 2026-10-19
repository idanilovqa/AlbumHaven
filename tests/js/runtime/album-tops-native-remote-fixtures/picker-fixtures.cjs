'use strict';
// DTO/provider boundaries only. Tests import the real draft, controller and native owners.
const F = require('../album-tops-membership-fixtures/top-builder-fixtures.cjs');
const CONTEXT = 'a'.repeat(64), VERSION = 'b'.repeat(64);
const PARENT = F.id(51), SAVED_PARENT = F.id(52), ACQUISITION = F.id(61), RG = F.id(71), ADMISSION = F.id(81);
const summary = (ref = RG, patch = {}) => ({source_kind: 'remote_summary', provider: 'musicbrainz',
  entity_kind: 'release-group', release_group_id: ref, title: ref === RG ? 'Remote album' : 'Second remote album', artist_display: 'Remote artist',
  first_release_date: '2003-02', primary_type: 'Album', metadata_coverage: 'album_summary_only',
  track_metadata_status: 'unavailable', track_count: null, ...patch});
function mixed({manageOnly = false, published = false} = {}) {
  const value = F.detail();
  value.allowed_actions = {...value.allowed_actions, can_copy: true, can_view_sharing: true, can_share: true};
  value.items[1] = {...value.items[1], ...summary(), artist: 'Remote artist', year: 2003};
  value.edit_draft = {publication_preview_required: published, item_selections: [
    {kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'local', selected_local_album_id: 11, selected_source_ref: F.SOURCE}},
    {kind: 'existing', item_ref: F.IB, album_ref: F.B, source: {kind: 'remote_retained', admission_ref: ADMISSION, evidence_version: VERSION}},
  ]};
  if (manageOnly) {value.allowed_actions[F.ITEMS] = false; for (const name of ['can_add', 'can_remove', 'can_reorder']) value.allowed_actions[name] = false;}
  return value;
}
const ownerPublication = (state = 'unpublished') => ({state, share_ref: state === 'unpublished' ? null : F.id(41),
  link_revision: state === 'unpublished' ? null : '2', publication_ref: state === 'enabled' ? F.id(42) : null,
  publication_revision: state === 'enabled' ? '1' : null,
  public_path: state === 'enabled' ? `/public/album-tops/${F.id(41)}` : null,
  public_url: state === 'enabled' ? `https://public.example.test/public/album-tops/${F.id(41)}` : null,
  deployment_available: true, can_enable_external: true, can_revoke_external: state === 'enabled'});
const capacity = (patch = {}) => ({legacy_initialized: true, legacy_inspected: 0, counts_complete: true,
  actor_pending_count: 1, actor_pending_bytes: 256, actor_reservations: 0, physical_parents: 1,
  actor_pending_slots_available: 511, actor_pending_bytes_available: 8388352,
  actor_reservation_slots_available: 2, physical_parent_slots_available: 31,
  attempt_slots_remaining: 511, pending_slots_available: 511, pending_bytes_available: 8388352,
  reservation_slots_available: 2, worst_case_new_acquisitions: 511, ...patch});
const parentRecord = (ref = PARENT, form = F.id(91), state = 'ready') => ({preparation_ref: ref, form_ref: form, state,
  created_at: '2099-01-01T00:00:00Z', accepts_until: '2099-01-01T00:30:00Z', fully_expires_at: '2099-01-01T01:00:00Z',
  attempt_count: 1, pending_count: 1, pending_bytes: 256, reservation_count: 0, capacity: capacity()});
const searchPage = (body, candidates) => ({context_ref: CONTEXT, destination: body.destination, limit: 10, candidates});
const receipt = (action, command, patch = {}) => ({action, request_key: command.request_key,
  top_ref: action === 'copy' ? F.OTHER : command.top_ref || F.TOP,
  revision: ['create', 'copy'].includes(action) ? '1' : String(BigInt(command.revision) + 1n),
  ...(action === 'create' && Array.isArray(command.selections) ? {draft_ref: command.draft_ref} : {}),
  ...(action === 'copy' ? {source_top_ref: command.top_ref, source_revision: command.revision} : {}), ...patch});
function service({detail = mixed(), handlers = {}} = {}) {
  const calls = [], data = {detail, publication: ownerPublication()}, control = {...handlers};
  const identity = Object.freeze({context: CONTEXT, generation: 1}); let currentIdentity = identity;
  const parent = payload => ({version: 2, context_ref: CONTEXT, destination: payload.destination, ...parentRecord(PARENT, payload.form_ref)});
  const acquisition = payload => ({version: 2, context_ref: CONTEXT, destination: payload.destination,
    preparation_ref: payload.preparation_ref, request_key: payload.request_key, state: 'pending',
    acquisition_ref: payload.release_group_id === RG ? ACQUISITION : F.id(62), evidence_version: VERSION,
    expires_at: '2099-01-01T00:35:00Z', album: summary(payload.release_group_id)});
  const methods = {
    list: () => ({tops: [{top_ref: data.detail.top_ref, revision: data.detail.revision, title: data.detail.title,
      allowed_actions: {...data.detail.allowed_actions}}], next_cursor: null,
      allowed_actions: {[F.BROWSE]: true, [F.CREATE]: true, can_create: true}}),
    read: ref => F.clone({...data.detail, top_ref: ref}),
    searchAlbums: () => ({albums: [F.album(13, {title: 'Found local album'})], next_cursor: null}),
    admitAlbum: local => ({album_ref: F.id(local)}),
    searchRemoteAlbums: body => searchPage(body, [summary(), summary(F.id(72))]),
    beginRemotePreparation: parent, acquireRemoteAlbum: acquisition,
    readRemotePreparationState: () => ({version: 2, context_ref: CONTEXT, state: 'status', sql_now: '2099-01-01T00:06:00Z',
      parents: [parentRecord(SAVED_PARENT, F.id(92), 'accepting')], capacity: capacity(), maintenance_required: false}),
    maintainRemotePreparations: () => ({version: 2, context_ref: CONTEXT, state: 'progress', branch: 'legacy_initialization',
      inspected: 1024, removed_facts: 0, removed_attempts: 0, released_bytes: 0, more_work: true,
      capacity: capacity({legacy_initialized: false, legacy_inspected: 1024, counts_complete: false,
        attempt_slots_remaining: null, pending_slots_available: null, pending_bytes_available: null,
        reservation_slots_available: null, worst_case_new_acquisitions: 0})}),
    closeRemotePreparation: ref => ({version: 2, context_ref: CONTEXT, state: 'closed', preparation_ref: ref,
      removed_attempts: 1, removed_facts: 1, released_bytes: 256, capacity: capacity()}),
    readSharing: ref => ({top_ref: ref, revision: data.detail.revision, visibility: 'private', can_manage: true,
      can_copy: true, can_request_edit: false, request_status: 'none', pending_requests: [], next_pending_cursor: null,
      publication: F.clone(data.publication)}),
    execute: (action, command) => receipt(action, command),
    preview: () => {throw new Error('Remote publication must not dispatch preview');},
    readPublicationSources: () => {throw new Error('Remote publication must not dispatch source reads');},
  };
  const providers = Object.fromEntries(Object.entries(methods).map(([method, fallback]) => [method, (...args) => {
    calls.push({method, args}); return (control[method] || fallback)(...args);
  }]));
  providers.remoteContext = () => currentIdentity;
  return {providers, data, calls, control, identity, parent, acquisition,
    setIdentity(value) {currentIdentity = value;}, count: method => calls.filter(row => row.method === method).length,
    last: method => calls.filter(row => row.method === method).at(-1)};
}
const remoteMethods = ['searchRemoteAlbums', 'beginRemotePreparation', 'acquireRemoteAlbum',
  'readRemotePreparationState', 'maintainRemotePreparations', 'closeRemotePreparation'];
const remoteCalls = api => api.calls.filter(row => remoteMethods.includes(row.method));
async function drain() {for (let count = 0; count < 30; count++) await Promise.resolve();}
function input(root, label, value) {
  const element = [...root.querySelectorAll('input')].find(node => node.getAttribute('aria-label') === label
    || node.closest('label')?.textContent.trim() === label);
  if (!element) throw new Error(`Missing input: ${label}`);
  element.value = value;
  element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', {bubbles: true}));
  return element;
}
module.exports = {...F, CONTEXT, VERSION, PARENT, SAVED_PARENT, ACQUISITION, RG, ADMISSION,
  summary, mixed, ownerPublication, capacity, parentRecord, searchPage, receipt, service, remoteCalls, drain, input};
