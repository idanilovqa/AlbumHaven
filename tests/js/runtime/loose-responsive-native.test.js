// Real Loose consumer and native bridge, with isolated component DTOs.
// No application boot, transport, database, or preference receipt is fabricated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const requiredKeys = ['number', 'title', 'love', 'duration'];

function fixture() {
  const mounts = [], queues = [], choices = [], events = new Map();
  let token = 'scope-A';
  const noPreferenceAuthority = () => {throw new Error('Layout must not acquire preference authority');};
  const items = [
    {path: 'synthetic-other.flac', title: 'Other title', artist: 'Other artist', display_path: 'fixture/other.flac',
      duration_seconds: 180, exception_type: '', inventory_track_ref: 'inventory-track:1:3', availability: 'missing'},
    {path: 'synthetic-interview.flac', title: 'Unknown track', filename: 'Interview fixture.flac', artist: 'Interview artist',
      display_path: 'fixture/interview.flac', duration_seconds: 6023, exception_type: 'Interview',
      inventory_track_ref: 'inventory-track:1:2', playback_state: {can_start_here: true}},
    {path: 'synthetic-rarity.flac', title: 'Rarity title', artist: 'Rarity artist', display_path: 'fixture/rarity.flac',
      duration_seconds: 240, exception_type: 'Non-album rarity', inventory_track_ref: 'inventory-track:1:1',
      playback_state: {can_start_here: true}, album_rating: 5, love_tier: 'off'},
  ];
  const modal = {isConnected: true, hidden: false}, host = {};
  const context = vm.createContext({console,
    state: {view: {non_album_tracks: items}, player: {current: {path: 'synthetic-rarity.flac'}}},
    document: {documentElement: {getAttribute: () => null}, getElementById: id => id === 'non-album-modal' ? modal : null},
    TrackActionsRuntime: {scope: () => ({token}), readBatch: noPreferenceAuthority,
      preference: noPreferenceAuthority, setLove: noPreferenceAuthority, subscribePreferences: () => () => {}},
    retainTrackModalPreferenceRows: () => () => {}, getTrackModalPreferenceSource: () => null,
    formatTrackDuration: seconds => seconds === 6023 ? '100:23' : `${seconds / 60}:00`,
    formatAlbumDuration: seconds => `${seconds}s`, getPlayerPlaybackSnapshot: () => ({paused: false, ended: false}),
    getProblematicAlbumForTrackPath: value => value === 'synthetic-interview.flac' ? {} : null,
    captureNativeLooseQueueSources: (source, selected) => {queues.push({source, selected}); return selected.map(row => ({title: row.title}));},
    openUtilityChoiceDropdown: (anchor, options) => {choices.push({anchor, options}); return {close() {}};},
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name, callback) => {if (events.get(name) === callback) events.delete(name);},
  });
  context.window = context;
  context.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'component-actor-library'})};
  context.AlbumHavenPlaytableUI = {mount(target, options) {
    const mount = {host: target, options, updates: [], disposed: 0,
      update(next) {if (next) {this.options = {...this.options, ...next}; this.updates.push(next);}},
      dispose() {this.disposed++;}};
    mounts.push(mount); return mount;
  }};
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js',
    'runtime/album-track-table.js', 'runtime/playtable-source.js', 'runtime/modal-and-overlay-helpers.js']) {
    vm.runInContext(read(file), context, {filename: file});
  }
  vm.runInContext('globalThis.native = NativePlaytables;', context);
  function render(nextItems = items, nextHost = host) {
    const html = context.buildNonAlbumTrackSectionsMarkup(nextItems);
    assert.equal(context.native.mount('loose-tracks', nextHost), true);
    return {html, mount: mounts.at(-1), options: mounts.at(-1).options};
  }
  return {context, items, host, modal, mounts, queues, choices, render, scope(next) {token = next;}};
}

