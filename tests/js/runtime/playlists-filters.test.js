const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, buttonNamed} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
let model, components;
test.before(async () => {
  model = await import('../../../music_app/static/js/playlists/filters.mjs');
  const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/directory-filters.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']});
  const loaded = new Module(path.join(repo, 'playlist-filter-render-fixture.cjs'), module);
  loaded.filename = path.join(repo, 'playlist-filter-render-fixture.cjs'); loaded.paths = module.paths;
  loaded._compile(built.outputFiles[0].text, loaded.filename); components = loaded.exports;
});
const NOW = Date.parse('2026-10-08T12:00:00Z');
const fact = patch => model.normalizePlaylistFacts(patch);
const matches = (row, filters, now = NOW) => model.matchesPlaylistFilters(fact(row), filters, now);
function nativeRuntime() {
  const native = createNativeHomeRuntime();
  for (const file of ['trigger-anchor.js', 'library-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
  }
  const template = native.document.createElement('script'); template.setAttribute('id', 'navigation-tree-item-template');
  template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  native.document.body.appendChild(template);
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), native.context);
  return {native, runtime: {buttonHtml: config => native.context.ButtonComponent.renderButton(config),
    openChoice: native.context.openUtilityChoiceDropdown,
    actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
    navigationItemHtml: config => native.context.window.NavigationTree.renderItem(config), escapeHtml: native.context.escapeHtml}};
}

