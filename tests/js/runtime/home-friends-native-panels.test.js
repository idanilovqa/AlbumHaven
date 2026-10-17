'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');

const runtimeBase = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const activityRow = (id, extra = {}) => ({id, kind: 'track', title: id, artist: 'Artist', album_title: 'Album',
  availability: 'local', source_readable: true, listen_count: 1, duration_seconds: 123, rating: 4,
  taste_state: 'available', love_tier: 'off', allowed_actions: {can_view_details: false}, ...extra});
const rowsIn = (host, attribute) => host.querySelectorAll(`[${attribute}]`).map(node => node.getAttribute(attribute));
const selectedIn = (host, attribute) => host.querySelectorAll(`[${attribute}][aria-selected="true"]`).map(node => node.getAttribute(attribute));
const rowIn = (host, attribute, id) => host.querySelectorAll(`[${attribute}]`).find(node => node.getAttribute(attribute) === id);

// These tests mount the actual panels and their canonical selection,
// presentation, preference, compact-table and native button implementations.
// This boundary fixture supplies native session/data facts, never an alternate
// implementation of a panel, selection owner, preference controller or planner.
function panelFixture(t) {
  const h = fixture(t), sources = [], playlistActions = [], plays = [], writes = [], preferences = new Map(), preferenceListeners = new Set();
  let scopeKey = 'scope:first', beforeTable = null;
  h.c.TrackActionsRuntime = {scope: () => ({token: 'native-panel-session', actor: '4', library: '5'})};
  for (const file of ['playtable-source.js', 'explicit-queue-planner.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeBase, file), 'utf8'), h.c, {filename: file});
  }
  const nativeTable = h.runtime.tableHtml;
  const preference = id => preferences.get(id) || {identity: `preference:${id}`, love_tier: 'off', rating: 4,
    allowed_actions: {can_set_love_tier: true}};
  Object.assign(h.runtime, {
    snapshot: () => ({scopeKey}),
    tableHtml(value) {
      // A deterministic platform callback during the real render lets a
      // retained native row action publish into its live source subscription.
      const callback = beforeTable; beforeTable = null; callback?.(value);
      return nativeTable(value);
    },
    createPlaytableSource(options) {
      const adapter = h.c.createPrivatePlaytableSource({...options, scopeKey: options.context.scopeKey,
        resolveRow: row => ({inventory_track_ref: `inventory-track:5:${options.rows.indexOf(row) + 1}`, source_readable: true})});
      sources.push({options, adapter}); return adapter;
    },
    openPlaylistAction(packet, lifetime, sourceAdapter) {
      playlistActions.push({packet, lifetime, sourceAdapter}); return true;
    },
    canTrackIntent: (_intent, row) => row.source_readable !== false && row.availability === 'local',
    trackIntent(intent, row, context) {plays.push({intent, row, context}); return true;},
    trackPreference: row => row.source_readable === false ? null : preference(row.id),
    setTrackLove(request) {const pending = deferred(); writes.push({request, ...pending}); return pending.promise;},
    subscribeTrackPreferences(listener) {preferenceListeners.add(listener); return () => preferenceListeners.delete(listener);},
  });
  return {...h, sources, playlistActions, plays, writes, preference,
    setScope(value) {scopeKey = value;},
    beforeNextTable(callback) {assert.equal(beforeTable, null); beforeTable = callback;},
    setPreference(id, value) {preferences.set(id, {...preference(id), ...value});},
    publishPreferences() {for (const listener of [...preferenceListeners]) listener();},
    preferenceListenerCount: () => preferenceListeners.size};
}

async function activityValue(t, rows, scopeKey = 'scope:first') {
  const {createHomeFriendsController} = await load('model.mjs');
  const controller = createHomeFriendsController({providers: {readActivity: async () => ({rows})}});
  t.after(() => controller.dispose()); controller.setScope(scopeKey);
  await controller.loadActivity({kind: 'tracks', period: 'week'});
  const value = controller.getSnapshot().activity;
  assert.equal(value.status, 'ready', 'Activity fixtures must pass the canonical provider model');
  assert.ok(Object.isFrozen(value.data.rows)); return value;
}
const activityProps = (value, extra = {}) => ({scopeKey: 'scope:first', account_ref: null, kind: 'tracks',
  period: 'week', view: 'rows', value, selectedTrackIds: [], onTracksSelect() {}, ...extra});

// The public Queue boundary delegates occurrence identity, ordering, timing and
// current-entry protection to the actual native explicit-queue planner. Only
// external metadata, preference transport and store publication are fixtures.
function queueFixture(h, title, {duplicate = false} = {}) {
  const listeners = new Set(), preferenceListeners = new Set(), calls = [], refreshes = [], writes = [], metadata = new Map(), preferences = new Map();
  let metadataRevision = 0, cachedPlanner, cachedRevision = -1, snapshot;
  const trackIds = duplicate ? ['shared-track', 'shared-track', 'other-track'] : ['track-one', 'track-two', 'track-three'];
  for (const [index, key] of [...new Set(trackIds)].entries()) metadata.set(key,
    {title: `${title} ${index + 1}`, artist: 'Artist', album: 'Album', duration_seconds: 123, sourceReadable: true, canPlay: true});
  const planner = h.c.createExplicitQueuePlanner({canPlay: key => metadata.get(key)?.canPlay === true});
  const ids = Array.from(planner.enqueue(trackIds));
  const getSnapshot = () => {
    const value = planner.getSnapshot();
    if (cachedPlanner !== value || cachedRevision !== metadataRevision) {
      cachedPlanner = value; cachedRevision = metadataRevision;
      snapshot = Object.freeze({enabled: value.enabled, revision: `${value.revision}:${metadataRevision}`,
        entries: Object.freeze(Array.from(value.entries, entry => Object.freeze({...metadata.get(entry.trackId), id: entry.id,
          timing: entry.timing, current: entry.id === value.currentId})))});
    }
    return snapshot;
  };
  const emit = () => {for (const listener of [...listeners]) listener();};
  const entryFor = id => planner.getSnapshot().entries.find(entry => entry.id === id);
  const preference = handle => {
    const entry = entryFor(handle?.id);
    if (!entry || metadata.get(entry.trackId)?.sourceReadable !== true) return null;
    return preferences.get(entry.trackId) || {identity: `queue-preference:${entry.trackId}`, love_tier: 'off', rating: 4,
      allowed_actions: {can_set_love_tier: true}};
  };
  const change = (action, ...args) => {calls.push({action, args}); const result = planner[action](...args); if (result !== false) emit(); return result;};
  const api = {
    getSnapshot,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    timingOptions: () => planner.timingOptions(null),
    refresh(options) {refreshes.push(options); return Promise.resolve(getSnapshot());},
    remove: id => change('remove', id), reorder: ids => change('reorder', ids),
    retime: (id, timing) => change('retime', id, timing, null), setEnabled: enabled => change('setEnabled', enabled),
    play(id, options) {calls.push({action: 'play', args: [id], options}); return Promise.resolve(true);},
    trackPreference: preference,
    setTrackLove(request) {const pending = deferred(); writes.push({request, ...pending}); return pending.promise;},
    subscribeTrackPreferences(listener) {preferenceListeners.add(listener); return () => preferenceListeners.delete(listener);},
  };
  return {api, planner, ids, calls, refreshes, writes, getSnapshot,
    listenerCount: () => listeners.size, preferenceListenerCount: () => preferenceListeners.size,
    updateMetadata(id, patch) {
      const entry = entryFor(id); assert.ok(entry); metadata.set(entry.trackId, {...metadata.get(entry.trackId), ...patch}); metadataRevision++; emit();
    },
    publishPreferences(id, patch) {
      const entry = entryFor(id); assert.ok(entry); preferences.set(entry.trackId, {...preference({id}), ...patch});
      for (const listener of [...preferenceListeners]) listener();
    }};
}
const queueProps = (queue, extra = {}) => ({api: queue.api, value: queue.getSnapshot(), scopeKey: 'scope:first', selectedIds: [], onSelect() {}, ...extra});

function queueOlderPropsDuringRemove(h, owner, queue, olderProps) {
  // First publish a new renderable value, before arming the reentrant callback.
  // Both the old DOM button and the new value still name this occurrence.
  const id = queue.ids[0], remove = rowIn(h.host, 'data-queue-row', id).querySelector('[data-queue-remove]');
  queue.updateMetadata(id, {title: 'Rendering replacement queue row'});
  let publications = 0;
  const unsubscribe = queue.api.subscribe(() => {publications++; unsubscribe(); owner.update(olderProps);});
  h.beforeNextTable(() => h.click(remove));
  owner.update(queueProps(queue));
  unsubscribe();
  assert.equal(publications, 1, 'The retained native Remove action must publish during panel rendering');
  assert.deepEqual(queue.calls.filter(call => call.action === 'remove').map(call => call.args[0]), [id]);
  assert.equal(queue.getSnapshot().entries.some(entry => entry.id === id), false);
}

test('mounted Activity keeps a newer source, scope and selection after an older source-subscription update was queued during sort', async t => {
  const h = panelFixture(t), {mountActivityPanel} = await load('activity.mjs');
  const first = await activityValue(t, [activityRow('first-a', {listen_count: 9}), activityRow('first-b', {listen_count: 1})]);
  const older = await activityValue(t, [activityRow('obsolete-a')], 'scope:obsolete');
  const latest = await activityValue(t, [activityRow('latest-a'), activityRow('latest-b')], 'scope:latest');
  const owner = h.own(mountActivityPanel(h.host, h.runtime, activityProps(first, {selectedTrackIds: ['first-a']})));
  const originalSource = h.sources[0].adapter;
  let publications = 0;
  const unsubscribe = originalSource.subscribe(() => {
    publications++; unsubscribe(); owner.update(activityProps(older, {scopeKey: 'scope:obsolete', selectedTrackIds: ['obsolete-a']}));
  });
  h.click(h.host.querySelector('[data-cdt-sort="listens"]'));
  assert.equal(publications, 1, 'Sorting must notify the actual subscribed native source inside render');
  assert.deepEqual(rowsIn(h.host, 'data-home-activity-row'), ['first-b', 'first-a'], 'The older update is deferred, not synchronously installed');
  h.setScope('scope:latest');
  owner.update(activityProps(latest, {scopeKey: 'scope:latest', selectedTrackIds: ['latest-b']}));
  assert.deepEqual(selectedIn(h.host, 'data-home-activity-row'), ['latest-b']);
  await settle();
  assert.deepEqual(rowsIn(h.host, 'data-home-activity-row'), ['latest-a', 'latest-b']);
  assert.deepEqual(selectedIn(h.host, 'data-home-activity-row'), ['latest-b']);
  assert.equal(h.sources.length, 2, 'Draining the older callback must not admit its native source');
  assert.equal(originalSource.snapshot(), null);
  assert.equal(h.sources[1].options.instance, latest);
  assert.equal(h.sources[1].adapter.snapshot().scopeKey, 'scope:latest');
  h.click(h.named('Add to playlist', h.host));
  assert.equal(h.playlistActions.length, 1);
  assert.deepEqual(plain(h.playlistActions[0].packet.row_keys), ['latest-b']);
  assert.equal(h.playlistActions[0].packet.scopeKey, 'scope:latest');
  assert.equal(h.playlistActions[0].lifetime.isCurrent(), true);
  h.click(rowIn(h.host, 'data-home-activity-row', 'latest-b').querySelector('[data-home-activity-play]'));
  assert.equal(h.plays.at(-1).row, latest.data.rows[1]); assert.equal(h.plays.at(-1).context.scopeKey, 'scope:latest');
  owner.dispose(); assert.equal(h.playlistActions[0].lifetime.isCurrent(), false);
});

test('mounted Activity disposal retires an update queued through the live native source before microtask drain', async t => {
  const h = panelFixture(t), {mountActivityPanel} = await load('activity.mjs');
  const first = await activityValue(t, [activityRow('first-a', {listen_count: 2}), activityRow('first-b')]);
  const pending = await activityValue(t, [activityRow('must-not-mount')]);
  const owner = h.own(mountActivityPanel(h.host, h.runtime, activityProps(first)));
  const source = h.sources[0].adapter; let publications = 0;
  const unsubscribe = source.subscribe(() => {publications++; unsubscribe(); owner.update(activityProps(pending));});
  h.click(h.host.querySelector('[data-cdt-sort="listens"]')); assert.equal(publications, 1);
  owner.dispose(); await settle();
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.sources.length, 1);
  assert.equal(source.snapshot(), null); assert.equal(h.preferenceListenerCount(), 0);
  owner.update(activityProps(pending)); assert.equal(h.host.childNodes.length, 0);
});

