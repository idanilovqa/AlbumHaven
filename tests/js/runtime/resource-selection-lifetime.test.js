const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', name), 'utf8');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const awaitNative = (completion, failure) => Promise.race([completion.promise, failure.promise.then(error => {throw error;})]);
function environment() {
  const env = createNativeHomeRuntime(), c = env.context, d = env.document;
  // This fixture exercises native lifetime/focus ownership beyond the shared
  // component-only fixture. Supply browser primitives; keep native owners real.
  c.Element.prototype.focus = function() {
    if (this.isConnected && !this.disabled && !this.closest('[hidden], [inert]')) d.activeElement = this;
  };
  c.clearTimeout = clearTimeout;
  vm.runInContext(read('browser-scheduling-helpers.js'), c);
  c.Node.prototype.before = function(node) {this.parentNode?.insertBefore(node, this);};
  c.Node.prototype.replaceWith = function(node) {if (this.parentNode) {this.before(node); this.remove();}};
  d.createComment = () => new c.Node(8);
  c.AbortController = AbortController;
  c.addEventListener = d.addEventListener.bind(d); c.removeEventListener = d.removeEventListener.bind(d); c.dispatchEvent = d.dispatchEvent.bind(d);
  const overlay = d.createElement('div'); overlay.id = 'track-modal'; overlay.hidden = true;
  overlay.innerHTML = '<div class="track-modal-dialog" role="dialog" aria-modal="true"><div class="track-modal-header"><h3 class="album-details-header__primary">Album</h3></div><div class="track-modal-body"><button class="play-track-button">Play</button></div></div>';
  d.body.appendChild(overlay);
  const host = d.createElement('section'); d.body.appendChild(host);
  const queue = {untouched: true}; c.state = {ui: {}, modalReleases: [], modalReleaseIndex: 0, player: {playbackQueue: queue}};
  c.getTrackModalElements = () => ({overlay, header: d.querySelector('.track-modal-header')});
  c.renderTrackModalRelease = () => {}; c.hideVersionContextMenu = () => {};
  c.attachSharedPlayer = () => {}; c.attachGalleryPlaybackContextToAlbum = value => value;
  c.getAlbumReleaseSet = value => ({releases: [value], selectedIndex: 0});
  c.getAlbumRequestKey = value => value.key;
  vm.runInContext(read('track-modal-lightbox-helpers.js'), c);
  vm.runInContext(read('resource-selection.js'), c);
  return {...env, c, host, overlay, queue};
}
const target = () => ({kind: 'album', ref: 'catalog:one', allowed_actions: {can_view_details: true},
  native_actions: {album_ref: 'local:one', allowed_actions: {can_open_album: true, can_play_album: true,
    can_view_artwork: true, can_open_album_page: true}}});

test('native lease moves the exact dialog without opening modal, starting playback or changing queue', () => {
  const {c, host, overlay, queue} = environment(), dialog = overlay.firstElementChild, album = {key: 'local:one', tracks: []};
  const lease = c.acquireTrackModalSelection(host, album, {isCurrent: () => true, canPlay: () => true});
  assert.equal(host.firstElementChild, dialog); assert.equal(overlay.hidden, true);
  assert.equal(dialog.getAttribute('role'), 'region'); assert.equal(dialog.hasAttribute('aria-modal'), false);
  assert.equal(c.state.player.playbackQueue, queue); assert.equal(c.getTrackModalSelectionAlbumFor(dialog.firstElementChild), album);
  lease.release(); assert.equal(overlay.firstElementChild, dialog); assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true'); assert.equal(c.state.player.playbackQueue, queue);
  lease.release(); assert.equal(overlay.firstElementChild, dialog);
});
test('a competing native modal retires the lease synchronously and stale release cannot clear its album', () => {
  const {c, host, overlay} = environment(), first = {key: 'local:one', tracks: []}, second = {key: 'local:two', tracks: []};
  const lease = c.acquireTrackModalSelection(host, first, {isCurrent: () => true});
  c.openTrackModal(second); assert.equal(c.getTrackModalSelectionLease(), null); assert.equal(overlay.hidden, false);
  assert.equal(c.state.modalReleases[0], second); assert.equal(host.childNodes.length, 0);
  lease.release(); assert.equal(c.state.modalReleases[0], second);
});
test('native action rejects grant revocation during hydration and a competing modal token', async () => {
  for (const reason of ['revoked', 'modal']) {
    const {c} = environment(), pending = deferred(); let supplied = target(), opens = 0;
    c.fetchTrackModalAlbumDetails = () => pending.promise; c.openTrackModal = () => {opens++;};
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
    const action = owner.resourceIntent('open', target(), {scopeKey: 'scope'});
    if (reason === 'revoked') supplied = null; else c.state.ui.pendingTrackModalLoadToken = 1;
    pending.resolve({key: 'local:one', tracks: []});
    await assert.rejects(action, reason === 'modal' ? {name: 'AbortError'} : {status: 403}); assert.equal(opens, 0);
  }
});
test('selection never passes a display DTO as native Album and page requires the actual mobile owner', async () => {
  const {c} = environment(), raw = {key: 'local:one', tracks: []}; let opened;
  c.fetchTrackModalAlbumDetails = async ref => {assert.equal(ref, 'local:one'); return raw;};
  c.openTrackModal = value => {opened = value;}; c.usesMobilePageLayout = () => false;
  c.presentMobileAlbumPage = () => {};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  assert.equal(owner.canResourceIntent('page', target(), {scopeKey: 'scope'}), false);
  await owner.resourceIntent('open', {...target(), path: 'private DTO'}, {scopeKey: 'scope'});
  assert.equal(opened, raw); assert.equal(opened.path, undefined);
});
test('Artist names and read permission alone never authorize Gallery navigation', () => {
  const {c} = environment(); c.handleSidebarArtistSelectionClick = () => {};
  const selection = {kind: 'artist', ref: 'artist:one', allowed_actions: {can_view_details: true}};
  let supplied = {...selection, title: 'Artist Name'};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  assert.equal(owner.canResourceIntent('artist_gallery', selection, {scopeKey: 'scope'}), false);
  supplied = {...selection, native_actions: {artist_ref: 'native:one', allowed_actions: {can_open_artist_gallery: true}}};
  assert.equal(owner.canResourceIntent('artist_gallery', selection, {scopeKey: 'scope'}), false);
  supplied.gallery_target = {artist: 'Explicit native target'};
  assert.equal(owner.canResourceIntent('artist_gallery', selection, {scopeKey: 'scope'}), true);
});

