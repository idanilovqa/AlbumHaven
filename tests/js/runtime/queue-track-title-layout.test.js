// Structural regression for the narrow Queue identity cell. Uses real React
// SSR and canonical native markup; this does not claim browser geometry.
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
  const code = buildSync({entryPoints: [path.join(root, 'music_app/static/js/home-friends/queue.jsx')], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/client']}).outputFiles[0].text;
  const loaded = new Module(`${__filename}.fixture.cjs`, module);
  loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
  loaded._compile(code, loaded.filename); QueuePanel = loaded.exports.QueuePanel;
});
function render(patch = {}, timingLabel = 'Next') {
  const env = createNativeHomeRuntime(), rows = [{id: 'queue:owned-row', title: 'A title', artist: 'Artist',
    album: 'Album', timing: 'next', duration_seconds: 120, sourceReadable: true, canPlay: true, ...patch}];
  vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime/compact-data-table.js'), 'utf8'), env.context);
  const value = {enabled: true, revision: 1, entries: rows}; let table;
  const api = {getSnapshot: () => value, subscribe: () => () => {}, trackPreference: () => null,
    subscribeTrackPreferences: () => () => {}, timingOptions: () => [{value: 'next', label: timingLabel, enabled: true}]};
  const runtime = {escapeHtml: env.context.escapeHtml,
    tableHtml: config => {table = config; return env.context.buildCompactDataTable(config);},
    actionHtml: config => env.context.ButtonComponent.renderActionButton(config),
    buttonHtml: config => env.context.ButtonComponent.renderButton(config),
    iconHtml: (name, options) => env.context.ButtonComponent.renderIconSvg(name, options)};
  renderToStaticMarkup(React.createElement(QueuePanel, {runtime, api, value, scopeKey: 'scope:own'}));
  assert.ok(table, 'Queue produces native table configuration');
  const host = env.document.createElement('div'); host.innerHTML = env.context.buildCompactDataTable(table);
  const cell = host.querySelector('[data-cdt-column="title"][role="cell"]');
  assert.ok(cell, 'native title cell exists'); return {cell, env, host};
}
test('Queue Play shares the canonical flex row with one bounded identity block and a separated secondary line', () => {
  const {cell, env} = render();
  const release = cell.querySelector('.home-detail__release'); assert.ok(release, 'reuse the canonical flex identity owner');
  const play = release.querySelector('[data-queue-play]'), identity = release.querySelector('.album-track-table__title');
  assert.ok(play); assert.ok(identity);
  assert.equal(play.parentNode, release); assert.equal(identity.parentNode, release, 'Play and identity are flex siblings');
  assert.equal(release.children.length, 2, 'no extra artwork or presentation owner');
  const secondary = identity.querySelector('.album-track-table__secondary'); assert.ok(secondary);
  assert.equal(secondary.textContent, 'Artist · Next', 'artist and timing have an explicit separator');
  assert.equal(cell.querySelector('.album-track-table__artist'), null, 'no undefined legacy artist class');
  assert.deepEqual(env.forbiddenCalls, []);
});
test('Queue identity and timing remain escaped text inside shared wrappers', () => {
  const title = '<img src=x onerror=alert(1)> & Title', artist = '<b>Artist</b> &', timing = '<script>bad()</script> Next';
  const {cell} = render({title, artist}, timing);
  assert.equal(cell.querySelector('img'), null); assert.equal(cell.querySelector('script'), null); assert.equal(cell.querySelector('b'), null);
  const identity = cell.querySelector('.album-track-table__title'); assert.ok(identity);
  assert.equal(identity.querySelector('.album-track-table__secondary').textContent, `${artist} · ${timing}`);
  assert.ok(identity.textContent.startsWith(title));
  assert.equal(cell.querySelector('[data-queue-play]').getAttribute('aria-label'), `Play ${title}`);
});
test('Queue missing-readable title keeps selection and timing-only secondary without Play or dangling separator', () => {
  const {cell, host} = render({artist: '', canPlay: false, availability: 'missing'});
  const identity = cell.querySelector('.home-detail__release .album-track-table__title'); assert.ok(identity);
  assert.equal(identity.querySelector('.album-track-table__secondary').textContent, 'Next');
  assert.equal(cell.querySelector('[data-queue-play]'), null);
  assert.equal(host.querySelector('[data-queue-row]').getAttribute('tabindex'), '0');
});
