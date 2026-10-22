// Actual native Queue owner and canonical markup. These bounded DOM checks do
// not claim browser geometry; queueTrackMetadata.spec.js owns that acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture} = require('./playlist-native-review-fixture.cjs');
let mountQueuePanel;
test.before(async () => {({mountQueuePanel} = await import('../../../music_app/static/js/home-friends/queue.mjs'));});
function fixture(t) {
  const native = nativeFixture(), host = native.host, baseline = native.listeners().length;
  const subscriptions = new Set();
  const subscribe = listener => {subscriptions.add(listener); return () => subscriptions.delete(listener);};
  const rows = [
    {id: 'occurrence:one', sourceReadable: true, title: '<A & B>', artist: 'Artist', album: 'Album', duration_seconds: 125, timing: 'next', canPlay: true, ready: true},
    {id: 'occurrence:missing', sourceReadable: true, title: 'Missing readable', artist: 'Artist', album: 'Known album', duration_seconds: null, timing: 'next', canPlay: false, ready: false, availability: 'missing'},
    {id: 'occurrence:zero', sourceReadable: true, title: 'Actual zero', duration_seconds: 0, timing: 'next', canPlay: false},
    {id: 'occurrence:denied', sourceReadable: false, title: '', artist: '', album: '', duration_seconds: null, timing: 'next', canPlay: false},
  ];
  const value = {enabled: true, revision: 1, entries: rows}, reads = [], configs = [];
  const api = {getSnapshot: () => value, subscribe, subscribeTrackPreferences: subscribe,
    timingOptions: () => [{value: 'next', label: 'Next', enabled: true}],
    trackPreference: (row, context) => {reads.push({row, context}); return row.id === 'occurrence:one'
      ? {identity: 'opaque:actor', love_tier: 'loved', rating: null, allowed_actions: {can_set_love_tier: true}} : null;},
    setTrackLove: () => {throw new Error('Initial native presentation must not mutate preferences');}};
  const runtime = {escapeHtml: native.context.escapeHtml,
    tableHtml: config => {configs.push(config); return native.context.buildCompactDataTable(config);},
    actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
    buttonHtml: config => native.context.ButtonComponent.renderButton(config),
    iconHtml: (name, options) => native.context.ButtonComponent.renderIconSvg(name, options),
    openChoice: () => {throw new Error('Initial native presentation must not open a menu');}};
  const owner = mountQueuePanel(host, runtime, {api, value, scopeKey: 'own:scope'});
  t.after(() => {
    try {owner.dispose(); assert.equal(host.childNodes.length, 0);
      assert.equal(subscriptions.size, 0); assert.equal(native.listeners().length, baseline);}
    finally {host.remove();}
  });
  assert.ok(subscriptions.size > 0, 'actual native owner acquires provider subscriptions');
  const markup = host.innerHTML;
  assert.ok(configs.length, 'Queue renders its actual native table configuration');
  const table = configs.at(-1);
  return {native, markup, table, host, rows, reads};
}
test('Queue native table contains real Love and Length projections and optional controls without synthetic listen facts', t => {
  const {table, markup, host, reads} = fixture(t);
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
test('Queue missing metadata remains selectable with no Play and unknown duration differs from actual zero', t => {
  const {host} = fixture(t);
  const missing = host.querySelector('[data-queue-row="occurrence:missing"]');
  assert.equal(missing.getAttribute('tabindex'), '0');
  assert.equal(missing.querySelector('[data-queue-play]'), null, 'No disabled or hidden Play substitute');
  assert.equal(missing.querySelector('[data-cdt-column="duration"]').textContent, '–');
  assert.equal(host.querySelector('[data-queue-row="occurrence:zero"]').querySelector('[data-cdt-column="duration"]').textContent, '0:00');
  const denied = host.querySelector('[data-queue-row="occurrence:denied"]');
  assert.equal(denied.getAttribute('tabindex'), '-1'); assert.equal(denied.querySelector('[data-track-love]'), null);
});
test('Queue native markup never publishes opaque preference identities as DOM attributes', t => {
  const {host, markup, native} = fixture(t);
  assert.doesNotMatch(host.innerHTML + markup, /opaque:actor|canonical_track_ref|inventory_track_ref|track_key/);
  assert.deepEqual(native.forbiddenCalls, []);
});
