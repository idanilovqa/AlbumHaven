'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {id, deferred} = require('./library-mix-fixtures.cjs');
async function entry(t, {captureGate, saveGate, failNavigation = false} = {}) {
  const h = await nativeMixFixture(t); h.installNavigation();
  const topHost = h.add('album-tops-root');
  const capturedHomeComponents = h.c.AlbumHavenHomeRuntime;
  // Materialize the exact inert template used by the real Search owner. The
  // source Playlist fixture does not otherwise mount a shared Search consumer.
  const root = path.resolve(__dirname, '../../..');
  const index = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
  const searchCalls = [...index.matchAll(/<template id="native-search-field-template">([\s\S]*?)<\/template>/g)];
  assert.equal(searchCalls.length, 1, 'one delivered native Search template');
  assert.equal(searchCalls[0][1], '{{ search_input("native-search-template-input", name="", placeholder="", label="Search", button_type="button") }}');
  const source = fs.readFileSync(path.join(root, 'music_app/templates/partials/search-input.html'), 'utf8');
  const macro = source.match(/{% macro search_input\([\s\S]*?-\s*%}([\s\S]*?){%- endmacro %}/);
  assert.ok(macro, 'actual shared Search macro');
  const fields = {name: '', input_id: 'native-search-template-input', value: '', placeholder: '',
    label: 'Search', button_type: 'button', button_label: 'Search'};
  const html = macro[1].replace(/{% if [\s\S]*?{% endif %}/g, '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    assert.ok(Object.hasOwn(fields, key), `known shared Search macro field ${key}`); return fields[key];
  });
  assert.doesNotMatch(html, /{%|{{/, 'no unresolved server template syntax');
  h.add('native-search-field-template', 'template').innerHTML = html;
  // Boot the complete native dependencies captured by the Top bridge. The
  // Library Mix fixture intentionally has no Home component bridge of its own.
  // Only browser geometry/observation is synthetic; component, Gallery,
  // navigation, private transport and destination providers remain real.
  h.c.ResizeObserver = class {
    constructor(callback) {this.callback = callback; this.targets = new Set();}
    observe(node) {this.targets.add(node);} unobserve(node) {this.targets.delete(node);}
    disconnect() {this.targets.clear();}
  };
  h.c.matchMedia = query => {const media = h.document.createElement('media');
    media.matches = query.includes('reduce') ? false : h.c.innerWidth <= 600; return media;};
  Object.assign(h.c.Element.prototype, {clientWidth: 980, clientHeight: 600, scrollWidth: 0,
    scrollHeight: 0, offsetWidth: 100, offsetHeight: 100});
  h.state.gallery = {};
  for (const name of ['albums-scroll', 'artist-groups', 'albums-spacer-top', 'albums-spacer-bottom']) h.add(name);
  for (const file of ['runtime/compact-player-helpers.js', 'runtime/modal-and-overlay-helpers.js',
    'runtime/virtual-artist-grid.js', 'runtime/gallery-display-preference-helpers.js',
    'runtime/search-input.js', 'runtime/in-page-tabs.js', 'unfolding-action-button.js',
    'client-device-preferences.js', 'runtime/shell-navigation-drawer.js', 'runtime/loop-range-controls.js',
    'runtime/playback-control-cluster.js', 'runtime/home-friends-bridge.js']) h.load(file);
  for (const name of ['renderPlaybackControlCluster', 'getPlaybackControlClusterElements', 'mountLoopEditActionControl'])
    assert.equal(typeof h.owner(name), 'function', `actual saved Top playback owner ${name}`);
  // The shared Gallery script constructs Artist's idle singleton. Retire that
  // owner through its real destructor before the saved Top mounts its Gallery.
  h.owner('virtualGrid').destroy();
  // Playlist captured the fixture component object before the actual Home
  // bridge was available. Hydrate that same object with the complete real
  // owner, preserving its identity rather than forwarding individual methods.
  assert.notEqual(capturedHomeComponents, h.c.AlbumHavenHomeRuntime);
  Object.assign(capturedHomeComponents, h.c.AlbumHavenHomeRuntime);
  for (const key of Object.keys(h.c.AlbumHavenHomeRuntime))
    assert.equal(capturedHomeComponents[key], h.c.AlbumHavenHomeRuntime[key]);
  h.load('runtime/album-tops-react-bridge.js');
  h.state.view.playlist_detail = {...h.state.view.playlist_detail, playlist_kind: 'manual', library_mix: null,
    title: 'Source Playlist', description: '', allowed_actions: {can_open: true, can_create_album_top: true}};
  h.runtime.sync();
  const calls = {capture: [], save: [], discard: [], navigation: [], back: [], confirms: []};
  const topReads = [];
  h.c.fetch = async (url, options = {}) => {
    topReads.push(url); assert.equal(options.method || 'GET', 'GET');
    let data;
    if (url === '/album-tops/edit-requests?limit=100') data = {requests: [], next_cursor: null};
    else {
      assert.equal(calls.save.length, 1, 'saved Top reads require the explicit creation acknowledgement');
      const saved = {top_ref: id(6), revision: '1', title: calls.save[0].title,
        description: calls.save[0].description, visibility: 'private',
        allowed_actions: {can_read: true, 'library.browse.read': true}};
      if (url === '/album-tops?limit=100') data = {tops: [saved], next_cursor: null, allowed_actions: {}};
      else {
        assert.equal(url, '/album-tops/' + id(6));
        data = {...saved, items: [{ref: id(7), catalog_ref: id(3), title: 'Album', artist_display: 'Artist',
          release_year: 2000, original_position: 1, curator_position: 1, native_album: null}]};
      }
    }
    return {ok: true, status: 200, json: async () => ({context_ref: h.c.AlbumHavenPrivateUITransport.context(), status: 'ready', data})};
  };
  h.c.history.go = delta => calls.back.push(delta);
  let fail = failNavigation;
  h.c.fetchAndRender = async (url, push, options) => {
    calls.navigation.push(url); const requestId = ++h.state.ui.activeViewRequestId;
    assert.equal(options.onStart({requestId}), true);
    if (fail) {options.onSettled({requestId, applied: false}); return false;}
    const payload = {context_ref: h.c.AlbumHavenPrivateUITransport.context(), surface: {active: 'album_tops'}, top_ref: id(6)};
    assert.equal(options.shouldApplyResponse(payload), true);
    h.state.view = payload; h.c.history.pushState({...h.c.history.state}, '', '/?surface=album_tops&top_ref=' + id(6));
    h.c.AlbumHavenAlbumTopsRuntime.sync(); h.runtime.sync(); options.onSettled({requestId, applied: true}); return true;
  };
  const providers = {
    readPlaylists: async () => h.state.view,
    captureAlbumTopPreview: async command => {
      calls.capture.push(command); if (captureGate) await captureGate.promise;
      return {preview_ref: command.request_key, source: {playlist_ref: command.playlist_ref, revision: command.revision},
        expires_at: '2099-01-01T00:00:00Z', title: 'Source Playlist', description: '', albums: [{album_ref: id(3), title: 'Album', artist: 'Artist', year: 2000}],
        report: [{playlist_item_ref: id(4), position: 1, reason: 'included'}]};
    },
    saveAlbumTopPreview: async command => {calls.save.push(command); if (saveGate) await saveGate.promise;
      return {action: 'create', request_key: command.request_key, top_ref: id(6), revision: '1'};},
    discardAlbumTopPreview: async ref => {calls.discard.push(ref);}, resolveAlbumTopPreview: async () => {throw Error('Unexpected details action');},
  };
  await h.boot(providers); await h.settle();
  assert.equal(h.named('Create Album Top').disabled, false); h.click(h.named('Create Album Top')); await h.settle();
  return {...h, topHost, topReads, sampleCalls: calls, allowNavigation: () => {fail = false;},
    edit(value) {const input = h.host.querySelector('[aria-label="Album Top name"]'); input.value = value;
      h.flush(() => input.dispatchEvent(new h.c.Event('input', {bubbles: true})));},
    confirmWith(promise) {h.c.showAppConfirmDialog = options => {calls.confirms.push(options); return promise;};}};
}
test('actual header opens unsaved preview; edit and explicit Save reach actual Top navigator once', async t => {
  const gate = deferred(), h = await entry(t, {saveGate: gate});
  assert.equal(h.sampleCalls.capture.length, 1); assert.equal(h.sampleCalls.save.length, 0);
  assert.ok(h.host.querySelector('[aria-label="Unsaved Album Top preview"]'));
  h.edit('Saved title'); const save = h.named('Save'); h.click(save); await h.settle();
  save.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true})); await h.settle(); assert.equal(h.sampleCalls.save.length, 1);
  assert.equal(h.sampleCalls.save[0].title, 'Saved title'); assert.equal(h.sampleCalls.navigation.length, 0);
  gate.resolve(); await h.settle();
  assert.equal(h.sampleCalls.navigation.length, 1); assert.equal(h.c.AlbumHavenAlbumTopsRuntime.snapshot().topRef, id(6));
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.sampleCalls.discard.length, 0);
  assert.ok(h.topReads.includes('/album-tops/' + id(6)));
  assert.match(h.topHost.textContent, /Saved title/);
  assert.equal(h.topHost.querySelectorAll('.album-card').length, 1, 'real saved Top Gallery renders the captured album');
});
test('failed saved destination keeps acknowledgement and retry navigates without a second write', async t => {
  const h = await entry(t, {failNavigation: true}); h.click(h.named('Save')); await h.settle();
  assert.equal(h.sampleCalls.save.length, 1); assert.ok(h.runtime.snapshot().retainedDraftToken);
  h.allowNavigation(); h.click(h.named('Open saved Top')); await h.settle();
  assert.equal(h.sampleCalls.save.length, 1); assert.equal(h.sampleCalls.navigation.length, 2);
  assert.equal(h.c.AlbumHavenAlbumTopsRuntime.snapshot().topRef, id(6));
});
test('clean Cancel uses existing draft owner and abandons preview without a Top write', async t => {
  const h = await entry(t); h.click(h.named('Cancel')); await h.settle();
  assert.equal(h.sampleCalls.save.length, 0); assert.equal(h.sampleCalls.discard.length, 1);
  assert.equal(h.sampleCalls.back.length, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
});
test('dirty Cancel uses existing confirmation and rejects a stale confirmation after another edit', async t => {
  const answer = deferred(), h = await entry(t); h.edit('Dirty'); h.confirmWith(answer.promise);
  h.click(h.named('Cancel')); await h.settle(); assert.equal(h.sampleCalls.confirms.length, 1); h.edit('Newer');
  answer.resolve(true); await h.settle(); assert.ok(h.runtime.snapshot().retainedDraftToken); assert.equal(h.sampleCalls.discard.length, 0);
  h.confirmWith(Promise.resolve(false)); h.click(h.named('Cancel')); await h.settle(); assert.ok(h.runtime.snapshot().retainedDraftToken);
  h.confirmWith(Promise.resolve(true)); h.click(h.named('Cancel')); await h.settle(); assert.equal(h.sampleCalls.discard.length, 1);
});
for (const retire of ['scope', 'module']) test(`actual mounted preview rejects late capture after ${retire} retirement`, async t => {
  const gate = deferred(), h = await entry(t, {captureGate: gate});
  if (retire === 'scope') {h.shell.dataset.nativeAccountId = ''; h.runtime.sync();}
  else h.c.AlbumHavenPlaylistUI.configureProviders({});
  gate.resolve(); await h.settle(); assert.equal(h.sampleCalls.save.length, 0);
  assert.equal(h.host.querySelector('[aria-label="Unsaved Album Top preview"]'), null);
});