test('listened Albums require a current retained Artist response and retire with its parent source', () => {
  const {c} = environment(); c.fetchTrackModalAlbumDetails = async () => ({key: 'local:one', tracks: []});
  const origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'week', snapshot_ref: 'snapshot:one'};
  const parent = {kind: 'artist', ref: 'catalog-artist:one', origin, allowed_actions: {can_view_details: true}};
  const child = {...target(), origin}; let currentParent = parent;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: target => target.kind === 'artist' ? currentParent : null});
  const context = {scopeKey: 'scope', origin};
  assert.equal(owner.canResourceIntent('open', child, context), false);
  const release = owner.retainArtistAlbums(parent, context, {kind: 'artist', ref: parent.ref, origin,
    listened_albums: [{detail_target: child, native_actions: child.native_actions}]});
  assert.equal(owner.canResourceIntent('open', child, context), true);
  assert.equal(owner.canResourceIntent('open', child, {...context, origin: {...origin, account_ref: 'friend:two'}}), false);
  currentParent = {...parent, allowed_actions: {can_view_details: false}};
  assert.equal(owner.canResourceIntent('open', child, context), false);
  currentParent = parent; release(); assert.equal(owner.canResourceIntent('open', child, context), false);
});
test('retained native content loses playback admission immediately with its current source', () => {
  const {c, host} = environment(); let readable = true;
  const album = {key: 'local:one', tracks: []};
  c.acquireTrackModalSelection(host, album, {isCurrent: () => readable, canPlay: () => readable});
  const button = host.querySelector('.play-track-button');
  assert.equal(c.canPlayTrackModalSelection(button), true);
  readable = false; assert.equal(c.canPlayTrackModalSelection(button), false);
  assert.equal(c.getTrackModalSelectionAlbumFor(button), null);
});
test('native content identity change retires rather than displaying a different album under the old selection', () => {
  const {c, host, overlay} = environment();
  c.acquireTrackModalSelection(host, {key: 'local:one', tracks: []}, {isCurrent: () => true});
  c.reconcileTrackModalSelectionAlbum({key: 'local:two', tracks: []});
  assert.equal(c.getTrackModalSelectionLease(), null); assert.equal(host.childNodes.length, 0);
  assert.equal(overlay.hidden, true);
});

test('retiring the initiating selection aborts an otherwise still-authorized native open', async () => {
  const {c} = environment(), pending = deferred(), lifecycle = new AbortController(); let opened = false, received;
  c.fetchTrackModalAlbumDetails = (ref, {signal}) => {received = signal; return pending.promise;};
  c.openTrackModal = () => {opened = true;};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const action = owner.resourceIntent('open', target(), {scopeKey: 'scope', signal: lifecycle.signal});
  lifecycle.abort(); pending.resolve({key: 'local:one', tracks: []});
  await assert.rejects(action, {name: 'AbortError'}); assert.equal(received, lifecycle.signal); assert.equal(opened, false);
});

test('closing native modal reacquires the same selection and focuses its recreated title control', {timeout: 5000}, async t => {
  const env = environment(), {c, host, overlay, document} = env;
  const ready = deferred(), opened = deferred(), resumed = deferred(), failure = deferred(); let mounts = 0;
  c.renderTrackModalRelease = () => {
    document.querySelector('.track-modal-header').innerHTML = '<h3 class="album-details-header__primary">Current album</h3>';
  };
  c.fetchTrackModalAlbumDetails = async () => ({key: 'local:one', tracks: []});
  const open = c.openTrackModal;
  c.openTrackModal = (album, options) => {open(album, options); opened.resolve();};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const mounted = owner.mountResourceSelection(host, {selection: target(), scopeKey: 'scope', onError: failure.resolve, onState(status) {
    if (status === 'ready') (++mounts === 1 ? ready : resumed).resolve();
  }});
  t.after(() => mounted.dispose());
  await awaitNative(ready, failure);
  const first = host.querySelector('[data-resource-selection-open]'); first.focus(); env.click(first);
  await awaitNative(opened, failure); assert.equal(overlay.hidden, false); assert.equal(first.isConnected, false);
  c.closeTrackModal(); await awaitNative(resumed, failure);
  const next = host.querySelector('[data-resource-selection-open]');
  assert.notEqual(next, first); assert.equal(document.activeElement, next);
  mounted.dispose(); assert.equal(c.getTrackModalSelectionLease(), null);
});
test('disposed native mount ignores late hydration and removes all of its listeners', async () => {
  const {c, host, listeners} = environment(), pending = deferred(); const statuses = [];
  c.fetchTrackModalAlbumDetails = () => pending.promise;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const before = listeners().length;
  const mounted = owner.mountResourceSelection(host, {selection: target(), scopeKey: 'scope', onState: status => statuses.push(status)});
  mounted.dispose(); pending.resolve({key: 'local:one', tracks: []});
  await pending.promise; await Promise.resolve();
  assert.equal(c.getTrackModalSelectionLease(), null); assert.equal(host.childNodes.length, 0);
  assert.deepEqual(statuses, ['loading']); assert.equal(listeners().length, before);
});

