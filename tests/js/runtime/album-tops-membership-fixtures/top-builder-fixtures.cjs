const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../../..');
const source = relative => path.join(ROOT, 'music_app/static/js', relative);
const load = relative => import(pathToFileURL(source(relative)).href);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), A = id(11), B = id(12), C = id(13), IA = id(21), IB = id(22), SOURCE = id(31);
const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create', MANAGE = 'library.album_tops.manage', ITEMS = 'library.album_tops.items.manage';
const SCOPE = 'top-builder:actor:session:library';
const clone = value => structuredClone(value);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const error = status => Object.assign(new Error('Synthetic service rejection'), {status});
const album = (n = 11, patch = {}) => ({local_album_id: n, album_ref: id(n), title: `Album ${n}`, artist: 'Artist', year: 2001, ...patch});
const members = () => [
  {item_ref: IA, album_ref: A, title: 'Retained local', artist: 'Artist', year: 2001, original_position: 4, position: 1, selected_local_album_id: 11, selected_source_ref: SOURCE},
  {item_ref: IB, album_ref: B, title: 'Retained nonlocal', artist: 'Artist', year: null, original_position: 9, position: 2},
];
function detail(patch = {}) {
  const items = members();
  return {top_ref: TOP, revision: '7', title: 'Curated Top', description: 'Subtitle', visibility: 'private',
    allowed_actions: {[BROWSE]: true, [MANAGE]: true, [ITEMS]: true, can_read: true, can_edit: true,
      can_rename: true, can_add: true, can_remove: true, can_reorder: true}, items,
    edit_draft: {items: items.map(({item_ref, album_ref, selected_local_album_id, selected_source_ref}) => ({item_ref, album_ref,
      ...(selected_source_ref ? {selected_local_album_id, selected_source_ref} : {})})), publication_preview_required: false}, ...patch};
}
function state({editing = false, data = detail()} = {}) {
  return {scopeKey: SCOPE, selectedTopRef: editing ? TOP : null,
    directory: {status: 'ready', data: {tops: [data], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}}},
    detail: {status: editing ? 'ready' : 'unavailable', data: editing ? data : null}, mutation: {status: 'idle'}};
}
function controllerFixture(initial = state()) {
  let value = initial; const listeners = new Set(), calls = [];
  const controller = {getSnapshot: () => value, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async mutate(action, payload) {calls.push({action, payload: clone(payload)}); return false;},
    canRetryMutation: () => value.mutation.status === 'uncertain', retryMutation: async () => false,
    observeDenial(scope, cause) {if (scope !== value.scopeKey) return false; replace({...value, detail: {status: 'denied', data: null, error: cause}, directory: {status: 'denied', data: null, error: cause}}); return true;}};
  function replace(next) {value = next; for (const listener of [...listeners]) listener();}
  return {controller, calls, replace, listeners};
}
function providerFixture(overrides = {}) {
  const calls = {search: [], admit: [], preview: []};
  const providers = {
    async searchAlbums(options) {calls.search.push(options); return overrides.search ? overrides.search(options) : {albums: [album()], next_cursor: null};},
    async admitAlbum(localAlbumId, options) {calls.admit.push({localAlbumId, options}); return overrides.admit ? overrides.admit(localAlbumId, options) : {album_ref: id(localAlbumId)};},
    async preview(ref, payload, options) {calls.preview.push({ref, payload: clone(payload), options}); return overrides.preview ? overrides.preview(ref, payload, options) :
      {top_ref: ref, revision: payload.revision, evidence_revision: 'a'.repeat(64), items: payload.items.map(item => ({...item, title: 'Preview title', artist: 'Artist', year: null, track_count: 1}))};},
  };
  return {providers, calls};
}
module.exports = {ROOT, source, load, id, TOP, OTHER, A, B, C, IA, IB, SOURCE, SCOPE, BROWSE, CREATE, MANAGE, ITEMS, clone, deferred, error, album, members, detail, state, controllerFixture, providerFixture};