test('mounted Activity preferences use current rows and scope, retain rating facts and stop after read denial', async t => {
  const h = panelFixture(t), {mountActivityPanel} = await load('activity.mjs'), {resource} = await load('model.mjs');
  const first = await activityValue(t, [activityRow('same-track')]);
  const latest = await activityValue(t, [activityRow('same-track', {title: 'Current title', rating: null})], 'scope:latest');
  const owner = h.own(mountActivityPanel(h.host, h.runtime, activityProps(first)));
  const firstRow = rowIn(h.host, 'data-home-activity-row', 'same-track');
  assert.equal(firstRow.querySelector('[data-cdt-column="rating"]').textContent, '4');
  const firstLove = firstRow.querySelector('[data-track-love]'); h.click(firstLove); await settle();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].request.row, first.data.rows[0]);
  assert.equal(h.writes[0].request.context.scopeKey, 'scope:first'); assert.equal(h.writes[0].request.signal.aborted, false);
  h.setScope('scope:latest'); owner.update(activityProps(latest, {scopeKey: 'scope:latest'}));
  assert.equal(h.writes[0].request.signal.aborted, true);
  h.writes[0].reject(new Error('Late old-scope write failure')); await settle();
  assert.doesNotMatch(h.host.textContent, /not confirmed|Late old-scope/);
  const latestRow = rowIn(h.host, 'data-home-activity-row', 'same-track');
  assert.ok(latestRow.querySelector('[aria-label="Track unrated"]'));
  const currentLove = latestRow.querySelector('[data-track-love]'); h.click(currentLove); await settle();
  assert.equal(h.writes.length, 2); assert.equal(h.writes[1].request.row, latest.data.rows[0]);
  assert.equal(h.writes[1].request.context.scopeKey, 'scope:latest');
  h.setPreference('same-track', {allowed_actions: {can_set_love_tier: false}}); h.publishPreferences();
  assert.equal(h.writes[1].request.signal.aborted, true); assert.equal(latestRow.querySelector('[data-track-love]'), null);
  h.writes[1].reject(Object.assign(new Error('Forbidden'), {status: 403})); await settle();
  assert.match(h.host.textContent, /no longer have permission to change Love/);
  owner.update(activityProps(resource('denied'), {scopeKey: 'scope:latest', selectedTrackIds: ['same-track']}));
  assert.deepEqual(rowsIn(h.host, 'data-home-activity-row'), []); assert.deepEqual(selectedIn(h.host, 'data-home-activity-row'), []);
  h.click(currentLove); h.click(firstLove); await settle(); assert.equal(h.writes.length, 2);
  assert.equal(h.sources.at(-1).adapter.snapshot(), null);
});

