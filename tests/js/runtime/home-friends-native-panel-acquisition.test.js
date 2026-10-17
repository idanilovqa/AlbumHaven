'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture, load, deferred, settle} = require('./home-friends-native-app-fixture.cjs');
const runtimeBase = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const track = id => ({id, kind: 'track', title: id, artist: 'Artist', album_title: 'Album', availability: 'local',
  source_readable: true, listen_count: 1, duration_seconds: 123, rating: 4, taste_state: 'available', love_tier: 'off'});
const activityProps = value => ({scopeKey: 'scope:first', kind: 'tracks', period: 'week', view: 'rows', value,
  selectedTrackIds: [], onTracksSelect() {}});
const visibleStatuses = host => host.querySelectorAll('[role="status"],[role="alert"]').filter(node => !node.closest('[hidden],[inert]')).map(node => node.textContent.trim()).filter(Boolean);
const mediaCount = h => [...h.media.values()].reduce((count, media) => count + media.listeners.size, 0);

// Use the actual controller, private source, queue planner, DOM controls,
// selection and presentation implementations. Instrument only native platform
// resource lifetimes and transport seams; do not replace panel factories.
function panelFixture(t) {
  const h = fixture(t), sources = [], observers = [], playback = new Set(), preferences = new Set(), releases = {playback: 0, preferences: 0};
  h.c.TrackActionsRuntime = {scope: () => ({token: 'native-acquisition-session', actor: '4', library: '5'})};
  for (const file of ['playtable-source.js', 'explicit-queue-planner.js']) vm.runInContext(fs.readFileSync(path.join(runtimeBase, file), 'utf8'), h.c, {filename: file});
  for (const key of ['ResizeObserver', 'MutationObserver']) h.c[key] = class {
    constructor(callback) {this.callback = callback; this.active = false; this.disconnections = 0; observers.push(this);}
    observe() {this.active = true;}
    disconnect() {this.active = false; this.disconnections++;}
  };
  Object.assign(h.runtime, {
    snapshot: () => ({scopeKey: 'scope:first'}),
    createPlaytableSource(options) {
      const native = h.c.createPrivatePlaytableSource({...options, scopeKey: options.context.scopeKey,
        resolveRow: row => ({inventory_track_ref: `inventory-track:5:${options.rows.indexOf(row) + 1}`, source_readable: true})});
      const record = {native, releases: 0, subscriptions: 0, unsubscribes: 0}; sources.push(record);
      return {...native, subscribe(listener) {record.subscriptions++; const release = native.subscribe(listener); return () => {record.unsubscribes++; release();};},
        dispose() {record.releases++; native.dispose();}};
    },
    openPlaylistAction: () => true,
    trackPreference: row => ({identity: `love:${row.id}`, love_tier: 'off', rating: 4, allowed_actions: {can_set_love_tier: true}}),
    setTrackLove: async () => null,
    subscribeTrackPlayback(listener) {playback.add(listener); return () => {releases.playback++; playback.delete(listener);};},
    subscribeTrackPreferences(listener) {preferences.add(listener); return () => {releases.preferences++; preferences.delete(listener); throw new Error('secondary preference cleanup');};},
  });
  return {...h, sources, observers, playback, preferences, releases};
}
async function activityValue(t) {
  const {createHomeFriendsController} = await load('model.mjs');
  const controller = createHomeFriendsController({providers: {readActivity: async () => ({rows: [track('one'), track('two')]})}});
  t.after(() => controller.dispose()); controller.setScope('scope:first'); await controller.loadActivity({kind: 'tracks', period: 'week'});
  const value = controller.getSnapshot().activity; assert.equal(value.status, 'ready'); return value;
}
function queueFixture(h) {
  const planner = h.c.createExplicitQueuePlanner({canPlay: () => true}), ids = Array.from(planner.enqueue(['track:one', 'track:two']));
  const listeners = new Set(), preferences = new Set(), refreshes = [], releases = {queue: 0, preference: 0};
  let cachedPlanner, cached;
  const getSnapshot = () => {const snapshot = planner.getSnapshot(); if (cachedPlanner !== snapshot) {cachedPlanner = snapshot; cached = Object.freeze({enabled: snapshot.enabled, revision: snapshot.revision,
    entries: Object.freeze(Array.from(snapshot.entries, entry => Object.freeze({id: entry.id, title: entry.trackId, artist: 'Artist', album: 'Album', sourceReadable: true,
      canPlay: true, timing: entry.timing, current: entry.id === snapshot.currentId, duration_seconds: 123})))});} return cached;};
  const pending = deferred();
  const api = {getSnapshot, timingOptions: () => planner.timingOptions(null), refresh(options) {refreshes.push(options); return pending.promise;},
    subscribe(listener) {listeners.add(listener); return () => {releases.queue++; listeners.delete(listener);};},
    trackPreference: h.runtime.trackPreference, setTrackLove: h.runtime.setTrackLove,
    subscribeTrackPreferences(listener) {preferences.add(listener); return () => {releases.preference++; preferences.delete(listener); throw new Error('secondary queue preference cleanup');};}};
  return {api, ids, getSnapshot, listeners, preferences, refreshes, releases, pending};
}

