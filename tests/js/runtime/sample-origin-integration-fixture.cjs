'use strict';
// One VM, document, state, SettingsNavigation and real source/destination owners.
// Existing fixtures contribute browser APIs and provider inputs, not owner state machines.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const A = require('./sample-origin-action-fixtures.cjs');
const {installGalleryRuntime} = require('./album-tops-native-fixtures/gallery-runtime.cjs');
const {installSearchValuePlatform} = require('./album-tops-native-fixtures/search-value-platform.cjs');
const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function browserHistory(h) {
  const location = h.c.location, entries = [{url: location.href, state: structuredClone(h.c.history.state)}];
  let index = 0; const traversals = [];
  // Browser stack only. Explicit Back still uses actual closeDraft and Settings.
  h.c.history = {get state() {return entries[index].state;},
    pushState(state, _title, url) {location.href = new URL(url, location).href; entries.splice(++index, Infinity, {url: location.href, state: structuredClone(state)});},
    replaceState(state, _title, url) {location.href = new URL(url || location.href, location).href; entries[index] = {url: location.href, state: structuredClone(state)};},
    go(delta) {traversals.push(delta); const target = index + delta; assert.ok(target >= 0 && target < entries.length);
      queueMicrotask(() => {index = target; location.href = entries[index].url; h.runtime.sync(); h.c.AlbumHavenAlbumTopsRuntime?.sync();});}};
  return {entries, traversals, index: () => index, mark: () => ({index, url: location.href, state: structuredClone(h.c.history.state)})};
}
async function platform(t) {
  const h = await A.shared(t), c = h.c, frames = new Map(), timers = new Map();
  const history = browserHistory(h);
  c.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
  c.isMobileClient = () => false; // Explicit desktop browser platform for these integration cases.
  installSearchValuePlatform(c);
  // Extend only the browser selector grammar needed by the actual modal DOM.
  // Do not replace getTrackModalElements or any product owner lookup.
  const query = c.Element.prototype.querySelectorAll;
  c.Element.prototype.querySelectorAll = function (selector) {
    if (!selector.includes('>')) return query.call(this, selector);
    const parts = selector.split('>').map(part => part.trim());
    assert.ok(parts.every(part => /^[#.][\w-]+$/.test(part)), 'bounded direct-child selector grammar');
    let nodes = query.call(this, parts[0]);
    for (const part of parts.slice(1)) nodes = nodes.flatMap(parent => [...parent.children].filter(child => child.matches(part)));
    return nodes;
  };
  const template = h.add('native-search-field-template', 'template');
  const macro = read('music_app/templates/partials/search-input.html').match(/{% macro search_input\([\s\S]*?-\s*%}([\s\S]*?){%- endmacro %}/);
  assert.ok(macro);
  const fields = {name: 'q', input_id: 'origin-integration-search', value: '', placeholder: 'Search', label: 'Search', button_type: 'button', button_label: 'Search'};
  template.innerHTML = macro[1].replace(/{% if [\s\S]*?{% endif %}/g, '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => {assert.ok(Object.hasOwn(fields, key)); return fields[key];});
  h.state.gallery = {albumIndex: new Map(), mainState: {sources: {main_library: true, new_arrivals: false, hoard: false}}};
  h.state.status = {inventory_mutation_revision: 0}; h.state.modalReleases = []; h.state.modalReleaseIndex = 0;
  h.state.utility = {loaded: true}; h.state.lightbox = {items: [], currentIndex: -1};
  Object.assign(h.state.ui, {pendingTrackModalLoadToken: 0, pendingTrackModalLoadAlbumKey: '', viewStateRevision: 0});
  h.load('runtime/search-input.js'); h.load('runtime/in-page-tabs.js');
  const renderers = {...h.runtime, galleryCardHtml: c.buildGalleryCardHtml, tabsHtml: c.buildInPageTabsHtml,
    mountTabs: c.mountInPageTabs, searchHtml: c.buildSearchInputHtml};
  installGalleryRuntime(h, renderers, {frames, timers});
  h.load('runtime/gallery-main-state.js'); h.load('runtime/utility-list-builders.js');
  c.AlbumHavenHomeRuntime = renderers;
  for (const file of ['shell-navigation-drawer.js', 'loop-range-controls.js', 'playback-control-cluster.js']) h.load(`runtime/${file}`);
  const nav = c.AlbumHavenSettingsNavigation.instance, registrations = [], events = [];
  const register = nav.setCollectionDraftOwner;
  nav.setCollectionDraftOwner = function (owner) {
    const forwarded = {...owner, confirmLeave() {events.push('confirm-parent'); return owner.confirmLeave();},
      discard() {events.push('discard-parent'); return owner.discard();}};
    const handle = register.call(this, forwarded); registrations.push({owner, handle}); return handle;
  };
  // No alternate collection registration or Sample presentation is supplied here.
  // Source helpers must deliver both themselves through the real launch path.
  t.after(() => {nav.destroy(); for (const timer of timers.values()) if (timer.task !== null) clearImmediate(timer.task); timers.clear(); frames.clear();});
  return {...h, history, nav, registrations, events, frames, timers,
    input(node, value) {assert.ok(node); node.value = value; node.dispatchEvent(new c.Event('input'));},
    sameGlobalState() {assert.equal(h.owner('state'), h.state);},
    noWrites(svc, admitted = 0) {h.noAcquisition(); if (svc) {assert.equal(svc.count('execute'), 0); assert.equal(svc.count('admitAlbum'), admitted);} assert.equal(h.calls.save.length, 0);},
    hidden(node) {return node.hidden === true || node.style.display === 'none' || Boolean(node.closest('[hidden]'));},
    inactive(node) {return Boolean(node.closest('[hidden],[inert],[aria-hidden="true"]')) || node.inert === true;},
    assertSetup(attempts = 1) {assert.ok(h.named('Generate', h.host)); assert.equal(h.host.hidden, false); assert.equal(h.calls.draft.length, attempts);
      const current = h.calls.draft.at(-1);
      assert.equal(typeof current.presentation?.suspend, 'function', 'actual source presentation port reached openDraft');
      assert.equal(current.isCurrent(), true);
      assert.equal(h.runtime.snapshot().retainedDraftToken, current.token, 'latest successful attempt owns the retained child');},
  };
}
async function topOwner(t, {mode = 'saved', deferDetachedOpen = false, preparedActionView = false, detail = {}, providers = {}} = {}) {
  const h = await platform(t), c = h.c, selected = mode === 'detached' ? null : A.T.TOP;
  const topHost = h.add('album-tops-root');
  const sourceView = {context_ref: 'a'.repeat(64), surface: {active: 'album_tops'}, top_ref: selected};
  h.state.view = sourceView;
  h.nav.writeLibraryHistory(`/?surface=album_tops${selected ? `&top_ref=${selected}` : ''}`, {...c.history.state}, {mode: 'replace'});
  h.load('runtime/album-tops-react-bridge.js');
  const actual = c.AlbumHavenAlbumTopsRuntime;
  assert.equal(actual, h.owner('AlbumTopsRuntime')); assert.equal(actual.snapshot().visible, true);
  const svc = A.T.service(providers);
  svc.data.detail = A.T.detail({type: 'manual', source_locked: false,
    items: [{item_ref: A.F.id(510), album_ref: A.T.ALBUM, title: 'Actual member', artist: 'Artist A'}],
    edit_draft: {item_selections: [{item_ref: A.F.id(510), album_ref: A.T.ALBUM,
      selected_source_ref: A.F.id(511), selected_local_album_id: 11, selected_inventory_album_ref: 'inventory-album:5:11'}]}, ...detail});
  const captures = [], sourceScope = actual.snapshot().scopeKey;
  // Forward every existing method to the real owner. Only the documented factory
  // result is observed, with no altered admission/currentness/presentation logic.
  const observedRuntime = {...actual, captureSampleOriginNavigation() {
    assert.equal(typeof actual.captureSampleOriginNavigation, 'function');
    const value = actual.captureSampleOriginNavigation(); captures.push(value); return value;
  }, openSamplePlaylist(input) {
    h.calls.source.push(input.originOwner);
    return actual.openSamplePlaylist(input);
  }};
  let view, controller = null;
  if (preparedActionView) {
    // Bounded saved-action composition, not claimed full-index coverage. Keep
    // the actual bridge and a real controller at its actual private scope.
    assert.equal(mode, 'saved');
    assert.equal(typeof actual.isCurrentSampleScope, 'function', 'actual Top Sample scope observer is composed');
    assert.equal(observedRuntime.isCurrentSampleScope, actual.isCurrentSampleScope);
    controller = await A.T.preparedController(svc, {selected, scopeKey: sourceScope});
    view = await A.T.connectedView({...h, host: topHost, runtime: observedRuntime}, svc, controller);
  } else {
    const {mountAlbumTops} = await A.T.load('album-tops/index.mjs');
    view = mountAlbumTops({host: topHost, runtime: observedRuntime, providers: svc.providers});
  }
  await h.settle();
  t.after(() => view.dispose());
  if (mode === 'inline') {h.click(h.named('Edit Album Top', topHost)); await h.settle();}
  if (mode === 'detached' && !deferDetachedOpen) {h.click(h.named('Create Album Top', topHost)); await h.settle();}
  const form = mode === 'saved' || mode === 'detached' && deferDetachedOpen ? null
    : h.document.querySelector(`form[aria-label="${mode === 'inline' ? 'Edit' : 'Create'} Album Top"]`);
  if (mode !== 'saved' && !(mode === 'detached' && deferDetachedOpen)) assert.ok(form, 'actual builder form mounted');
  return {...h, topHost, actual, sourceScope, captures, svc, view, controller, sourceView, form,
    sourceButton: () => h.named('Create sample playlist', form || topHost),
    sourceSurface: mode === 'detached' ? h.form : topHost};
}
async function modalOwner(t, {kind = 'physical', sourcePageOwner = undefined} = {}) {
  const h = await platform(t), c = h.c;
  for (const id of ['track-modal', 'non-album-modal', 'utility-modal', 'image-lightbox']) {const n = h.add(id); n.hidden = true; n.className = 'track-modal';}
  const overlay = h.document.getElementById('track-modal');
  const dialog = h.document.createElement('div'); dialog.className = 'track-modal-dialog'; overlay.append(dialog);
  for (const id of ['header', 'title', 'subtitle', 'cover', 'missing-warning', 'duplicate-warning', 'duplicate-tabs', 'list', 'footer', 'tabs']) {
    const n = h.document.createElement('div'); n.id = `track-modal-${id}`;
    if (id === 'header') n.className = 'track-modal-header';
    dialog.append(n);
  }
  const loose = h.document.getElementById('non-album-modal');
  for (const id of ['header', 'table']) {const n = h.document.createElement('div'); n.id = `non-album-modal-${id}`; loose.append(n);}
  // Full actual modal, identity, currentness, dismissal, grouping and playtable owners.
  h.load('runtime/bootstrap-state.js'); h.load('runtime/response-state-helpers.js'); h.load('runtime/track-modal-lightbox-helpers.js');
  assert.equal(c.state, h.state); assert.equal(h.owner('state'), h.state, 'modal and destination share one state identity');
  h.load('runtime/album-details-components.js'); h.load('runtime/tag-editor-and-optimistic-updates.js');
  // Unrelated artwork, tastes and shared-player decoration are intentionally outside
  // this integration boundary, as in the accepted native renderer fixture.
  c.renderOwnTrackModalAlbumPreferences = () => {};
  c.refreshTrackModalPlaybackState = () => {};
  c.attachSharedPlayer = () => {};
  c.getPlayerPlaybackSnapshot = () => ({paused: true, ended: false});
  c.formatTrackDuration = value => String(value); c.formatAlbumDuration = value => String(value);
  c.getProblematicAlbumForTrackPath = () => null;
  const sourceView = {context_ref: 'a'.repeat(64), query: '', selected_artist: 'Artist A', related_artists: ['Family Alias'],
    non_album_library_categories: ['main_library'], artist_family_filters: [{display_name: 'Artist A', variation_names: ['Family A']}],
    non_album_tracks: [A.row(A.F.refs[0], {exception_type: 'Interview'}),
      A.row(A.F.refs[1], {artist: 'Family A', album_artist: 'Family A', exception_type: 'Non-album rarity'}),
      A.row(A.F.refs[2], {artist: 'Unrelated', album_artist: 'Unrelated', display_path: 'Family_Alias/loose.flac'})]};
  h.state.view = sourceView;
  const album = A.album(kind === 'duplicate' ? {duplicate_sources: [
    {folder_path: '/test-only/a', tracks: [A.row(A.F.refs[0])]},
    {folder_path: '/test-only/b', tracks: [A.row(A.F.refs[1]), A.row(A.F.refs[2])]}]} : {});
  h.state.gallery.albumIndex.set('alpha', album);
  const counts = {opens: 0, closes: 0, prepares: 0, fetches: 0};
  // Capture actual NativePlaytables.prepare return without replacing its implementation.
  const playtables = h.owner('NativePlaytables'), prepare = playtables.prepare, prepared = [];
  assert.equal(Object.isFrozen(playtables), false, 'fixture requires observable public prepare method');
  playtables.prepare = function (...args) {counts.prepares++; const owner = prepare.apply(this, args); prepared.push({key: args[0], owner, rows: args[3]}); return owner;};
  const openName = kind === 'loose' ? 'openNonAlbumModal' : 'openTrackModal';
  const closeName = kind === 'loose' ? 'closeNonAlbumModal' : 'closeTrackModal';
  const open = c[openName], close = c[closeName];
  c[openName] = function (...args) {counts.opens++; return open.apply(this, args);};
  c[closeName] = function (...args) {counts.closes++; return close.apply(this, args);};
  c.fetch = async () => {counts.fetches++; throw new Error('Retained modal must not fetch reconstruction');};
  c.attachModalEvents();
  if (kind === 'loose') c.openNonAlbumModal();
  else c.openTrackModal(album, {releaseSet: {releases: [album], selectedIndex: 0}, ...(sourcePageOwner ? {sourcePageOwner} : {}),
    presentationRestrictions: {can_open_album_page: true, can_play_album: false, can_view_artwork: false}});
  const retainedAlbum = c.getCurrentTrackModalAlbum(), sourceSurface = kind === 'loose' ? loose : overlay;
  const preparedRow = prepared.filter(row => row.key === (kind === 'loose' ? 'loose-tracks' : 'album-tracks')).at(-1);
  assert.ok(preparedRow, 'actual modal table prepares canonical rows');
  assert.ok(preparedRow.owner.source.snapshot());
  return {...h, kind, sourceView, sourceSurface, retainedAlbum, preparedRow, counts,
    sourceButton: () => kind === 'loose' ? loose.querySelector('[data-create-non-album-sample-playlist="1"]')
      : overlay.querySelector(kind === 'duplicate' ? '[data-create-sample-playlist="1"][data-duplicate-source-index="1"]' : '[data-create-sample-playlist="1"]'),
    assertRetained() {assert.equal(h.state.view, sourceView); if (kind !== 'loose') assert.equal(c.getCurrentTrackModalAlbum(), retainedAlbum);
      else {assert.equal(h.owner('nonAlbumSampleOwner'), preparedRow.owner); assert.ok(preparedRow.owner.source.snapshot());}}};
}
module.exports = {platform, topOwner, modalOwner, A};
