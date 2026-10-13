// Server-render contract only: real React hooks, QueuePanel, shared owners and
// native markup. Effects, layout, browser focus and mutation execution are NOT
// exercised here; queueTrackMetadata.spec.js owns those component scenarios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const root = path.resolve(__dirname, '../../..');
let QueuePanel;
test.before(() => {
  const bundled = buildSync({entryPoints: [path.join(root, 'music_app/static/js/home-friends/queue.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/client']}).outputFiles[0].text;
  const loaded = new Module(`${__filename}.fixture.cjs`, module);
  loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
  loaded._compile(bundled, loaded.filename); QueuePanel = loaded.exports.QueuePanel;
});
function fixture() {
  const native = createNativeHomeRuntime();
  vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime/compact-data-table.js'), 'utf8'), native.context);
  const rows = [
    {id: 'occurrence:one', sourceReadable: true, title: '<A & B>', artist: 'Artist', album: 'Album', duration_seconds: 125, timing: 'next', canPlay: true, ready: true},
    {id: 'occurrence:missing', sourceReadable: true, title: 'Missing readable', artist: 'Artist', album: 'Known album', duration_seconds: null, timing: 'next', canPlay: false, ready: false, availability: 'missing'},
    {id: 'occurrence:zero', sourceReadable: true, title: 'Actual zero', duration_seconds: 0, timing: 'next', canPlay: false},
    {id: 'occurrence:denied', sourceReadable: false, title: '', artist: '', album: '', duration_seconds: null, timing: 'next', canPlay: false},
  ];
  const value = {enabled: true, revision: 1, entries: rows}, reads = [], configs = [];
  const api = {getSnapshot: () => value, subscribe: () => () => {}, subscribeTrackPreferences: () => () => {},
    timingOptions: () => [{value: 'next', label: 'Next', enabled: true}],
    trackPreference: (row, context) => {reads.push({row, context}); return row.id === 'occurrence:one'
      ? {identity: 'opaque:actor', love_tier: 'loved', rating: null, allowed_actions: {can_set_love_tier: true}} : null;},
    setTrackLove: () => {throw new Error('SSR must not mutate preferences');}};
  const runtime = {escapeHtml: native.context.escapeHtml,
    tableHtml: config => {configs.push(config); return native.context.buildCompactDataTable(config);},
    actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
    buttonHtml: config => native.context.ButtonComponent.renderButton(config),
    iconHtml: (name, options) => native.context.ButtonComponent.renderIconSvg(name, options),
    openChoice: () => {throw new Error('SSR must not open a menu');}};
  const markup = renderToStaticMarkup(React.createElement(QueuePanel, {runtime, api, value, scopeKey: 'own:scope'}));
  assert.ok(configs.length, 'Queue renders its actual native table configuration');
  const table = configs.at(-1), host = native.document.createElement('div');
  host.innerHTML = native.context.buildCompactDataTable(table);
  return {native, markup, table, host, rows, reads};
}
test('Queue native table contains real Love and Length projections and optional controls without synthetic listen facts', () => {
  const {table, markup, host, reads} = fixture();
  const keys = table.columnsConfig.map(column => column.key);
  assert.ok(keys.includes('love_tier'), 'shared Love column'); assert.ok(keys.includes('duration'), 'Length column');
  assert.ok(keys.includes('title')); assert.ok(keys.includes('actions')); assert.ok(keys.includes('timing'));
  for (const key of ['play_count', 'popularity_count', 'last_listened_at', 'rating']) assert.equal(keys.includes(key), false, `No unprojected ${key}`);
  assert.match(markup, /data-track-table-columns=/, 'shared columns action is mounted');
  assert.equal(reads.some(read => read.row.id === 'occurrence:one' && read.context?.scopeKey === 'own:scope'), true, 'native preference adapter receives occurrence and current context');
  const first = host.querySelector('[data-queue-row="occurrence:one"]');
  assert.equal(first.querySelector('[data-track-love]').getAttribute('data-love-tier'), 'loved');
  assert.equal(first.querySelector('[data-cdt-column="duration"]').textContent, '2:05');
  assert.match(first.querySelector('[data-cdt-column="title"]').textContent, /<A & B>/);
  assert.equal(first.querySelector('[data-queue-play]').disabled, false);
});
test('Queue missing metadata remains selectable with no Play and unknown duration differs from actual zero', () => {
  const {host} = fixture();
  const missing = host.querySelector('[data-queue-row="occurrence:missing"]');
  assert.equal(missing.getAttribute('tabindex'), '0');
  assert.equal(missing.querySelector('[data-queue-play]'), null, 'No disabled or hidden Play substitute');
  assert.equal(missing.querySelector('[data-cdt-column="duration"]').textContent, '–');
  assert.equal(host.querySelector('[data-queue-row="occurrence:zero"]').querySelector('[data-cdt-column="duration"]').textContent, '0:00');
  const denied = host.querySelector('[data-queue-row="occurrence:denied"]');
  assert.equal(denied.getAttribute('tabindex'), '-1'); assert.equal(denied.querySelector('[data-track-love]'), null);
});
test('Queue native markup never publishes opaque preference identities as DOM attributes', () => {
  const {host, markup, native} = fixture();
  assert.doesNotMatch(host.innerHTML + markup, /opaque:actor|canonical_track_ref|inventory_track_ref|track_key/);
  assert.deepEqual(native.forbiddenCalls, []);
});
