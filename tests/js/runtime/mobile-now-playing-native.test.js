'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {fixture, settle} = require('./home-friends-native-app-fixture.cjs');
const root = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../../..'));
const file = 'music_app/static/js/runtime/mobile-navigation.js';
const source = fs.readFileSync(path.join(root, file), 'utf8');

// Load the WHOLE real classic source, not extracted/reimplemented functions.
// The page presenter is a test boundary here; native-history integration below
// is a source contract, not a claim that a browser traversal was exercised.
function setup(t) {
  const h = fixture(t), {c, document} = h, calls = [], token = {};
  const current = {path: 'fixture-track', inventory_track_ref: 'inventory-track:5:7', title: 'Song', artist: 'Artist', album: 'Album', coverPath: 'fixture-art'};
  const row = {...current, track_ref: 'fixture-ref', track_preference: {love_tier: 'off', rating: null, allowed_actions: {can_set_love_tier: true}}};
  const album = {tracks: [row], year: 2020};
  const player = h.add('player'), timelineHost = document.createElement('div'), timeline = document.createElement('input');
  player.className = 'global-player'; timelineHost.append(timeline); player.append(timelineHost);
  const compact = {previous: {disabled: false}, next: {disabled: false}};
  let scopeListener = null, resolutions = 0;
  c.innerWidth = 390;
  let locked = false, scope = token, choice, snapshot = {currentTime: 12, paused: false};
  Object.assign(c, {AbortController, PrivateUITransport: {subscribe(listener) {scopeListener = listener; return () => {scopeListener = null;};}}, state: {player: {current}}, getPlayerElements: () => ({player, timeline}), isPlaybackLockedByAnotherTab: () => locked,
    getPlayerPlaybackSnapshot: () => snapshot, getPlayerDuration: () => 120,
    formatLoopTime: n => String(n), resolveAlbumForPlayerTrack: () => {resolutions++; return album;},
    compactPlayerElements: () => compact,
    setPlayerPlaybackHead: value => calls.push(['seek', value]), togglePlayerPlayback: () => calls.push(['toggle']),
    playCompactQueueOffset: offset => calls.push(['skip', offset]), openImageLightbox: (...args) => calls.push(['art', ...args]),
    showToast: (...args) => calls.push(['toast', ...args]),
    TrackActionsRuntime: {scope: () => ({token: scope}), preference: value => value.track_preference,
      setLove: async value => {calls.push(['love', value.love_tier]); row.track_preference.love_tier = value.love_tier;}},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime/playback-control-cluster.js'), 'utf8'), c);
  c.renderGlobalPlayerPlayGlyph = (button, paused) => {button.innerHTML = c.ButtonComponent.renderIconSvg(paused ? 'play' : 'pause');};
  vm.runInContext(source, c, {filename: file});
  const nativeDismiss = c.dismissMobilePage;
  c.presentMobilePage = descriptor => {calls.push(['present', JSON.parse(JSON.stringify(descriptor))]); c.descriptor = descriptor;
    vm.runInContext('mobilePageState.pages = [descriptor]', c); const surface = document.getElementById('mobile-now-playing'); surface.hidden = false; return true;};
  c.dismissMobilePage = kind => {calls.push(['dismiss', kind]); vm.runInContext('mobilePageState.pages = []', c); c.retireMobileNowPlaying();};
  c.openUtilityChoiceDropdown = (_anchor, options) => {choice = options; return {close() {calls.push(['close-choice']);}};};
  const open = () => c.openMobileNowPlaying();
  const paint = () => vm.runInContext('mobileNowPlayingOwner?.refresh()', c);
  const stop = () => c.retireMobileNowPlaying();
  const button = label => document.getElementById('mobile-now-playing').querySelectorAll('button').find(node => node.getAttribute('aria-label') === label);
  const click = node => node.dispatchEvent(new c.Event('click', {bubbles: true}));
  const tick = () => {const pending = [...h.timers.values()]; h.timers.clear(); for (const fn of pending) fn();};
  h.own({dispose: stop});
  return {...h, nativeDismiss, calls, current, row, album, player, timelineHost, timeline, compact, open, paint, stop, button, click, tick,
    choice: () => choice, setLocked: value => {locked = value;}, setMobile: value => {c.innerWidth = value ? 390 : 1200;}, setScope: value => {scope = value;}, emitScope: () => scopeListener?.(), hasScopeListener: () => Boolean(scopeListener), resolutions: () => resolutions};
}

test('open and close are presentation-only and descriptor never contains private track data', t => {
  const h = setup(t); assert.equal(h.open(), true);
  assert.deepEqual(h.calls, [['present', {kind: 'now-playing', albumKey: '', title: 'Now Playing', subtitle: ''}]]);
  h.click(h.button('Close Now Playing')); assert.deepEqual(h.calls.map(x => x[0]), ['present', 'dismiss']);
  assert.equal(h.c.state.player.current, h.current); assert.equal(h.timers.size, 0);
});
test('player body opens once while controls and all excluded targets retain their owners', t => {
  const h = setup(t); h.c.initMobileNowPlaying(); h.c.initMobileNowPlaying();
  for (const [tag, id] of [['button', ''], ['a', ''], ['span', 'player-artist'], ['span', 'player-album-link'], ['span', 'player-cover-button']]) {
    const node = h.document.createElement(tag); node.id = id; h.player.append(node); h.click(node);
  }
  h.click(h.timeline); assert.equal(h.calls.length, 0); h.click(h.player); assert.equal(h.calls.length, 1);
});
test('desktop and other-tab playback cannot open the mobile view', t => {
  const h = setup(t); h.setMobile(false); assert.equal(h.open(), false); h.setMobile(true); h.setLocked(true); assert.equal(h.open(), false); assert.equal(h.calls.length, 0);
});
test('metadata order, year, elapsed duration and native transport delegation', t => {
  const h = setup(t); h.open(); const surface = h.document.getElementById('mobile-now-playing');
  assert.equal(surface.querySelector('.mobile-now-playing__artist').textContent, 'Artist');
  assert.equal(surface.querySelector('.mobile-now-playing__album').textContent, 'Album · 2020');
  assert.equal(surface.querySelector('.mobile-now-playing__title').textContent, 'Song');
  assert.equal(surface.querySelector('.mobile-now-playing__times').textContent, '12120');
  h.click(h.button('Previous track')); h.click(h.button('Pause')); h.click(h.button('Next track'));
  assert.deepEqual(h.calls.slice(1), [['skip', -1], ['toggle'], ['skip', 1]]);
});
test('seek delegates only the same captured current track and never changes listening metadata', t => {
  const h = setup(t); h.open(); const seek = h.document.querySelector('.mobile-now-playing__seek');
  seek.dispatchEvent(new h.c.Event('pointerdown')); seek.value = '40'; seek.dispatchEvent(new h.c.Event('input'));
  assert.deepEqual(h.calls.at(-1), ['seek', 40]); h.c.state.player.current = {...h.current};
  seek.value = '60'; seek.dispatchEvent(new h.c.Event('input')); assert.equal(h.calls.filter(x => x[0] === 'seek').length, 1);
});
test('Love uses native choice signature and existing account preference authority', async t => {
  const h = setup(t); h.open(); h.click(h.button('Love')); const choice = h.choice();
  assert.equal(choice.selected, 'off'); assert.deepEqual(Array.from(choice.formats, x => x.value), ['off', 'loved', 'obsessed']);
  choice.onSelect('loved'); await settle(); assert.deepEqual(h.calls.find(x => x[0] === 'love'), ['love', 'loved']);
});
test('stale Love menu cannot act on the successor track', async t => {
  const h = setup(t); h.open(); h.click(h.button('Love')); const choice = h.choice(); h.c.state.player.current = {...h.current};
  choice.onSelect('obsessed'); await settle(); assert.equal(h.calls.some(x => x[0] === 'love'), false);
});
test('missing native source disables taste and playlist instead of inventing identity or permission', t => {
  const h = setup(t); h.album.tracks = []; h.open(); assert.equal(h.button('Love').disabled, true); assert.equal(h.button('Add to playlist').disabled, true);
});
test('scope change retires timers and presentation without stopping or restarting audio', t => {
  const h = setup(t); h.open(); h.setScope({}); h.tick();
  assert.equal(h.document.getElementById('mobile-now-playing').hidden, true); assert.equal(h.timers.size, 0);
  assert.equal(h.calls.some(x => ['toggle', 'skip', 'seek'].includes(x[0])), false);
});
test('retirement and reopening keep one view and bounded polling owner', t => {
  const h = setup(t); h.open(); h.stop(); assert.equal(h.timers.size, 0); h.open(); assert.equal(h.timers.size, 1);
  assert.equal(h.document.querySelectorAll('#mobile-now-playing').length, 1);
});
test('native history and breakpoint seams retain presentation-only integration', () => {
  assert.match(source, /'now-playing': 'mobile-now-playing'/);
  assert.match(source, /if \(descriptor.kind === 'now-playing'\) return openMobileNowPlaying\(\)/);
  assert.match(source, /if \(descriptor.kind === 'now-playing'\) retireMobileNowPlaying\(\)/);
  assert.match(source, /kind === 'now-playing' \? !mobile \|\| kind !== active\?\.kind/);
  assert.match(source, /initMobileNowPlaying\(\);/);
});
test('theme, upward transition and reduced motion are scoped to native presentation', () => {
  const css = fs.readFileSync(path.join(root, 'music_app/static/css/mobile-layout.css'), 'utf8');
  assert.match(css, /\.mobile-now-playing\.is-mobile-page/); assert.match(css, /var\(--text\)/);
  assert.match(css, /@keyframes mobile-now-playing-enter/); assert.match(css, /prefers-reduced-motion: reduce/);
});

for (const mutation of ['path', 'inventory', 'source', 'permission']) test('in-place native '+mutation+' change invalidates captured Love menu before refresh', async t => {
  const h = setup(t); h.open(); h.click(h.button('Love')); const choice = h.choice();
  if (mutation === 'path') h.current.path = 'replacement';
  if (mutation === 'inventory') h.current.inventory_track_ref = 'inventory-track:5:9';
  if (mutation === 'source') h.album.tracks = [{...h.row}];
  if (mutation === 'permission') h.row.track_preference.allowed_actions.can_set_love_tier = false;
  choice.onSelect('obsessed'); await settle(); assert.equal(h.calls.some(x => x[0] === 'love'), false);
  h.paint(); assert.ok(h.calls.some(x => x[0] === 'close-choice'));
});
test('polling does not overwrite an actively manipulated seek value', t => {
  const h = setup(t); h.open(); const seek = h.document.querySelector('.mobile-now-playing__seek');
  seek.dispatchEvent(new h.c.Event('pointerdown')); seek.value = '37'; h.paint(); assert.equal(seek.value, '37');
  h.document.dispatchEvent(new h.c.Event('pointerup')); h.paint(); assert.equal(seek.value, '12');
});
test('scope retirement delegates dismissal of the history descriptor as well as the visual owner', t => {
  const h = setup(t); h.open(); h.setScope({}); h.tick();
  assert.ok(h.calls.some(x => x[0] === 'dismiss' && x[1] === 'now-playing'));
  assert.equal(vm.runInContext('mobilePageState.pages.length', h.c), 0);
});

test('transport scope invalidation scrubs private presentation before the polling timer', t => {
  const h = setup(t); h.open(); assert.equal(h.hasScopeListener(), true); h.setScope({}); h.emitScope();
  assert.equal(h.document.getElementById('mobile-now-playing').textContent, '');
  assert.equal(h.document.getElementById('mobile-now-playing').hidden, true);
  assert.equal(h.timers.size, 0); assert.equal(h.hasScopeListener(), false);
  assert.equal(vm.runInContext('mobilePageState.pages.length', h.c), 0);
});

test('playlist menu delegates an opaque single-row packet to genuine native source and picker boundaries', t => {
  const h = setup(t); let menu, input, opened, disposed = 0;
  h.c.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'fixture-scope'})};
  h.c.createPrivatePlaytableSource = options => {input = options; return {snapshot: () => ({scopeKey: options.scopeKey}), dispose() {disposed++;}};};
  h.c.AlbumHavenPlaytableUI = {actions(_anchor, value) {menu = value; return {dispose() {}};},
    open(...args) {opened = args; return true;}};
  h.open(); h.click(h.button('Add to playlist')); assert.equal(menu.formats[0].value, 'add');
  assert.equal(menu.onSelect('add'), true); assert.equal(input.resolveRow(), h.row);
  assert.equal(opened[0].row_keys.length, 1); assert.equal(JSON.stringify(opened[0]).includes('fixture-track'), false);
  assert.equal(opened[1].isCurrent(), true); h.current.path = 'changed-in-place';
  assert.equal(opened[1].isCurrent(), false); h.paint(); assert.equal(disposed, 1);
});
test('scope marker observer provides a pre-paint fallback without a timer tick', t => {
  const h = setup(t); h.open(); const observer = h.observers.at(-1); h.setScope({}); observer.callback([]);
  assert.equal(h.document.getElementById('mobile-now-playing').hidden, true);
  assert.equal(h.timers.size, 0); assert.equal(observer.connected, false);
});