test('native and React target boundaries preserve the same strict canonical shape', async () => {
  const {pathToFileURL} = require('node:url');
  const shared = await import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/resource-target.mjs')));
  const {c} = environment();
  for (const value of [target(), {...target(), native_actions: {}}, {...target(), allowed_actions: Object.create({can_view_details: true})},
    {...target(), origin: {source: 'playlist', playlist_ref: 'playlist:one'}},
    {...target(), origin: {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'week', snapshot_ref: 'one'}}]) {
    assert.deepEqual(JSON.parse(JSON.stringify(c.AlbumHavenResourceSelection.projectTarget(value))), shared.detailSelection(value));
  }
});

test('native Album browse permission retains artwork/page presentation while explicit restrictions win', () => {
  const {c} = environment(); c.fetchTrackModalAlbumDetails = async () => ({key: 'local:one', tracks: []});
  c.usesMobilePageLayout = () => true; c.presentMobileAlbumPage = () => {};
  let supplied = target(); supplied.native_actions.allowed_actions = {can_open_album: true, can_play_album: false};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  assert.equal(owner.canResourceIntent('artwork', target(), {scopeKey: 'scope'}), true);
  assert.equal(owner.canResourceIntent('page', target(), {scopeKey: 'scope'}), true);
  supplied.native_actions.allowed_actions.can_view_artwork = false;
  supplied.native_actions.allowed_actions.can_open_album_page = false;
  assert.equal(owner.canResourceIntent('artwork', target(), {scopeKey: 'scope'}), false);
  assert.equal(owner.canResourceIntent('page', target(), {scopeKey: 'scope'}), false);
});

// Runs the real native modal renderer/header/artbox/button path. Only unrelated
// empty track-table formatting and responsive shell plumbing are bounded here.
function renderedEnvironment({mobile = false} = {}) {
  const env = environment(), {c, document: d, overlay} = env;
  c.state.view = {primary_artist_groups: [], family_artist_groups: [], artist_groups: []};
  overlay.querySelector('.track-modal-body').innerHTML = '<div id="track-modal-cover"></div><div id="track-modal-list"></div>';
  vm.runInContext(read('modal-and-overlay-helpers.js'), c);
  // The bounded component DOM has no child combinator. Adapt that browser
  // selector so the real native modal-elements owner also runs unchanged.
  const query = d.querySelector.bind(d);
  d.querySelector = selector => selector === '#track-modal > .track-modal-dialog > .track-modal-header'
    ? overlay.children.find(node => node.matches('.track-modal-dialog'))?.children.find(node => node.matches('.track-modal-header')) || null
    : query(selector);
  vm.runInContext(read('tag-editor-and-optimistic-updates.js'), c);
  vm.runInContext(read('bootstrap-gallery-event-handlers.js'), c);
  c.overlayClickStartedOnOverlay = () => false; c.getIndexedAlbum = () => null;
  c.getAlbumIdentity = album => album?.key || '';
  c.hideVersionContextMenu = () => {}; c.buildTrackListHtml = () => '';
  c.formatAlbumDuration = () => ''; c.formatTrackDuration = () => '';
  c.albumHasDisplayCover = () => true; c.buildAlbumDisplayCoverUrl = () => '/art/preview';
  c.buildAlbumLightboxCoverUrl = () => '/art/full';
  c.getPlayerPlaybackSnapshot = () => ({currentTime: 0, duration: 0, paused: true});
  c.usesMobilePageLayout = () => mobile;
  let pages = 0, images = 0;
  c.presentMobileAlbumPage = () => {pages++; return mobile;};
  c.openImageLightbox = () => {images++;};
  c.fetchTrackModalAlbumDetails = async () => ({key: 'local:one', name: 'Current album', tracks: []});
  return {...env, pages: () => pages, images: () => images};
}

test('real title/Open cannot enter a denied native phone page, including after viewport changes', async () => {
  const env = renderedEnvironment({mobile: true}), {c, overlay} = env;
  const supplied = target(); supplied.native_actions.allowed_actions.can_open_album_page = false;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  await assert.rejects(owner.resourceIntent('open', supplied, {scopeKey: 'scope'}), {status: 403});
  assert.equal(env.pages(), 0); assert.equal(overlay.hidden, true);
  assert.equal(c.openTrackModal({key: 'local:one', tracks: []}, {presentationRestrictions: {can_open_album_page: false}}), false);
  assert.equal(env.pages(), 0); assert.equal(overlay.hidden, true);
  let mobile = false; c.usesMobilePageLayout = () => mobile;
  const pending = deferred(); c.fetchTrackModalAlbumDetails = () => pending.promise;
  const staleOpen = owner.resourceIntent('open', supplied, {scopeKey: 'scope'});
  mobile = true; pending.resolve({key: 'local:one', name: 'Current album', tracks: []});
  await assert.rejects(staleOpen, {status: 403});
  assert.equal(env.pages(), 0); assert.equal(overlay.hidden, true);
  delete supplied.native_actions.allowed_actions.can_open_album_page;
  await owner.resourceIntent('open', supplied, {scopeKey: 'scope'});
  assert.equal(env.pages(), 1); assert.equal(overlay.hidden, false);
});

