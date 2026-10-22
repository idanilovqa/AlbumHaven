'use strict';
// Source-only acceptance fixture. Compose the accepted classic runtime stage
// with the six frozen D R5 owners before any separately authorized execution.
// All policy, receipt, normalizer, transport, modal and renderer code is real.
const assert = require('node:assert/strict');
const {fixture: connected, read, plain, drain, deferred, ordinary, ROOT, A, B} = require('./search-native-fixtures/actual-runtime.cjs');
const preference = (patch = {}) => ({album_ref: 'inventory-album:9:11', context_ref: A,
  rating: null, is_favorite: false, favorite_override: null, favorite_source: null,
  taste_state: 'available', preference_revision: 0, can_edit: true,
  allowed_actions: {can_manage_album_preferences: true}, ...patch});
const album = (patch = {}) => ({key: 'local-album-11', album_id: 11, library_id: 9,
  name: 'Local release', artist: 'Local artist', album_artist: 'Local artist', year: 2001,
  tracks: [], track_count: 0, preview_only: false, category: 'main_library',
  allowed_actions: {can_read: true, can_view_details: true}, album_preference: preference(), ...patch});
const envelope = value => ({context_ref: A, album_preference: value});
const detail = value => ({ok: true, context_ref: A, album: value});
function fixture(t) {
  const h = connected(t), c = h.context, doc = h.document;
  c.Headers = Headers; // Browser API; actual installed CSRF wrapper uses it.
  doc.cookie = '__Host-album_haven_csrf=csrf%2Dnative';
  for (const name of ['session-csrf-fetch.js', 'private-ui-transport.js', 'response-state-helpers.js',
    'tag-editor-and-optimistic-updates.js', 'track-modal-lightbox-helpers.js', 'gallery-refresh-and-status.js'])
    assert.ok(h.loaded.some(file => file.endsWith('/' + name)), `whole product owner loaded: ${name}`);
  // Render only the served album modal fragment, including the canonical four
  // action-button calls. This is template expansion, never a product control.
  const source = read('music_app/templates/partials/primary-modals.html');
  const start = source.indexOf('<div class="track-modal" id="track-modal" hidden>');
  const end = source.indexOf('<div class="cover-lookup-modal"', start);
  assert.ok(start >= 0 && end > start);
  let expanded = 0;
  const markup = source.slice(start, end).replace(/{% call action_button\('([^']+)'([\s\S]*?)\) %}([\s\S]*?){% endcall %}/g,
    (_all, label, args, content) => {
      const id = args.match(/\bid='([^']+)'/)?.[1];
      assert.ok(['track-modal-sheet-toggle', 'track-modal-edit-tags', 'track-modal-folder', 'track-modal-close'].includes(id));
      const attributes = {id};
      if (id === 'track-modal-sheet-toggle') Object.assign(attributes, {hidden: 'hidden', 'aria-expanded': 'false', 'aria-controls': 'track-modal-list'});
      if (id === 'track-modal-close') attributes['data-close-track-modal'] = '1';
      expanded++;
      return c.ButtonComponent.renderActionButton({ariaLabel: label, title: label,
        className: args.match(/class_name='([^']+)'/)?.[1] || '', disabled: args.includes('disabled=true'), attributes, content});
    });
  assert.equal(expanded, 4); assert.doesNotMatch(markup, /{%|{{/);
  doc.body.insertAdjacentHTML('beforeend', markup);
  // Native focus cannot stay on removed nodes or enter disabled nodes. The
  // accepted fixture already handles disabled focus; add DOM removal fallout.
  const proto = c.Element.prototype, remove = proto.removeChild;
  proto.removeChild = function(node) {
    const active = doc.activeElement, losesFocus = node === active || node.contains?.(active);
    const result = remove.call(this, node);
    if (losesFocus && !active.isConnected) doc.activeElement = doc.body;
    return result;
  };
  const pending = (predicate = () => true) => h.requests.filter(r => !r.settled && predicate(r));
  const posts = () => h.requests.filter(r => r.options.method === 'POST');
  const reads = () => h.requests.filter(r => r.url.startsWith('/album-details?'));
  const control = action => c.getTrackModalAlbumPreferenceLease()?.root.querySelector(`[data-album-preference-action="${action}"]`);
  const activate = async (action, value) => {
    const node = control(action); assert.ok(node, `real ${action} control exists`); node.focus();
    assert.equal(doc.activeElement, node, `enabled ${action} can receive keyboard focus`);
    if (action === 'rating') {node.value = String(value ?? ''); h.dispatch(node, 'change');}
    else h.dispatch(node, 'click', {detail: 0}); // Browser's keyboard-generated click.
    await drain(); return posts().at(-1);
  };
  const open = async (input = album()) => {
    c.openTrackModal(input); await drain();
    const request = pending(r => r.url.startsWith('/album-details?')).at(-1);
    if (request) {request.resolve(detail(album({...input, preview_only: false}))); await drain();}
    assert.equal(c.getTrackModalElements().overlay.hidden, false);
    return c.getCurrentTrackModalAlbum();
  };
  const outside = (pointer = false) => {
    const button = doc.createElement('button'); doc.body.append(button);
    if (pointer) h.dispatch(button, 'pointerdown');
    button.focus(); return button;
  };
  t.after(() => c.disposeTrackModalAlbumPreferences());
  return {...h, c, pending, posts, reads, control, activate, open, outside};
}
module.exports = {fixture, preference, album, envelope, detail, plain, drain, deferred, ordinary, ROOT, A, B};