test('progress polling uses the retained album cache while action authorization resolves the native owner again', t => {
  const h = setup(t); h.open(); const reads = h.resolutions(); h.tick(); h.tick(); assert.equal(h.resolutions(), reads);
  h.click(h.button('Love')); h.choice().onSelect('loved'); assert.ok(h.resolutions() > reads);
});


test('pure progress ticks do not enumerate album tracks and hidden views do not repaint', t => {
  const h = setup(t); h.open(); const surface = h.document.getElementById('mobile-now-playing');
  Object.defineProperty(h.album, 'tracks', {configurable: true, get() {throw new Error('Unexpected album enumeration');}});
  h.tick(); h.tick();
  surface.hidden = true; h.current.title = 'Hidden replacement'; h.tick();
  assert.equal(surface.querySelector('.mobile-now-playing__title').textContent, 'Song');
});

// Actual whole-file dismissMobilePage + handleMobilePagePopState + cleanupMobilePage
// run here. Only gallery repaint/history-writing boundaries are inert; history.go
// deliberately does not mutate state until commit(), matching delayed popstate.
function delayedHistory(h, parentPosition = 0) {
  h.c.dismissMobilePage = h.nativeDismiss;
  h.c.syncMobilePageShell = () => {};
  h.c.restoreMobileGalleryParent = () => {};
  h.c.writeMobilePageHistory = () => true;
  h.c.history.state = {albumHavenNavigationPosition: 1, mobilePages: []};
  h.c.history.go = delta => h.calls.push(['go', delta]);
  h.open(); h.c.descriptor.parentPosition = parentPosition;
  return () => {
    h.c.history.state = {albumHavenNavigationPosition: 0, mobilePages: []};
    return h.c.handleMobilePagePopState();
  };
}
test('delayed native pop blocks scope successor until exact descriptor cleanup commits', t => {
  const h = setup(t), commit = delayedHistory(h); const descriptor = h.c.descriptor;
  h.setScope({}); h.emitScope();
  assert.equal(h.open(), false); assert.equal(h.timers.size, 0);
  assert.equal(h.c.dismissMobilePage('now-playing'), true);
  assert.equal(h.calls.filter(x => x[0] === 'go').length, 1);
  assert.deepEqual(Object.keys(descriptor).sort(), ['albumKey', 'kind', 'parentPosition', 'subtitle', 'title']);
  assert.equal(commit(), true); assert.equal(h.open(), true); assert.equal(h.timers.size, 1);
  assert.equal(h.calls.some(x => ['toggle', 'skip', 'seek'].includes(x[0])), false);
});
test('native history go throw releases pending dismissal and does not block reopen', t => {
  const h = setup(t); delayedHistory(h);
  h.c.history.go = () => {throw new Error('fixture traversal rejection');};
  assert.throws(() => h.c.dismissMobilePage('now-playing'), /fixture traversal rejection/);
  assert.equal(h.open(), true); assert.equal(h.timers.size, 1);
});
test('native no-delta dismissal cleans synchronously and allows a fresh owner', t => {
  const h = setup(t); delayedHistory(h, null);
  assert.equal(h.c.dismissMobilePage('now-playing'), true);
  assert.equal(h.timers.size, 0); assert.equal(h.hasScopeListener(), false);
  assert.equal(h.calls.some(x => x[0] === 'go'), false);
  assert.equal(h.open(), true); assert.equal(h.timers.size, 1);
});
test('presenter throw disposes newly created timer and scope subscription', t => {
  const h = setup(t); h.c.presentMobilePage = () => {throw new Error('fixture presenter rejection');};
  assert.equal(h.open(), false); assert.equal(h.timers.size, 0); assert.equal(h.hasScopeListener(), false);
  assert.equal(h.document.getElementById('mobile-now-playing').hidden, true);
});
test('older presenter throw cannot dispose a reentrant successor owner', t => {
  const h = setup(t), present = h.c.presentMobilePage;
  h.c.presentMobilePage = () => {
    h.stop(); h.c.presentMobilePage = present; assert.equal(h.open(), true);
    throw new Error('old presenter rejection');
  };
  assert.equal(h.open(), false); assert.equal(h.timers.size, 1); assert.equal(h.hasScopeListener(), true);
  assert.equal(h.document.getElementById('mobile-now-playing').hidden, false);
});