test('source artwork denial survives the real modal rebuild without changing cached Album data or default opens', async () => {
  const env = renderedEnvironment(), {c, document: d, overlay} = env;
  const raw = Object.freeze({key: 'local:one', name: 'Current album', tracks: Object.freeze([])});
  c.fetchTrackModalAlbumDetails = async () => raw;
  const supplied = target(); supplied.native_actions.allowed_actions.can_view_artwork = false;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  await owner.resourceIntent('open', supplied, {scopeKey: 'scope'});
  assert.equal(overlay.hidden, false); assert.equal(d.querySelector('[data-open-lightbox]'), null);
  assert.equal(d.querySelector('.track-modal-cover-button').disabled, true);
  c.handleGalleryBootstrapClick({target: d.querySelector('.track-modal-cover-button'), preventDefault() {}});
  assert.equal(env.images(), 0);
  c.renderTrackModalRelease(raw);
  assert.equal(d.querySelector('[data-open-lightbox]'), null);
  c.openTrackModal(raw, {releaseSet: {releases: [raw], selectedIndex: 0}});
  assert.equal(d.querySelector('[data-open-lightbox]'), null, 'native edition owner retains restrictions');
  assert.deepEqual(Object.keys(raw), ['key', 'name', 'tracks']);
  c.openTrackModal(raw, {coverLightboxGallery: false});
  const trigger = d.querySelector('[data-open-lightbox]');
  assert.ok(trigger, 'new ordinary native open retains its default art permission');
  c.handleGalleryBootstrapClick({target: trigger, preventDefault() {}}); assert.equal(env.images(), 1);
});

test('phone native composition keeps separate working title, artwork and Full size controls', {timeout: 5000}, async t => {
  const env = renderedEnvironment({mobile: true}), {c, host} = env;
  const ready = deferred(), opened = deferred(), failure = deferred();
  const nativeOpen = c.openTrackModal;
  c.openTrackModal = (album, options) => {const result = nativeOpen(album, options); opened.resolve(); return result;};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const mounted = owner.mountResourceSelection(host, {selection: target(), scopeKey: 'scope',
    onState: state => {if (state === 'ready') ready.resolve();}, onError: failure.resolve});
  t.after(() => mounted.dispose());
  await awaitNative(ready, failure);
  const title = host.querySelector('[data-resource-selection-open]');
  const art = host.querySelector('[data-open-lightbox]');
  const page = host.querySelector('[data-resource-selection-page]');
  assert.ok(title); assert.ok(art); assert.ok(page);
  assert.notEqual(title, page); assert.equal(env.pages(), 0);
  env.click(page); await awaitNative(opened, failure); assert.equal(env.pages(), 1);
  mounted.dispose();
});

test('desktop native composition leaves Full size with Dashboard and uses the supported quiet title button', async () => {
  const env = renderedEnvironment(), {c, host} = env;
  const ready = deferred();
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const mounted = owner.mountResourceSelection(host, {selection: target(), scopeKey: 'scope',
    onState: state => {if (state === 'ready') ready.resolve();}, onError: error => ready.resolve({error})});
  const result = await ready.promise; assert.equal(result?.error, undefined);
  assert.ok(host.querySelector('[data-resource-selection-open]'));
  assert.equal(host.querySelector('[data-resource-selection-page]'), null);
  mounted.dispose();
});

test('source Open preserves explicit native Play denial despite global media access, and ordinary Open resets it', async () => {
  const env = renderedEnvironment(), {c, document: d, queue} = env;
  vm.runInContext(read('player-loop-playback.js'), c);
  c.AlbumHavenCapabilities = {allows: capability => capability === 'library.media.read'};
  c.focusPlayerTimeline = () => {};
  c.buildTrackListHtml = () => '<button class="play-track-button" type="button" data-src="/fixture-audio" data-track-path="fixture-track">Play</button>';
  let plays = 0, queued = 0;
  c.playTrackFromPayload = () => {plays++; return Promise.resolve(true);};
  c.setAlbumPlaybackQueue = () => {queued++;};
  const raw = Object.freeze({key: 'local:one', name: 'Current album', tracks: Object.freeze([])});
  c.fetchTrackModalAlbumDetails = async () => raw;
  const supplied = target(); supplied.native_actions.allowed_actions.can_play_album = false;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  await owner.resourceIntent('open', supplied, {scopeKey: 'scope'});
  let button = d.querySelector('.play-track-button');
  assert.equal(button.disabled, true);
  c.activateSharedTrackButton(button); // Actual native admission must also reject direct activation.
  assert.equal(plays, 0); assert.equal(queued, 0); assert.equal(c.state.player.playbackQueue, queue);
  c.renderTrackModalRelease(raw);
  button = d.querySelector('.play-track-button');
  assert.equal(button.disabled, true); c.activateSharedTrackButton(button);
  c.openTrackModal(raw, {releaseSet: {releases: [raw], selectedIndex: 0}});
  c.activateSharedTrackButton(d.querySelector('.play-track-button'));
  assert.equal(plays, 0); assert.equal(queued, 0);
  c.openTrackModal(raw);
  button = d.querySelector('.play-track-button');
  assert.equal(button.disabled, false);
  env.click(button); // Real attachSharedPlayer listener calls the real native Play owner.
  assert.equal(plays, 1); assert.equal(queued, 1);
  assert.deepEqual(Object.keys(raw), ['key', 'name', 'tracks']);
});