for (const kind of ['activity', 'queue']) test(`actual ${kind} late columns renderer failure unwinds preferences, selection and presentation`, async t => {
  const h = panelFixture(t), failure = new Error(`${kind} columns render failed`), baseline = h.listeners().length;
  const action = h.runtime.actionHtml; let retained = [], queued, value;
  h.runtime.actionHtml = options => {
    if (options.label === 'Track columns') {retained = h.host.querySelectorAll('button'); assert.ok(h.observers.some(observer => observer.active), 'real presentation acquired before late fault'); throw failure;}
    return action(options);
  };
  if (kind === 'activity') {
    const {mountActivityPanel} = await load('activity.mjs'); value = await activityValue(t);
    assert.throws(() => mountActivityPanel(h.host, h.runtime, activityProps(value)), error => error === failure);
    assert.equal(h.sources.length, 1); assert.equal(h.sources[0].releases, 1); assert.equal(h.sources[0].native.snapshot(), null);
    assert.equal(h.sources[0].unsubscribes, h.sources[0].subscriptions); assert.ok(h.sources[0].subscriptions > 0);
    assert.equal(h.releases.playback, 1); assert.equal(h.releases.preferences, 1); assert.equal(h.playback.size, 0); assert.equal(h.preferences.size, 0);
  } else {
    const {mountQueuePanel} = await load('queue.mjs'); queued = queueFixture(h);
    assert.throws(() => mountQueuePanel(h.host, h.runtime, {api: queued.api, value: queued.getSnapshot(), scopeKey: 'scope:first', selectedIds: []}), error => error === failure);
    assert.equal(queued.listeners.size, 0); assert.equal(queued.preferences.size, 0); assert.equal(queued.releases.preference, 1); assert.ok(queued.releases.queue > 0);
    assert.equal(queued.refreshes.length, 1); assert.equal(queued.refreshes[0].signal.aborted, true);
    queued.pending.resolve(queued.getSnapshot());
  }
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.listeners().length, baseline, 'all real control and document listeners released despite secondary cleanup failure');
  assert.ok(h.observers.length > 0); for (const observer of h.observers) {assert.equal(observer.active, false); assert.equal(observer.disconnections, 1); observer.callback();}
  retained.forEach(button => h.click(button)); await settle(); h.drain(); assert.equal(h.host.childNodes.length, 0); assert.equal(h.listeners().length, baseline);
});