test('actual Loose consumer explicitly supplies shared required columns and only real optional metadata', () => {
  const f = fixture(), {html, options} = f.render();
  const presentation = options.tablePresentation;
  assert.ok(presentation, 'The actual Loose consumer must opt into the existing React table presentation');
  const columns = plain(presentation.columns);
  assert.deepEqual(columns.filter(column => column.required || column.identity).map(column => column.key), requiredKeys);
  assert.deepEqual(columns.filter(column => !column.required && !column.identity).map(column => column.key).sort(), ['path', 'problem']);
  assert.deepEqual(columns, plain(f.context.albumTrackTableColumns({showPath: true, showProblem: true})),
    'Loose uses the shared descriptor policy, including widths and auto-admission minima');
  assert.equal(columns.find(column => column.key === 'duration').label, 'Length');
  assert.notEqual(presentation.resourceKey, f.context.state.view);
  assert.doesNotMatch(JSON.stringify(presentation), /synthetic-|inventory-track|non_album_tracks|canonical_track_ref/);
  assert.equal(presentation.isCurrent(), true);
  assert.equal((html.match(/data-cdt-overflow="local"/g) || []).length, 3);
  assert.doesNotMatch(html, /minmax\(180px|data-cdt-column="(?:rating|pc|popularity)"/);
  assert.equal((html.match(/data-cdt-headers="visible"/g) || []).length, 1);
  const renderedKeys = [...html.matchAll(/data-cdt-column="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(renderedKeys)], columns.map(column => column.key));
});

test('Loose layout paints unavailable Love without treating album rating or unreceipted taste as track authority', async () => {
  const f = fixture(), {html, options} = f.render();
  assert.equal((html.match(/data-track-love-cell="1"/g) || []).length, 3);
  assert.equal((html.match(/aria-label="Love unavailable"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-track-love=|aria-label="off"|love-off|data-cdt-column="rating"/);
  assert.ok(options.trackPreferences, 'Loose uses the shared adapter even when its rows lack receipts');
  const preferences = options.trackPreferences;
  assert.equal(preferences.rows.length, 3);
  for (const row of preferences.rows) {
    assert.equal(preferences.runtime.trackPreference(row, preferences.context), null);
    await assert.rejects(preferences.runtime.setTrackLove({row, context: preferences.context, love_tier: 'loved'}),
      error => error.status === 403);
  }
  assert.doesNotMatch(JSON.stringify(options.sourceAdapter.snapshot()), /inventory-track|track_ref|display_path|synthetic-/);
  for (const key of ['buttonHtml', 'actionHtml', 'iconHtml', 'escapeHtml', 'openChoice']) {
    assert.equal(typeof options.runtime[key], 'function', `Shared native bridge supplies ${key}`);
  }
  const anchor = {}, choice = {label: 'Track columns'};
  options.runtime.openChoice(anchor, choice);
  assert.equal(f.choices[0].anchor, anchor); assert.equal(f.choices[0].options, choice);
});

test('Loose sections retain their running order, titles, secondary artists, total, playback and section actions', () => {
  const f = fixture(), {html, options} = f.render();
  const snapshot = plain(options.sourceAdapter.snapshot());
  assert.deepEqual(snapshot.rows.map(row => row.sectionKey), ['non-album-rarity', 'interview', 'other']);
  assert.equal(snapshot.rows.length, 3);
  assert.equal(new Set(snapshot.rows.map(row => row.rowKey)).size, 3);
  assert.deepEqual([...html.matchAll(/class="album-track-table__number">([^<]+)</g)].map(match => match[1]), ['1', '2', '3']);
  for (const text of ['Non-album rarity', 'Interviews', 'Other', 'Interview fixture.flac',
    'Rarity artist', 'Interview artist', '100:23', 'Total Length: 6443s']) assert.ok(html.includes(text), text);
  assert.match(html, /album-track-table__row--current/); assert.match(html, /album-track-table__row--playing/);
  assert.match(html, /album-track-table__row--missing/);
  assert.match(html, /aria-label="Pause track"/); assert.match(html, /aria-label="Play track"[^>]*disabled/);
  assert.equal((html.match(/data-playtable-section-action=/g) || []).length, 3);
  assert.equal((html.match(/data-cdt-selection="multiple"/g) || []).length, 3);
});

test('Loose column opt-in leaves queue capture with the exact existing source and private row owner', async () => {
  const f = fixture(), {options} = f.render(), source = options.sourceAdapter;
  const rows = source.snapshot().rows;
  assert.equal(source.canQueue([rows[0].rowKey]), true);
  assert.equal(source.canQueue([rows[2].rowKey]), false, 'Missing media remains unavailable for queueing');
  await source.captureQueue([rows[0].rowKey]);
  assert.equal(f.queues.length, 1); assert.equal(f.queues[0].source, f.context.state.view);
  assert.equal(f.queues[0].selected[0].inventory_track_ref, 'inventory-track:1:1');
  assert.deepEqual(plain(source.resolveRows([rows[0].rowKey])).rows,
    [{rowKey: rows[0].rowKey, track_ref: 'inventory-track:1:1'}]);
});

test('same Loose resource refresh preserves its mounted choice owner while replacing rows and retiring old callbacks', () => {
  const f = fixture(), first = f.render(), old = first.options.tablePresentation;
  assert.ok(old);
  const oldSource = first.options.sourceAdapter, oldKeys = plain(oldSource.snapshot().rows.map(row => row.rowKey));
  const next = f.render(f.items.slice(1));
  assert.equal(f.mounts.length, 1, 'Same source/scope/view retains the existing React root');
  assert.equal(first.mount.disposed, 0); assert.equal(first.mount.updates.length, 1);
  assert.equal(next.options.tablePresentation.resourceKey, old.resourceKey);
  assert.notEqual(next.options.tablePresentation.source, old.source);
  assert.equal(old.isCurrent(), false); assert.equal(oldSource.snapshot(), null);
  assert.equal(next.options.tablePresentation.isCurrent(), true);
  assert.equal(next.options.sourceAdapter.snapshot().rows.length, 2);
  assert.ok(next.options.sourceAdapter.snapshot().rows.every(row => !oldKeys.includes(row.rowKey)));
});

for (const change of ['source', 'scope', 'host', 'close']) test(`Loose ${change} replacement resets the mounted resource`, () => {
  const f = fixture(), first = f.render(), old = first.options.tablePresentation;
  assert.ok(old);
  if (change === 'source') f.context.state.view = {...f.context.state.view};
  if (change === 'scope') f.scope('scope-B');
  if (change === 'close') f.context.native.retire('loose-tracks');
  const next = f.render(f.items, change === 'host' ? {} : f.host);
  assert.equal(first.mount.disposed, 1); assert.equal(f.mounts.length, 2);
  assert.equal(old.isCurrent(), false);
  if (change !== 'host') assert.notEqual(next.options.tablePresentation.resourceKey, old.resourceKey);
  assert.equal(next.options.tablePresentation.isCurrent(), true);
});

test('unconfigured Loose cannot implicitly acquire or retain a previous presentation', () => {
  const f = fixture();
  f.render();
  f.context.native.prepare('loose-tracks', f.context.state.view,
    [{tracks: [{title: 'Unconfigured row'}]}], [{source_readable: true}], () => true);
  assert.equal(f.context.native.mount('loose-tracks', f.host), true);
  assert.equal(f.mounts.at(-1).options.tablePresentation, undefined);
});

test('actual Loose metadata keeps required columns on mobile and makes explicit path overflow a shared projection choice', async () => {
  const {resolveTrackTableColumns} = await import(pathToFileURL(path.join(root,
    'music_app/static/js/playtables/track-table-presentation.mjs')).href);
  const {options} = fixture().render();
  assert.ok(options.tablePresentation);
  const columns = options.tablePresentation.columns;
  for (const width of [320, 390, 480]) {
    const defaults = resolveTrackTableColumns(columns, width);
    assert.deepEqual(defaults.visibleKeys, requiredKeys);
    assert.ok(defaults.minWidth <= width);
    const explicit = resolveTrackTableColumns(columns, width, {path: true, love: false, duration: false});
    assert.deepEqual(explicit.visibleKeys, ['number', 'title', 'path', 'love', 'duration']);
    assert.ok(explicit.minWidth > width, 'Explicit path requests local overflow instead of removing identity/Love/Length');
  }
  assert.deepEqual(resolveTrackTableColumns(columns, 1100).visibleKeys,
    ['number', 'title', 'path', 'love', 'problem', 'duration']);
});
