// Actual native Queue owner and canonical identity wrappers. These bounded DOM checks do
// not claim browser geometry; queueTrackMetadata.spec.js owns that acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture} = require('./playlist-native-review-fixture.cjs');
let mountQueuePanel;
test.before(async () => {({mountQueuePanel} = await import('../../../music_app/static/js/home-friends/queue.mjs'));});
function render(t, patch = {}, timingLabel = 'Next') {
  const env = nativeFixture(), host = env.host, baseline = env.listeners().length;
  const subscriptions = new Set();
  const subscribe = listener => {subscriptions.add(listener); return () => subscriptions.delete(listener);};
  const rows = [{id: 'queue:owned-row', title: 'A title', artist: 'Artist',
    album: 'Album', timing: 'next', duration_seconds: 120, sourceReadable: true, canPlay: true, ...patch}];
  const value = {enabled: true, revision: 1, entries: rows}; let table;
  const api = {getSnapshot: () => value, subscribe, trackPreference: () => null,
    subscribeTrackPreferences: subscribe, timingOptions: () => [{value: 'next', label: timingLabel, enabled: true}]};
  const runtime = {escapeHtml: env.context.escapeHtml,
    tableHtml: config => {table = config; return env.context.buildCompactDataTable(config);},
    actionHtml: config => env.context.ButtonComponent.renderActionButton(config),
    buttonHtml: config => env.context.ButtonComponent.renderButton(config),
    iconHtml: (name, options) => env.context.ButtonComponent.renderIconSvg(name, options)};
  const owner = mountQueuePanel(host, runtime, {api, value, scopeKey: 'scope:own'});
  t.after(() => {
    try {owner.dispose(); assert.equal(host.childNodes.length, 0);
      assert.equal(subscriptions.size, 0); assert.equal(env.listeners().length, baseline);}
    finally {host.remove();}
  });
  assert.ok(subscriptions.size > 0, 'actual native owner acquires provider subscriptions');
  assert.ok(table, 'Queue produces native table configuration');
  const cell = host.querySelector('[data-cdt-column="title"][role="cell"]');
  assert.ok(cell, 'native title cell exists'); return {cell, env, host};
}
test('Queue Play shares the canonical flex row with one bounded identity block and a separated secondary line', t => {
  const {cell, env} = render(t);
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
test('Queue identity and timing remain escaped text inside shared wrappers', t => {
  const title = '<img src=x onerror=alert(1)> & Title', artist = '<b>Artist</b> &', timing = '<script>bad()</script> Next';
  const {cell} = render(t,{title, artist}, timing);
  assert.equal(cell.querySelector('img'), null); assert.equal(cell.querySelector('script'), null); assert.equal(cell.querySelector('b'), null);
  const identity = cell.querySelector('.album-track-table__title'); assert.ok(identity);
  assert.equal(identity.querySelector('.album-track-table__secondary').textContent, `${artist} · ${timing}`);
  assert.ok(identity.textContent.startsWith(title));
  assert.equal(cell.querySelector('[data-queue-play]').getAttribute('aria-label'), `Play ${title}`);
});
test('Queue missing-readable title keeps selection and timing-only secondary without Play or dangling separator', t => {
  const {cell, host} = render(t,{artist: '', canPlay: false, availability: 'missing'});
  const identity = cell.querySelector('.home-detail__release .album-track-table__title'); assert.ok(identity);
  assert.equal(identity.querySelector('.album-track-table__secondary').textContent, 'Next');
  assert.equal(cell.querySelector('[data-queue-play]'), null);
  assert.equal(host.querySelector('[data-queue-row]').getAttribute('tabindex'), '0');
});