async function comparisonValue(t, {empty = false} = {}) {
  const {createHomeFriendsController} = await load('model.mjs');
  const controller = createHomeFriendsController({providers: {
    readFriends: async () => ({profile: {display_name: 'Me', handle: 'me', allowed_actions: {}}, friends: [{account_ref: 'friend:one', display_name: 'Friend', handle: 'friend',
      relationship: 'accepted', allowed_actions: {can_compare: true}}], requests: [], allowed_actions: {}}),
    readComparison: async () => ({rows: empty ? [] : [{id: 'album:one', kind: 'album', title: 'Shared album', artist: 'Artist',
      yours: {listen_count: 2, play_count: 1, full_listen_count: 1, rating: 8}, friend: {listen_count: 3, play_count: 1, full_listen_count: 1, rating: 7}}]}),
  }});
  t.after(() => controller.dispose()); controller.setScope('scope:first'); await controller.loadFriends(); assert.equal(controller.selectFriend('friend:one'), true);
  await controller.loadComparison({kind: 'albums', period: 'week'}); const value = controller.getSnapshot().comparison; assert.equal(value.status, empty ? 'empty' : 'ready'); return value;
}
const comparisonProps = (value, extra = {}) => ({friendRef: 'friend:one', friendName: 'Friend', kind: 'albums', period: 'week', value,
  presentation: {friendRef: 'friend:one', kind: 'albums', period: 'week', view: 'covers', commonOnly: true}, ...extra});

for (const fault of ['second-card-button', 'second-card-artwork']) test(`actual comparison ${fault} failure retires partially built pair and native chooser`, async t => {
  const h = fixture(t), {mountComparisonPanel} = await load('comparison.mjs'), value = await comparisonValue(t), baseline = h.listeners().length;
  const failure = new Error(fault), renderButton = h.runtime.buttonHtml, renderCard = h.runtime.galleryCardHtml, mountView = h.runtime.mountViewChooser;
  let buttons = 0, cards = 0, destroyed = 0, retained = [];
  h.runtime.mountViewChooser = (element, options) => {const native = mountView(element, options); return {...native, destroy() {destroyed++; native.destroy(); throw new Error('secondary chooser cleanup');}};};
  h.runtime.buttonHtml = options => {if (fault === 'second-card-button' && options.label === 'Details' && ++buttons === 2) {retained = h.host.querySelectorAll('button'); throw failure;} return renderButton(options);};
  h.runtime.galleryCardHtml = options => {if (fault === 'second-card-artwork' && ++cards === 2) {retained = h.host.querySelectorAll('button'); throw failure;} return renderCard(options);};
  assert.throws(() => mountComparisonPanel(h.host, h.runtime, comparisonProps(value)), error => error === failure);
  assert.equal(destroyed, 1); assert.equal(mediaCount(h), 0); assert.equal(h.host.childNodes.length, 0); assert.equal(h.listeners().length, baseline);
  retained.forEach(button => h.click(button)); for (const media of h.media.values()) for (const listener of [...media.listeners]) listener();
  await settle(); h.drain(); assert.equal(h.host.childNodes.length, 0);
});

test('empty comparison shows only its page/filter-specific notice while loading, errors and retry stay visible', async t => {
  const h = fixture(t), {mountComparisonPanel} = await load('comparison.mjs'), {resource} = await load('model.mjs'), value = await comparisonValue(t, {empty: true});
  let retries = 0; const props = extra => comparisonProps(value, {retry: () => retries++, ...extra});
  const owner = h.own(mountComparisonPanel(h.host, h.runtime, props()));
  assert.deepEqual(visibleStatuses(h.host), ['No confirmed shared listens on this page.']);
  // The bounded platform stores input.type without HTML attribute reflection.
  // Verify the actual control property instead of relying on an absent attribute.
  const checkbox = h.host.querySelector('.home-comparison__common input');
  assert.ok(checkbox, 'the real Common only filter exists'); assert.equal(checkbox.type, 'checkbox');
  checkbox.checked = false; checkbox.dispatchEvent(new h.c.Event('change', {bubbles: true}));
  assert.deepEqual(visibleStatuses(h.host), ['No listening activity on this page.']);
  owner.update(props({value: resource('loading')})); assert.deepEqual(visibleStatuses(h.host), ['Loading Taste comparisons…']);
  owner.update(props({value: resource('error')})); assert.deepEqual(visibleStatuses(h.host), ['Taste comparisons could not be loaded.']);
  const retry = h.named('Retry', h.host); assert.ok(retry); h.click(retry); assert.equal(retries, 1);
  owner.update(props()); assert.deepEqual(visibleStatuses(h.host), ['No listening activity on this page.']); assert.equal(h.named('Retry', h.host), undefined);
});