test('live native lease reconciles phone page controls across viewport changes and releases its resize listener', async () => {
  const env = renderedEnvironment(), {c, host, document: d, listeners} = env;
  let mobile = false; c.usesMobilePageLayout = () => mobile;
  const ready = deferred(), before = listeners().filter(listener => listener.type === 'resize').length;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => target()});
  const mounted = owner.mountResourceSelection(host, {selection: target(), scopeKey: 'scope',
    onState: state => {if (state === 'ready') ready.resolve();}, onError: error => ready.resolve({error})});
  assert.equal((await ready.promise)?.error, undefined);
  assert.equal(host.querySelector('[data-resource-selection-page]'), null);
  mobile = true; c.dispatchEvent(new c.Event('resize'));
  const page = host.querySelector('[data-resource-selection-page]'); assert.ok(page); page.focus();
  mobile = false; c.dispatchEvent(new c.Event('resize'));
  assert.equal(host.querySelector('[data-resource-selection-page]'), null);
  assert.equal(d.activeElement, host.querySelector('[data-resource-selection-open]'));
  mobile = true; c.dispatchEvent(new c.Event('resize'));
  assert.equal(host.querySelectorAll('[data-resource-selection-page]').length, 1);
  assert.equal(listeners().filter(listener => listener.type === 'resize').length, before + 1);
  mounted.dispose();
  assert.equal(listeners().filter(listener => listener.type === 'resize').length, before);
  c.dispatchEvent(new c.Event('resize')); assert.equal(host.childNodes.length, 0);
});

test('responsive title reconciliation respects explicit page denial and preserves connected focus', async () => {
  const env = renderedEnvironment(), {c, host, document: d} = env;
  let mobile = false; c.usesMobilePageLayout = () => mobile;
  const supplied = target(); supplied.native_actions.allowed_actions.can_open_album_page = false;
  const ready = deferred();
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  const mounted = owner.mountResourceSelection(host, {selection: supplied, scopeKey: 'scope',
    onState: state => {if (state === 'ready') ready.resolve();}, onError: error => ready.resolve({error})});
  assert.equal((await ready.promise)?.error, undefined);
  host.querySelector('[data-resource-selection-open]').focus();
  mobile = true; c.dispatchEvent(new c.Event('resize'));
  assert.equal(host.querySelector('[data-resource-selection-open]'), null);
  assert.equal(host.querySelector('[data-resource-selection-page]'), null);
  assert.equal(d.activeElement, host.querySelector('.album-details-header__primary'));
  assert.equal(d.activeElement.isConnected, true);
  mobile = false; c.dispatchEvent(new c.Event('resize'));
  assert.equal(d.activeElement, host.querySelector('[data-resource-selection-open]'));
  assert.equal(host.querySelector('.album-details-header__primary').hasAttribute('tabindex'), false);
  mounted.dispose();
});

function mobileHistoryEnvironment() {
  const env = renderedEnvironment({mobile: true}), {c, document: d} = env;
  for (const id of ['shell-main-surface', 'mobile-page-header', 'mobile-page-outlet', 'mobile-back-button',
    'mobile-library-button', 'mobile-page-title', 'mobile-page-summary', 'mobile-settings-actions', 'mobile-settings-button']) {
    const node = d.createElement('div'); node.id = id; d.body.appendChild(node);
  }
  c.Element.prototype.getClientRects = function() {return this.closest('[hidden]') ? [] : [{}];};
  const queryAll = d.querySelectorAll.bind(d);
  d.querySelectorAll = selector => selector === '[aria-modal="true"]:not([hidden])'
    ? queryAll('[aria-modal="true"]').filter(node => !node.hidden) : queryAll(selector);
  c.innerWidth = 390; c.location = new URL('https://albumhaven.test/?home_section=recent');
  c.state.view = {}; c.state.utility = {activeTab: 'appearance'};
  c.buildUrl = () => 'https://albumhaven.test/?home_section=recent';
  c.closeArtistsDrawer = () => {}; c.closeGalleryMainSurface = () => {};
  c.requestAnimationFrame = callback => {callback(); return 1;};
  let returns = 0, position = 0; const notices = [];
  c.showToast = message => notices.push(message);
  c.handleGalleryBootstrapPopState = () => {returns++;};
  const entries = [{state: {albumHavenNavigationPosition: 0, mobilePages: []}, url: c.location.href}];
  const copy = value => JSON.parse(JSON.stringify(value));
  c.history = {get state() {return entries[position].state;},
    pushState(state, title, url) {entries.splice(position + 1); entries.push({state: copy(state), url: String(url)}); position++; c.location.href = String(url);},
    replaceState(state, title, url) {entries[position] = {state: copy(state), url: String(url)}; c.location.href = String(url);},
    go() {throw new Error('Use the explicit fixture browser traversal.');}};
  c.AlbumHavenSettingsNavigation = {instance: {pushLibraryHistory(url, snapshot) {
    c.history.pushState({...snapshot, albumHavenNavigationPosition: position + 1}, '', url);
  }}};
  vm.runInContext(read('mobile-navigation.js'), c);
  // Geometry/player chrome are unrelated; the page descriptor, history stack,
  // surface transfer, cleanup and actual Album owner remain production functions.
  c.syncMobileAlbumHeader = () => {}; c.syncMobileLoopHeader = () => {};
  const raw = {key: 'local:one', name: 'Current album', tracks: []};
  c.getIndexedAlbum = () => raw; c.fetchTrackModalAlbumDetails = async () => raw;
  return {...env, raw, entries, notices, flushSource: () => vm.runInContext('mobilePageState.sourceRestore?.promise || Promise.resolve()', c), returns: () => returns, traverse(delta) {
    position += delta; assert.ok(position >= 0 && position < entries.length);
    c.location.href = entries[position].url; return c.handleMobilePagePopState();
  }};
}

function nativePlaybackProbe(c) {
  vm.runInContext(read('player-loop-playback.js'), c);
  c.AlbumHavenCapabilities = {allows: capability => capability === 'library.media.read'};
  c.focusPlayerTimeline = () => {};
  c.buildTrackListHtml = () => '<button class="play-track-button" type="button" data-src="/fixture-audio" data-track-path="fixture-track">Play</button>';
  let plays = 0, queued = 0;
  c.playTrackFromPayload = () => {plays++; return Promise.resolve(true);};
  c.setAlbumPlaybackQueue = () => {queued++;};
  return {plays: () => plays, queued: () => queued};
}