test('optional facts normalize exact explicit values and retain unknown separately from zero/empty', () => {
  const input = {love_tier: 'loved', styles: [' Rock ', 'Rock', 'Ambient'], duration_seconds: 0,
    added_at: '2026-10-07T12:00:00Z', listen_count: 0, last_listened_at: null, last_listened_known: true};
  const value = fact(input);
  assert.equal(value.love_tier, 'loved'); assert.deepEqual(value.styles, ['Rock', 'Ambient']);
  assert.equal(value.duration_seconds, 0); assert.equal(value.listen_count, 0); assert.equal(value.added_at_ms, NOW - 86400000);
  assert.equal(value.last_listened_at_ms, null); assert.equal(value.last_listened_known, true);
  assert.equal(fact({}).listen_count, null); assert.equal(fact({}).styles, null); assert.deepEqual(fact({styles: []}).styles, []);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.styles), true);
  assert.deepEqual(input.styles, [' Rock ', 'Rock', 'Ambient']);
});
test('no borrowed stats, preference defaults, inherited facts or fabricated date/genre values', () => {
  const value = fact({track_stats: {scrobble_count: 99}, track_preference: {love_tier: 'obsessed'}, genre: 'Rock',
    listen_count: '99', duration_seconds: '180', added_at: '2026-10-07', last_listened_at: 'yesterday', last_listened_known: 'true'});
  assert.equal(value.listen_count, null); assert.equal(value.love_tier, null); assert.equal(value.styles, null);
  assert.equal(value.duration_seconds, null); assert.equal(value.added_at_ms, null); assert.equal(value.last_listened_at_ms, null);
  assert.equal(value.last_listened_known, false);
  assert.equal(fact(Object.create({love_tier: 'loved', listen_count: 20})).love_tier, null);
  assert.equal(fact(Object.create({love_tier: 'loved', listen_count: 20})).listen_count, null);
  assert.equal(fact({styles: Array(1)}).styles, null); assert.equal(fact({styles: ['Rock', null]}).styles, null);
  assert.equal(fact({added_at: '2026-02-30T12:00:00Z'}).added_at_ms, null);
});
test('unreadable sources discard filter metadata', () => {
  for (const denied of [{source_readable: false}, {allowed_actions: {can_read: false}}]) {
    const value = fact({...denied, styles: ['Private style'], listen_count: 44, love_tier: 'obsessed'});
    assert.equal(value.styles, null); assert.equal(value.listen_count, null); assert.equal(value.love_tier, null);
  }
});
test('personal plays, global popularity and track rating require their own explicit facts', () => {
  const supplied = fact({play_count: 0, popularity_count: 75000, track_rating: 5, listen_count: 99});
  assert.equal(supplied.play_count, 0); assert.equal(supplied.popularity_count, 75000);
  assert.equal(supplied.track_rating, 5); assert.equal(supplied.listen_count, 99);
  for (const input of [{}, {listen_count: 88, scrobble_count: 999, rating: 4},
    Object.create({play_count: 3, popularity_count: 55, track_rating: 4}),
    {play_count: '1', popularity_count: '5', track_rating: '4'},
    {play_count: -1, popularity_count: Infinity, track_rating: 0},
    {play_count: 1.5, popularity_count: Number.MAX_SAFE_INTEGER + 1, track_rating: 6},
    {play_count: NaN, popularity_count: -1, track_rating: 2.5}]) {
    const value = fact(input);
    for (const key of ['play_count', 'popularity_count', 'track_rating']) assert.equal(value[key], null, key);
  }
  for (const denied of [{source_readable: false}, {allowed_actions: {can_read: false}}]) {
    const value = fact({...denied, play_count: 7, popularity_count: 800, track_rating: 4, duration_seconds: 123});
    for (const key of ['play_count', 'popularity_count', 'track_rating', 'duration_seconds']) assert.equal(value[key], null, key);
  }
});
test('filter normalization rejects malformed options and clears retired or invisible choices', () => {
  const value = model.normalizePlaylistFilters({love: 'none', style: ' Rock ', minDuration: '90', maxDuration: -1,
    addedWithinDays: 8, frequency: 'all', frequencyMode: 'exclude', minListens: 50, includeUnknown: 'false'});
  assert.equal(value.love, 'all'); assert.equal(value.style, 'Rock'); assert.equal(value.minDuration, null);
  assert.equal(value.maxDuration, null); assert.equal(value.addedWithinDays, null); assert.equal(value.frequencyMode, 'only');
  assert.equal(value.includeUnknown, true); assert.equal('minListens' in value, false);
  assert.equal(model.normalizePlaylistFilters({minDuration: 300, maxDuration: 20}).minDuration, null);
  assert.equal(model.playlistFiltersActive({frequency: 'all', frequencyMode: 'exclude', includeUnknown: false}), false);
  assert.equal(model.playlistFiltersActive({love: 'loved'}), true); assert.equal(model.playlistFiltersActive({maxDuration: 0}), true);
  assert.deepEqual(model.normalizePlaylistFilters(Object.create({love: 'loved'})), model.DEFAULT_PLAYLIST_FILTERS);
});
test('love and style filters preserve unknown but do not confuse known off/empty with missing facts', () => {
  assert.equal(matches({}, {love: 'loved'}), true); assert.equal(matches({}, {love: 'loved', includeUnknown: false}), false);
  assert.equal(matches({love_tier: 'off'}, {love: 'loved'}), false); assert.equal(matches({love_tier: 'obsessed'}, {love: 'loved'}), true);
  assert.equal(matches({love_tier: 'obsessed'}, {love: 'obsessed'}), true);
  assert.equal(matches({love_tier: 'loved'}, {love: 'obsessed'}), false);
  assert.equal(matches({}, {style: 'Rock'}), true); assert.equal(matches({styles: []}, {style: 'Rock'}), false);
  assert.equal(matches({styles: ['Rock']}, {style: 'Rock'}), true); assert.equal(matches({styles: ['rock']}, {style: 'Rock'}), false);
});
test('length presets preserve precise boundaries and real zero', () => {
  const range = key => model.PLAYLIST_LENGTH_PRESETS[key];
  assert.equal(matches({duration_seconds: 179}, range('short')), true); assert.equal(matches({duration_seconds: 180}, range('short')), false);
  assert.equal(matches({duration_seconds: 180}, range('medium')), true); assert.equal(matches({duration_seconds: 300}, range('medium')), true);
  assert.equal(matches({duration_seconds: 301}, range('long')), true); assert.equal(matches({duration_seconds: 480}, range('epic')), false);
  assert.equal(matches({duration_seconds: 481}, range('epic')), true); assert.equal(matches({duration_seconds: 0}, range('short')), true);
  assert.equal(matches({}, range('long')), true); assert.equal(matches({}, {...range('long'), includeUnknown: false}), false);
  assert.equal(model.playlistLengthValue(range('epic')), 'epic'); assert.equal(model.playlistLengthValue({minDuration: 42}), 'custom');
});
test('Added uses explicit instants, inclusive boundary and unknown clock/date semantics', () => {
  assert.equal(matches({added_at: NOW - 7 * 86400000}, {addedWithinDays: 7}), true);
  assert.equal(matches({added_at: NOW - 7 * 86400000 - 1}, {addedWithinDays: 7}), false);
  assert.equal(matches({added_at: '2026-10-08T14:00:00+02:00'}, {addedWithinDays: 1}), true);
  assert.equal(matches({}, {addedWithinDays: 1}), true); assert.equal(matches({}, {addedWithinDays: 1, includeUnknown: false}), false);
  assert.equal(matches({added_at: NOW + 1000}, {addedWithinDays: 1, includeUnknown: false}), false);
  assert.equal(matches({added_at: NOW}, {addedWithinDays: 1}, NaN), true);
});
test('Listening ranges and include/exclude preserve unknown independently of zero', () => {
  for (const [count, expected] of [[0, 'barely'], [9, 'barely'], [10, 'mid'], [19, 'mid'], [20, 'frequent']]) {
    assert.equal(matches({listen_count: count}, {frequency: expected}), true);
    assert.equal(matches({listen_count: count}, {frequency: expected, frequencyMode: 'exclude'}), false);
  }
  assert.equal(matches({}, {frequency: 'frequent', frequencyMode: 'exclude'}), true);
  assert.equal(matches({}, {frequency: 'frequent', frequencyMode: 'exclude', includeUnknown: false}), false);
  assert.equal(matches({listen_count: 0}, {frequency: 'frequent', frequencyMode: 'exclude'}), true);
});
test('Forgotten subtracts calendar months and distinguishes known never-listened from unknown', () => {
  const now = Date.parse('2026-08-31T12:00:00Z');
  assert.equal(matches({last_listened_at: '2026-02-28T12:00:00Z'}, {frequency: 'forgotten'}, now), true);
  assert.equal(matches({last_listened_at: '2026-02-28T12:00:00.001Z'}, {frequency: 'forgotten'}, now), false);
  assert.equal(matches({listen_count: 0, last_listened_known: true, last_listened_at: null}, {frequency: 'forgotten'}), false);
  assert.equal(matches({listen_count: 0, last_listened_known: true, last_listened_at: null}, {frequency: 'forgotten', frequencyMode: 'exclude'}), true);
  assert.equal(matches({listen_count: 0}, {frequency: 'forgotten'}), true);
  assert.equal(matches({}, {frequency: 'forgotten', includeUnknown: false}), false);
});
test('combined filtering retains the exact row objects and original order', () => {
  const rows = [{id: 'b', ...fact({love_tier: 'loved', styles: ['Rock'], listen_count: 20})},
    {id: 'a', ...fact({love_tier: 'obsessed', styles: ['Rock'], listen_count: 21})}, {id: 'c', ...fact({})}];
  const filtered = model.filterPlaylistRows(rows, {love: 'loved', style: 'Rock', frequency: 'frequent'}, NOW);
  assert.deepEqual(filtered.map(row => row.id), ['b', 'a', 'c']);
  assert.equal(filtered[0], rows[0]); assert.equal(filtered[1], rows[1]); assert.equal(filtered[2], rows[2]);
  assert.deepEqual(rows.map(row => row.id), ['b', 'a', 'c']);
});
test('grouping only trusts exact own playlist_kind and preserves provider order', () => {
  const items = [{playlist_id: 'm2', playlist_kind: 'manual'}, {playlist_id: 'Loved and Obsessed', title: 'Autoplaylist'},
    {playlist_id: 'a1', playlist_kind: 'autoplaylist'}, {playlist_id: 'm1', playlist_kind: 'manual'},
    Object.assign(Object.create({playlist_kind: 'autoplaylist'}), {playlist_id: 'unknown'}), {playlist_id: 'other', playlist_kind: 'derived'}];
  const groups = model.groupPlaylists(items);
  assert.deepEqual(groups.manual.map(row => row.playlist_id), ['m2', 'm1']);
  assert.deepEqual(groups.autoplaylists.map(row => row.playlist_id), ['a1']);
  assert.deepEqual(groups.unclassified.map(row => row.playlist_id), ['Loved and Obsessed', 'unknown', 'other']);
  assert.equal(groups.manual[0], items[0]); assert.equal(Object.isFrozen(groups.manual), true);
});
test('native group headings provide disclosure semantics and exact-grant disabled rows', () => {
  const {runtime, native} = nativeRuntime();
  const html = renderToStaticMarkup(React.createElement(components.PlaylistGroupedDirectory, {runtime, selectedPlaylistId: 'one', items: [
    {playlist_id: 'one', title: '<Mine>', playlist_kind: 'manual', item_count: 0, allowed_actions: {can_open: true}},
    {playlist_id: 'two', title: 'Locked', playlist_kind: 'autoplaylist', allowed_actions: {can_open: 'true'}},
    {playlist_id: 'three', title: 'Unclassified', allowed_actions: {}},
  ]}));
  assert.match(html, /navigation-tree/); assert.match(html, /&lt;Mine&gt;/); assert.match(html, /Autoplaylists/); assert.match(html, /Other playlists/);
  assert.match(html, /aria-expanded="true"/); assert.match(html, /aria-controls=/); assert.match(html, /aria-current="true"/);
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('[data-playlist-group-item="two"]').disabled, true);
  assert.equal(host.querySelector('[data-playlist-group-item="one"]').disabled, false);
  assert.equal(components.playlistDisclosureState(false, 'ArrowLeft'), true);
  assert.equal(components.playlistDisclosureState(true, 'ArrowRight'), false);
  assert.equal(components.playlistDisclosureState(true, 'Home'), true);
});
test('filter leaves expose exact v54 fields, conditional Match and truthful unknown note', () => {
  const {runtime, native} = nativeRuntime(), rows = [
    {styles: ['Rock', 'Ambient']}, {styles: ['Private'], source_readable: false},
  ];
  const render = filters => renderToStaticMarkup(React.createElement(components.PlaylistFilterControls, {runtime, rows, filters}));
  const filters = {love: 'obsessed', style: 'Absent selection', frequency: 'mid', frequencyMode: 'exclude'};
  const html = render(filters), host = native.document.createElement('div'); host.innerHTML = html;
  for (const name of ['Love: Only obsessed', 'Style: Absent selection', 'Length: Any length', 'Added: Any time',
    'Listening: Mid (10–19)', 'Match: Filter these out']) {
    const trigger = host.querySelector(`button[aria-label="${name}"]`); assert.ok(trigger, name);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu'); assert.equal(trigger.disabled, false);
  }
  const choices = React.Children.toArray(components.PlaylistFilterControls({runtime, rows, filters}).props.children)
    .filter(child => child.type?.name === 'NativeChoice');
  assert.deepEqual(choices.find(child => child.props.label === 'Love').props.options,
    [['all', 'Any love'], ['loved', 'Only loved'], ['obsessed', 'Only obsessed']]);
  assert.deepEqual(choices.find(child => child.props.label === 'Style').props.options,
    [['', 'Any style'], ['Ambient', 'Ambient'], ['Rock', 'Rock'], ['Absent selection', 'Absent selection']]);
  assert.match(html, /Unknown filter values remain visible/); assert.doesNotMatch(html, /Private/);
  assert.equal(host.querySelector('select'), null);
  assert.doesNotMatch(render({}), /aria-label="Match:/);
  assert.match(render({includeUnknown: false}), /Unknown filter values are excluded/);
});
test('invalid or missing last-listen timestamps cannot become a confirmed never-listened fact', () => {
  for (const patch of [{last_listened_at: 'bad'}, {}]) {
    const value = fact({listen_count: 0, last_listened_known: true, ...patch});
    assert.equal(value.last_listened_known, false);
    assert.equal(model.matchesPlaylistFilters(value, {frequency: 'forgotten'}, NOW), true);
  }
  assert.equal(model.groupPlaylists([{playlist_kind: 'manual'}, null, ...Array(1)]).manual.length, 0);
});
test('fractional lengths follow displayed Under/Over semantics without rounding facts', () => {
  const preset = model.PLAYLIST_LENGTH_PRESETS;
  for (const [seconds, short, medium, long, epic] of [
    [179.5, true, false, false, false], [180, false, true, false, false],
    [300, false, true, false, false], [300.5, false, false, true, false],
    [480, false, false, true, false], [480.5, false, false, true, true],
  ]) {
    const row = fact({duration_seconds: seconds}); assert.equal(row.duration_seconds, seconds);
    for (const [key, expected] of Object.entries({short, medium, long, epic})) {
      assert.equal(model.matchesPlaylistFilters(row, preset[key], NOW), expected, `${seconds} seconds / ${key}`);
    }
  }
  assert.equal(matches({duration_seconds: 179.5}, {maxDuration: 179}), false, 'custom numeric bounds retain their literal meaning');
  assert.equal(matches({duration_seconds: 180}, {maxDuration: 180}), true);
  assert.equal(matches({duration_seconds: 180}, {maxDuration: 180, maxDurationExclusive: true}), false);
  assert.equal(model.normalizePlaylistFilters({minDurationExclusive: true}).minDurationExclusive, false);
});
test('generic Any love includes known off as well as loved and obsessed', () => {
  for (const love_tier of ['off', 'loved', 'obsessed']) assert.equal(matches({love_tier}, {love: 'all'}), true);
});
test('parent reset grant composes outer filters without adding query or availability logic to the leaf', () => {
  const {runtime, native} = nativeRuntime();
  const host = native.document.createElement('div');
  const render = props => renderToStaticMarkup(React.createElement(components.PlaylistFilterControls, {runtime, filters: {}, ...props}));
  host.innerHTML = render({}); assert.equal(buttonNamed(host, /^Reset filters$/).disabled, true);
  host.innerHTML = render({canReset: true}); assert.equal(buttonNamed(host, /^Reset filters$/).disabled, false);
  host.innerHTML = render({canReset: true, disabled: true}); assert.equal(buttonNamed(host, /^Reset filters$/).disabled, true);
  host.innerHTML = render({filters: {love: 'loved'}, canReset: false}); assert.equal(buttonNamed(host, /^Reset filters$/).disabled, true);
  host.innerHTML = render({canReset: 'true'}); assert.equal(buttonNamed(host, /^Reset filters$/).disabled, true);
});