test('comparison rejects a native chooser returned after synchronous parent disposal and publishes nothing afterward', async t => {
  const h = fixture(t), {mountComparisonPanel} = await load('comparison.mjs'), value = await comparisonValue(t), publications = [], selections = [], baseline = h.listeners().length;
  const owner = h.own(mountComparisonPanel(h.host, h.runtime, comparisonProps(value, {kind: 'tracks', onPresentationChange: value => publications.push(value)})));
  const mounted = h.runtime.mountViewChooser; let lateDestroyed = 0, lateSelected = 0;
  h.runtime.mountViewChooser = (element, options) => {const native = mounted(element, options); owner.dispose(); return {...native, select(value) {lateSelected++; native.select(value);}, destroy() {lateDestroyed++; native.destroy();}};};
  const before = publications.length;
  owner.update(comparisonProps(value, {onPresentationChange: value => publications.push(value), onSelection: value => selections.push(value)}));
  assert.equal(lateDestroyed, 1); assert.equal(lateSelected, 0); assert.equal(publications.length, before); assert.deepEqual(selections, []);
  assert.equal(h.host.childNodes.length, 0); assert.equal(mediaCount(h), 0); assert.equal(h.listeners().length, baseline);
  await settle(); owner.update(comparisonProps(value)); assert.equal(h.host.childNodes.length, 0);
});

for (const panel of ['activity', 'queue']) test(`actual ${panel} renderer disposal stops late selection and presentation acquisition`, async t => {
  const h = panelFixture(t), baseline = h.listeners().length;
  // Normal cleanup for this case, so disposal itself does not throw.
  h.runtime.subscribeTrackPreferences = listener => {h.preferences.add(listener); return () => h.preferences.delete(listener);};
  let owner, next, queued;
  if (panel === 'activity') {const {mountActivityPanel} = await load('activity.mjs'); const value = await activityValue(t); next = activityProps(value); owner = h.own(mountActivityPanel(h.host, h.runtime, next));}
  else {const {mountQueuePanel} = await load('queue.mjs'); queued = queueFixture(h); queued.api.subscribeTrackPreferences = listener => {queued.preferences.add(listener); return () => queued.preferences.delete(listener);};
    next = {api: queued.api, value: queued.getSnapshot(), scopeKey: 'scope:first', selectedIds: []}; owner = h.own(mountQueuePanel(h.host, h.runtime, next));
    // A new planner snapshot makes the real queue table renderer run again.
    next = {...next, value: {...next.value, entries: next.value.entries.map(row => ({...row, title: `${row.title} changed`}))}};
  }
  const render = h.runtime.tableHtml, sourceCount = h.sources.length, observerCount = h.observers.length;
  h.runtime.tableHtml = options => {owner.dispose(); return render(options);}; owner.update(next);
  assert.equal(h.sources.length, sourceCount); assert.equal(h.observers.length, observerCount); assert.equal(h.host.childNodes.length, 0); assert.equal(h.listeners().length, baseline);
  assert.equal(h.preferences.size, 0); if (queued) {assert.equal(queued.listeners.size, 0); assert.equal(queued.preferences.size, 0); assert.equal(queued.refreshes[0].signal.aborted, true); queued.pending.resolve(queued.getSnapshot());}
  await settle(); h.drain(); assert.equal(h.host.childNodes.length, 0);
});