function assertCurrentNativeRelease(c, album) {
  const release = c.getCurrentTrackModalAlbum();
  assert.equal(c.state.modalReleases.length, 1); assert.equal(c.state.modalReleaseIndex, 0);
  assert.notEqual(release, album, 'the native edition owner prepares its own release object');
  assert.deepEqual({...release}, {...album, tabLabel: 'Original'});
  assert.equal(release.tracks, album.tracks, 'native release preparation retains the actual hydrated tracks');
  assert.equal(Object.hasOwn(album, 'tabLabel'), false, 'the raw Album input stays untouched');
}

test('initial native actions survive intentional source UI retirement and retain the durable source fence', async () => {
  for (const retirement of ['source', 'scope']) {
    const h = mobileHistoryEnvironment(), {c, document: d, overlay} = h;
    const playback = nativePlaybackProbe(c), lifecycle = new AbortController();
    const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
    const selected = {...target(), origin};
    let visible = true, epoch = 0, scope = 'actor:A';
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => visible ? selected : null,
      retainResource(selection, context) {
        assert.equal(visible, true); const readEpoch = epoch;
        return {target: selected, isCurrent: () => scope === context.scopeKey && epoch === readEpoch};
      }});
    await owner.resourceIntent('page', selected, {scopeKey: scope, origin, signal: lifecycle.signal});
    lifecycle.abort(); visible = false;
    const play = d.querySelector('.play-track-button'), artwork = d.querySelector('[data-open-lightbox]');
    assert.equal(overlay.hidden, false); assert.ok(artwork);
    h.click(play); c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
    assert.equal(playback.plays(), 1); assert.equal(h.images(), 1);
    if (retirement === 'source') epoch++; else scope = 'actor:B';
    h.click(play); c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
    assert.equal(playback.plays(), 1); assert.equal(playback.queued(), 1); assert.equal(h.images(), 1);
  }
});

test('initial native handoff rejects a receipt for another origin, native mapping or grant', async () => {
  for (const mismatch of ['origin', 'native', 'grant']) {
    const h = mobileHistoryEnvironment(), {c, overlay} = h;
    const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
    const selected = {...target(), origin}, supplied = {...target(), origin};
    if (mismatch === 'origin') supplied.origin = {...origin, period: 'month'};
    else if (mismatch === 'native') supplied.native_actions.album_ref = 'local:other';
    else supplied.native_actions.allowed_actions.can_play_album = false;
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => selected,
      retainResource: () => ({target: supplied, isCurrent: () => true})});
    await assert.rejects(owner.resourceIntent('page', selected, {scopeKey: 'actor:A', origin}), {name: 'AbortError'});
    assert.equal(overlay.hidden, true); assert.equal(c.history.state.mobilePages.length, 0);
  }
});

test('a listened Album transfers exact parent authority and retires on source or actual detail replacement', async () => {
  for (const retirement of ['source', 'detail', 'new-detail']) {
    const h = mobileHistoryEnvironment(), {c, document: d} = h;
    const playback = nativePlaybackProbe(c);
    const origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'week', snapshot_ref: 'snapshot:one'};
    const parent = {kind: 'artist', ref: 'catalog-artist:one', origin, allowed_actions: {can_view_details: true}};
    const selected = {...target(), origin}, context = {scopeKey: 'actor:A', origin};
    const detail = {kind: parent.kind, ref: parent.ref, origin, listened_albums: [{detail_target: selected}]};
    let current = true, visible = true;
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: selection => visible && selection.kind === 'artist' ? parent : null,
      retainResource(selection) {return selection.kind === 'artist' ? {target: parent, isCurrent: () => current} : null;}});
    const release = owner.retainArtistAlbums(parent, context, detail);
    await owner.resourceIntent('page', selected, context);
    const play = d.querySelector('.play-track-button'), artwork = d.querySelector('[data-open-lightbox]');
    release({retire: retirement === 'detail'}); visible = false;
    if (retirement !== 'detail') {
      h.click(play); c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
      assert.equal(playback.plays(), 1); assert.equal(h.images(), 1);
      if (retirement === 'source') current = false;
      else {visible = true; owner.retainArtistAlbums(parent, context, {...detail, listened_albums: []});}
    }
    const prior = retirement === 'detail' ? 0 : 1;
    c.activateSharedTrackButton(play); c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
    assert.equal(playback.plays(), prior); assert.equal(playback.queued(), prior); assert.equal(h.images(), prior);
  }
});

test('unsupported mobile source replay reports unavailable rather than opening an unrestricted Album', async () => {
  const h = mobileHistoryEnvironment(), {c, overlay} = h;
  const supplied = target(); Object.assign(supplied.native_actions.allowed_actions, {can_view_artwork: false, can_play_album: false});
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  await owner.resourceIntent('page', supplied, {scopeKey: 'actor:A'});
  const entry = h.entries[1].state.mobilePages[0];
  assert.ok(entry.sourcePageToken); assert.equal(overlay.hidden, false);
  assert.doesNotMatch(JSON.stringify(h.entries[1].state), /can_play_album|can_view_artwork|allowed_actions|presentationRestrictions/);
  h.traverse(-1); assert.equal(overlay.hidden, true); assert.equal(c.getTrackModalSourcePageOwner(), null);
  h.traverse(1); await h.flushSource(); assert.equal(overlay.hidden, true); assert.equal(c.state.modalReleases.length, 0);
  assert.equal(c.history.state.mobilePages.length, 0); assert.equal(c.location.searchParams.has('mobile_page'), false);
  assert.equal(h.returns(), 2); assert.match(h.notices.at(-1), /unavailable from its original source/);
});