test('mounted Queue keeps newer API, scope and selected occurrence after a native Remove callback queues older props during render', async t => {
  const h = panelFixture(t), {mountQueuePanel} = await load('queue.mjs');
  const first = queueFixture(h, 'First'), older = queueFixture(h, 'Obsolete'), latest = queueFixture(h, 'Latest');
  const owner = h.own(mountQueuePanel(h.host, h.runtime, queueProps(first, {selectedIds: [first.ids[0]]})));
  queueOlderPropsDuringRemove(h, owner, first, queueProps(older, {scopeKey: 'scope:obsolete', selectedIds: [older.ids[0]]}));
  assert.equal(older.refreshes.length, 0, 'The source-publication update is still deferred');
  h.setScope('scope:latest'); owner.update(queueProps(latest, {scopeKey: 'scope:latest', selectedIds: [latest.ids[1]]}));
  await settle();
  assert.match(h.host.textContent, /Latest 2/); assert.doesNotMatch(h.host.textContent, /Obsolete|Rendering replacement/);
  assert.deepEqual(selectedIn(h.host, 'data-queue-row'), [latest.ids[1]]);
  assert.equal(first.listenerCount(), 0); assert.equal(first.preferenceListenerCount(), 0);
  assert.equal(first.refreshes[0].signal.aborted, true); assert.equal(older.refreshes.length, 0);
  assert.equal(latest.refreshes.length, 1); assert.equal(latest.refreshes[0].signal.aborted, false);
  h.click(rowIn(h.host, 'data-queue-row', latest.ids[1]).querySelector('[data-track-love]')); await settle();
  assert.equal(latest.writes.length, 1); assert.equal(first.writes.length, 0); assert.equal(older.writes.length, 0);
  assert.equal(latest.writes[0].request.row.id, latest.ids[1]); assert.equal(latest.writes[0].request.context.scopeKey, 'scope:latest');
  h.click(rowIn(h.host, 'data-queue-row', latest.ids[1]).querySelector('[data-queue-remove]'));
  assert.deepEqual(latest.calls.filter(call => call.action === 'remove').map(call => call.args[0]), [latest.ids[1]]);
  owner.dispose(); assert.equal(latest.writes[0].request.signal.aborted, true); assert.equal(latest.listenerCount(), 0);
  latest.writes[0].reject(new Error('Retired queue request')); await settle(); assert.equal(h.host.childNodes.length, 0);
});