for (const kind of ['artists', 'listened-albums']) test(`${kind} initial native renderer failure removes its already registered listener`, async t => {
  const h = fixture(t), module = await load('artist-selection.mjs'), baseline = h.listeners().length, failure = new Error('initial row render');
  const factory = kind === 'artists' ? module.mountArtistSelectionRows : module.mountListenedAlbums;
  const props = kind === 'artists' ? {rows: [{id: 'artist:one', title: 'Artist'}], view: 'list'} : {albums: [{id: 'album:one', title: 'Album'}]};
  h.runtime[kind === 'artists' ? 'navigationItemHtml' : 'galleryCardHtml'] = () => {throw failure;};
  assert.throws(() => factory(h.host, h.runtime, props), error => error === failure);
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.listeners().length, baseline);
});

test('native view chooser select failure destroys the acquired chooser even if destroy also throws', async t => {
  const h = fixture(t), {mountViewControl} = await load('view-control.mjs'), mounted = h.runtime.mountViewChooser, baseline = h.listeners().length, failure = new Error('initial select');
  let destroys = 0;
  h.runtime.mountViewChooser = (element, options) => {const native = mounted(element, options); return {...native, select(value) {native.select(value); throw failure;}, destroy() {destroys++; native.destroy(); throw new Error('secondary destroy');}};};
  assert.throws(() => mountViewControl(h.host, h.runtime, {kind: 'albums', value: 'cards'}), error => error === failure);
  assert.equal(destroys, 1); assert.equal(mediaCount(h), 0); assert.equal(h.listeners().length, baseline); assert.equal(h.host.childNodes.length, 0);
});

test('preference synchronous publication fault releases its acquired subscription and cannot notify again', async () => {
  const {createTrackPreferences} = await load('track-preference-ui.mjs'), failure = new Error('preference publication'), listeners = new Set(); let releases = 0, notifications = 0, held;
  const runtime = {subscribeTrackPreferences(listener) {held = listener; listeners.add(listener); listener(); return () => {releases++; listeners.delete(listener); throw new Error('secondary unsubscribe');};}};
  assert.throws(() => createTrackPreferences({runtime, rows: [], isCurrent: () => true}, () => {notifications++; throw failure;}), error => error === failure);
  assert.equal(releases, 1); assert.equal(listeners.size, 0); held(); assert.equal(notifications, 1);
});

test('queue detail initial snapshot failure releases its acquired adapter and subscription exactly once', async () => {
  const {createQueueDetails} = await load('queue.mjs'), failure = new Error('queue snapshot'), listeners = new Set(); let disposed = 0, unsubscribed = 0, held, notifications = 0;
  const adapter = {getSnapshot: () => ({selectedIds: []}), subscribe(listener) {held = listener; listeners.add(listener); return () => {unsubscribed++; listeners.delete(listener); throw new Error('secondary unsubscribe');};}, dispose() {disposed++;}};
  const runtime = {createQueueResourceSelection: () => adapter}, api = {getSnapshot() {throw failure;}};
  assert.throws(() => createQueueDetails({runtime, api, scopeKey: 'first', enabled: true, selectedIds: []}, () => notifications++), error => error === failure);
  assert.equal(disposed, 1); assert.equal(unsubscribed, 1); assert.equal(listeners.size, 0); held(); assert.equal(notifications, 0);
});

test('queue header second native button failure releases the first acquired button', async t => {
  const h = fixture(t), {mountQueueHeader} = await load('queue.mjs'), baseline = h.listeners().length, failure = new Error('clear button'), render = h.runtime.buttonHtml;
  h.runtime.buttonHtml = options => {if (options.label === 'Clear queue') throw failure; return render(options);};
  assert.throws(() => mountQueueHeader(h.host, h.runtime, {api: null, value: {enabled: true, entries: []}}), error => error === failure);
  assert.equal(h.listeners().length, baseline); assert.equal(h.host.childNodes.length, 0);
});