test('mobile replay rejects revoked sources and a different actor at the same Album key', async () => {
  for (const newActor of [false, true]) {
    const h = mobileHistoryEnvironment(), {c, overlay, raw} = h;
    let actor = 'A', readable = true;
    const supplied = target(); supplied.native_actions.allowed_actions.can_play_album = false;
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => actor === 'A' && readable ? supplied : null});
    await owner.resourceIntent('page', supplied, {scopeKey: 'actor:A'});
    const token = c.history.state.mobilePages[0].sourcePageToken;
    if (newActor) {
      actor = 'B'; c.openTrackModal(raw);
      assert.equal(c.history.state.mobilePages[0].sourcePageToken, undefined);
      h.traverse(-1);
    } else {
      readable = false; c.handleMobilePagePopState();
    }
    await h.flushSource();
    assert.equal(overlay.hidden, true); assert.equal(c.state.modalReleases.length, 0);
    assert.equal(c.history.state.mobilePages.length, 0);
    assert.equal(c.isTrackModalSourcePageCurrent(token, 'local:one'), false);
  }
});

test('unrelated ordinary mobile Album history still restores through its native owner', () => {
  const h = mobileHistoryEnvironment(), {c, raw, overlay} = h;
  c.openTrackModal(raw);
  assert.equal(c.history.state.mobilePages[0].sourcePageToken, undefined);
  h.traverse(-1); assert.equal(overlay.hidden, true);
  h.traverse(1); assert.equal(overlay.hidden, false);
  assertCurrentNativeRelease(c, raw);
  assert.equal(c.getTrackModalPresentationRestrictions().can_play_album, true);
});

test('actual responsive promotion preserves source restrictions and does not promote a page-denied desktop modal', async () => {
  for (const pageDenied of [false, true]) {
    const h = mobileHistoryEnvironment(), {c, overlay} = h;
    c.innerWidth = 1280;
    const supplied = target(); Object.assign(supplied.native_actions.allowed_actions,
      {can_open_album_page: !pageDenied, can_view_artwork: false, can_play_album: false});
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
    await owner.resourceIntent('open', supplied, {scopeKey: 'actor:A'});
    const token = c.getTrackModalSourcePageToken();
    assert.equal(c.history.state.mobilePages.length, 0); assert.equal(overlay.hidden, false);
    c.innerWidth = 390; c.promoteVisibleMobileDialogs();
    assert.equal(overlay.classList.contains('is-mobile-page'), !pageDenied);
    assert.equal(c.history.state.mobilePages.length, pageDenied ? 0 : 1);
    if (!pageDenied) assert.equal(c.history.state.mobilePages[0].sourcePageToken, token);
    assert.equal(c.getTrackModalPresentationRestrictions().can_view_artwork, false);
    assert.equal(c.getTrackModalPresentationRestrictions().can_play_album, false);
  }
});

test('ordinary visible desktop Album modals still promote through the actual responsive owner', () => {
  const h = mobileHistoryEnvironment(), {c, overlay, raw} = h;
  c.innerWidth = 1280; c.openTrackModal(raw);
  assert.equal(c.history.state.mobilePages.length, 0);
  c.innerWidth = 390; c.promoteVisibleMobileDialogs();
  assert.equal(overlay.classList.contains('is-mobile-page'), true);
  assert.equal(c.history.state.mobilePages.length, 1);
  assert.equal(c.history.state.mobilePages[0].sourcePageToken, undefined);
});

test('a prior native page stack cannot promote a new page-denied source modal on narrowing', async () => {
  const h = mobileHistoryEnvironment(), {c, overlay, raw, document: d} = h;
  c.openTrackModal(raw);
  assert.equal(overlay.classList.contains('is-mobile-page'), true);
  c.innerWidth = 1280; c.syncMobilePageShell();
  const supplied = target(); supplied.native_actions.allowed_actions.can_open_album_page = false;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => supplied});
  await owner.resourceIntent('open', supplied, {scopeKey: 'actor:A'});
  c.innerWidth = 390; c.promoteVisibleMobileDialogs(); c.syncMobilePageShell();
  assert.equal(overlay.classList.contains('is-mobile-page'), false);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.querySelector('.track-modal-dialog').getAttribute('role'), 'dialog');
  assert.equal(d.getElementById('mobile-page-outlet').hidden, true);
});

test('supported source Forward freshly revalidates under the original scope and preserves restrictive native flags', async () => {
  const h = mobileHistoryEnvironment(), {c, overlay, raw} = h;
  const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  const selected = {...target(), origin};
  Object.assign(selected.native_actions.allowed_actions, {can_view_artwork: false, can_play_album: false});
  let visible = true, actor = 'A', reads = 0; const lifecycle = new AbortController();
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => visible && actor === 'A' ? selected : null,
    async revalidateResource(selection, context, {signal}) {
      reads++; assert.equal(selection.ref, selected.ref); assert.equal(context.scopeKey, 'actor:A');
      assert.notEqual(signal, lifecycle.signal); assert.equal(signal.aborted, false);
      if (actor !== 'A') throw Object.assign(new Error('Denied'), {status: 403});
      const target = {...selected, native_actions: {album_ref: 'local:one', allowed_actions: {can_open_album: true, can_view_artwork: true, can_play_album: true}}};
      return {target, isCurrent: () => actor === 'A' && !signal.aborted};
    }});
  await owner.resourceIntent('page', selected, {scopeKey: 'actor:A', origin, signal: lifecycle.signal});
  const token = c.history.state.mobilePages[0].sourcePageToken;
  lifecycle.abort(); visible = false;
  assert.equal(overlay.hidden, false, 'intentional source retirement does not close the accepted native page');
  assert.equal(c.getTrackModalPresentationRestrictions().can_play_album, false);
  h.traverse(-1);
  h.traverse(1); await h.flushSource();
  assert.equal(reads, 1); assert.equal(overlay.hidden, false); assertCurrentNativeRelease(c, raw);
  assert.equal(c.history.state.mobilePages[0].sourcePageToken, token);
  assert.equal(c.getTrackModalPresentationRestrictions().can_view_artwork, false);
  assert.equal(c.getTrackModalPresentationRestrictions().can_play_album, false);
  assert.deepEqual(h.notices, []);
  h.traverse(-1); actor = 'B'; h.traverse(1); await h.flushSource();
  assert.equal(overlay.hidden, true); assert.match(h.notices.at(-1), /unavailable/);
});