test('mounted Queue disposal prevents a source callback queued during rendering from reopening subscriptions or refresh work', async t => {
  const h = panelFixture(t), {mountQueuePanel} = await load('queue.mjs');
  const first = queueFixture(h, 'First'), pending = queueFixture(h, 'Must not mount');
  const owner = h.own(mountQueuePanel(h.host, h.runtime, queueProps(first)));
  queueOlderPropsDuringRemove(h, owner, first, queueProps(pending, {scopeKey: 'scope:pending'}));
  owner.dispose(); await settle();
  assert.equal(h.host.childNodes.length, 0); assert.equal(first.listenerCount(), 0); assert.equal(first.preferenceListenerCount(), 0);
  assert.equal(first.refreshes[0].signal.aborted, true); assert.equal(pending.refreshes.length, 0);
  assert.equal(pending.listenerCount(), 0); assert.equal(pending.preferenceListenerCount(), 0);
  owner.update(queueProps(pending)); assert.equal(h.host.childNodes.length, 0);
});

test('mounted Queue selects, plays, reorders and removes exact duplicate-track occurrences and drops a denied selection', async t => {
  const h = panelFixture(t), {mountQueuePanel} = await load('queue.mjs'), queue = queueFixture(h, 'Duplicate', {duplicate: true});
  const selections = [], props = () => queueProps(queue, {onSelect: (ids, options) => selections.push({ids: Array.from(ids), options})});
  const owner = h.own(mountQueuePanel(h.host, h.runtime, props()));
  assert.notEqual(queue.ids[0], queue.ids[1]);
  assert.equal(queue.getSnapshot().entries[0].title, queue.getSnapshot().entries[1].title);
  h.click(rowIn(h.host, 'data-queue-row', queue.ids[1]));
  assert.deepEqual(selections.at(-1), {ids: [queue.ids[1]], options: {inspect: true}});
  assert.deepEqual(selectedIn(h.host, 'data-queue-row'), [queue.ids[1]]);
  h.click(rowIn(h.host, 'data-queue-row', queue.ids[1]).querySelector('[data-queue-play]'));
  assert.deepEqual(queue.calls.filter(call => call.action === 'play').map(call => call.args[0]), [queue.ids[1]]);
  h.click(rowIn(h.host, 'data-queue-row', queue.ids[1]).querySelector('[data-queue-up]'));
  assert.deepEqual(plain(queue.planner.getSnapshot().entries.map(entry => entry.id)), [queue.ids[1], queue.ids[0], queue.ids[2]]);
  owner.update(queueProps(queue, {selectedIds: [queue.ids[1]], onSelect: props().onSelect}));
  h.click(rowIn(h.host, 'data-queue-row', queue.ids[0]).querySelector('[data-queue-remove]'));
  assert.equal(queue.getSnapshot().entries.some(entry => entry.id === queue.ids[0]), false);
  assert.equal(queue.getSnapshot().entries.some(entry => entry.id === queue.ids[1]), true, 'Removing one occurrence must preserve the other copy');
  owner.update(queueProps(queue, {selectedIds: [queue.ids[1]], onSelect: props().onSelect}));
  const oldLove = rowIn(h.host, 'data-queue-row', queue.ids[1]).querySelector('[data-track-love]');
  h.click(oldLove); await settle(); assert.equal(queue.writes.length, 1);
  queue.updateMetadata(queue.ids[1], {sourceReadable: false, canPlay: false});
  owner.update(queueProps(queue, {selectedIds: [queue.ids[1]], onSelect: props().onSelect}));
  assert.equal(queue.writes[0].request.signal.aborted, true);
  assert.deepEqual(selectedIn(h.host, 'data-queue-row'), []);
  const denied = rowIn(h.host, 'data-queue-row', queue.ids[1]);
  assert.equal(denied.getAttribute('aria-disabled'), 'true'); assert.equal(denied.querySelector('[data-queue-play]'), null);
  assert.equal(denied.querySelector('[data-track-love]'), null);
  const before = selections.length; h.click(denied); h.click(oldLove); assert.equal(selections.length, before);
  await settle(); assert.equal(queue.writes.length, 1);
  queue.writes[0].reject(new Error('Late denied source')); await settle(); assert.doesNotMatch(h.host.textContent, /Late denied source/);
});