test('native Play and artwork recheck the replay receipt after its source, scope or signal retires', async () => {
  for (const retirement of ['source', 'scope', 'signal']) {
    const h = mobileHistoryEnvironment(), {c, document: d, overlay, raw} = h;
    const playback = nativePlaybackProbe(c);
    const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
    const selected = {...target(), origin};
    const sourceLifetime = new AbortController();
    let epoch = 0, scope = 'actor:A';
    const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => selected,
      async revalidateResource(selection, context, {signal}) {
        const readEpoch = epoch;
        return {target: selected, isCurrent: () => epoch === readEpoch && scope === context.scopeKey
          && !signal.aborted && !sourceLifetime.signal.aborted};
      }});
    await owner.resourceIntent('page', selected, {scopeKey: scope, origin});
    h.traverse(-1); h.traverse(1); await h.flushSource();
    const play = d.querySelector('.play-track-button'), artwork = d.querySelector('[data-open-lightbox]');
    assert.ok(artwork); assert.equal(play.disabled, false);
    h.click(play); c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
    assert.equal(playback.plays(), 1); assert.equal(playback.queued(), 1); assert.equal(h.images(), 1);
    if (retirement === 'source') epoch++;
    else if (retirement === 'scope') scope = 'actor:B';
    else sourceLifetime.abort();
    assert.equal(overlay.hidden, false, 'action retirement does not depend on a redraw or popstate');
    c.activateSharedTrackButton(play);
    c.handleGalleryBootstrapClick({target: artwork, preventDefault() {}});
    assert.equal(playback.plays(), 1); assert.equal(playback.queued(), 1); assert.equal(h.images(), 1);
    c.renderTrackModalRelease(raw);
    assert.equal(d.querySelector('.play-track-button').disabled, true);
    assert.equal(d.querySelector('[data-open-lightbox]'), null);
    const galleryArt = d.createElement('button');
    galleryArt.setAttribute('data-open-lightbox', '1'); galleryArt.setAttribute('data-cover-src', '/gallery-art');
    d.body.appendChild(galleryArt);
    c.handleGalleryBootstrapClick({target: galleryArt, preventDefault() {}});
    assert.equal(h.images(), 2, 'unrelated Gallery artwork retains its existing owner');
    c.openTrackModal(raw);
    h.click(d.querySelector('.play-track-button'));
    c.handleGalleryBootstrapClick({target: d.querySelector('[data-open-lightbox]'), preventDefault() {}});
    assert.equal(playback.plays(), 2); assert.equal(playback.queued(), 2); assert.equal(h.images(), 3);
  }
});

test('an in-flight source replay cannot reopen after the user leaves its history entry', async () => {
  const h = mobileHistoryEnvironment(), {c, overlay} = h, pending = deferred();
  const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  const selected = {...target(), origin}; let signal;
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => selected,
    revalidateResource(selection, context, options) {signal = options.signal; return pending.promise;}});
  await owner.resourceIntent('page', selected, {scopeKey: 'actor:A', origin});
  h.traverse(-1); h.traverse(1); const replay = h.flushSource();
  h.traverse(-1); assert.equal(signal.aborted, true);
  pending.resolve({target: selected, isCurrent: () => true}); await replay;
  assert.equal(overlay.hidden, true); assert.equal(c.state.modalReleases.length, 0);
  assert.equal(c.history.state.mobilePages.length, 0); assert.deepEqual(h.notices, []);
});

test('a newer ordinary modal wins over pending source replay without an unavailable navigation rewrite', async () => {
  const h = mobileHistoryEnvironment(), {c} = h, pending = deferred();
  const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  const selected = {...target(), origin};
  const owner = c.AlbumHavenResourceSelection.create({sourceResource: () => selected,
    revalidateResource() {return pending.promise;}});
  await owner.resourceIntent('page', selected, {scopeKey: 'actor:A', origin});
  h.traverse(-1); h.traverse(1); const replay = h.flushSource();
  c.innerWidth = 1280;
  const replacement = {key: 'local:new-actor', name: 'New native action', tracks: []};
  c.openTrackModal(replacement);
  pending.resolve({target: selected, isCurrent: () => true}); await replay;
  assertCurrentNativeRelease(c, replacement); assert.deepEqual(h.notices, []);
});

test('a rejected acquisition cannot retire a currently owned native pane', () => {
  const {c, host} = environment(), album = {key: 'local:one', tracks: []};
  const lease = c.acquireTrackModalSelection(host, album, {isCurrent: () => true});
  assert.equal(c.acquireTrackModalSelection(host, album, {isCurrent: () => false}), null);
  assert.equal(c.getTrackModalSelectionLease(), lease); assert.equal(host.firstElementChild, lease.dialog);
  lease.release();
});
