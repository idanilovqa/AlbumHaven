'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, fixture} = require('./home-friends-native-app-fixture.cjs');
const dto = (state = 'accepted', next_step = 'none', show_status = true) => ({state, next_step, show_status});
const own = {account_ref: null, kind: 'listens'};
const occurrence = (scrobble_delivery = dto()) => ({id: 'event:1', kind: 'listen', source_readable: true,
  title: 'Song <safe>', artist: 'Artist', availability: 'local', scrobble_delivery});
const pairs = {
  not_eligible: ['none'], unknown: ['none'], accepted: ['none'],
  delivery_unconfirmed: ['none', 'check_delivery', 'check_connection'],
  not_sent: ['none', 'retry_check', 'check_connection'],
  reauthentication_required: ['none', 'reauthenticate', 'check_connection'],
  rejected: ['none', 'review_failure', 'check_connection'],
  retry_exhausted: ['none', 'review_failure', 'check_connection'],
};
test('closed delivery DTO accepts exactly the documented state-step pairs and boolean visibility', async () => {
  const {normalizeRecentScrobbleDelivery: normalize} = await load('recent-scrobble-delivery.mjs');
  for (const state of Object.keys(pairs)) for (const step of ['none', 'check_delivery', 'check_connection', 'retry_check', 'reauthenticate', 'review_failure']) {
    for (const visible of [true, false]) {
      const input = Object.freeze(dto(state, step, visible)), output = normalize(input);
      const valid = pairs[state].includes(step) && (visible || step === 'none');
      if (!valid) {assert.equal(output, null, state + '/' + step + '/' + visible); continue;}
      assert.deepEqual(output, input); assert.notEqual(output, input); assert.ok(Object.isFrozen(output));
      assert.deepEqual(Object.keys(output).sort(), ['next_step', 'show_status', 'state']);
    }
  }
});
test('malformed delivery objects fail closed without trusting extra data or inherited fields', async () => {
  const {normalizeRecentScrobbleDelivery: normalize} = await load('recent-scrobble-delivery.mjs');
  const bad = [undefined, null, false, 1, 'accepted', [], {}, Object.create(dto()),
    {...dto(), raw_error: '<script>private</script>'}, {...dto(), state: 'constructor'},
    {...dto(), state: '__proto__'}, {...dto(), next_step: 'send'}, {...dto(), next_step: null}];
  for (const key of ['state', 'next_step', 'show_status']) {const value = dto(); delete value[key]; bad.push(value);}
  for (const value of [0, 1, 'true', 'false', null, undefined, {}, []]) bad.push({...dto(), show_status: value});
  for (const input of bad) assert.equal(normalize(input), null);
});
test('all delivery labels use a passive named native icon with snapshot-qualified, distinct facts', async t => {
  const h = fixture(t), {recentScrobbleDeliveryHtml: render} = await load('recent-scrobble-delivery.mjs');
  const labels = new Map();
  for (const state of Object.keys(pairs)) {
    const host = h.document.createElement('div');
    host.innerHTML = render(h.runtime, occurrence(dto(state)), own);
    const icon = host.querySelector('[data-recent-scrobble-delivery]');
    assert.ok(icon); assert.equal(icon.tagName, 'SPAN'); assert.equal(icon.getAttribute('role'), 'img');
    assert.equal(icon.getAttribute('data-recent-scrobble-delivery'), state);
    const label = icon.getAttribute('aria-label'); labels.set(state, label);
    assert.match(label, /^At this history snapshot: /); assert.equal(icon.getAttribute('title'), label);
    assert.equal(icon.querySelectorAll('svg[aria-hidden="true"]').length, 1);
    assert.equal(host.querySelectorAll('button, a, input, [tabindex], [onclick], [data-action]').length, 0);
    assert.equal(icon.listeners.length, 0);
    assert.doesNotMatch(host.innerHTML, /<script|can_send|retry-scrobble|data-home-activity-play/);
  }
  assert.equal(new Set(labels.values()).size, 8);
  assert.match(labels.get('unknown'), /unknown/);
  assert.match(labels.get('delivery_unconfirmed'), /unconfirmed.*does not mean.*not sent/);
  assert.match(labels.get('accepted'), /accepted this play/);
  const hint = render(h.runtime, occurrence(dto('not_sent', 'retry_check')), own);
  assert.match(hint, /fresh check/); assert.doesNotMatch(hint, /<button|onclick|tabindex/);
  const readiness = render(h.runtime, occurrence(dto('not_sent', 'check_connection')), own);
  assert.match(readiness, /readiness could not be established/); assert.doesNotMatch(readiness, /is disconnected|ready to send/);
});
test('own readable occurrence provenance is required; social, grouped and live rows never gain a status', async t => {
  const h = fixture(t), {recentScrobbleDeliveryHtml: render} = await load('recent-scrobble-delivery.mjs');
  for (const context of [undefined, {}, {kind: 'listens'}, {...own, account_ref: 'friend:1'},
    {...own, kind: 'tracks'}, {...own, kind: 'albums'}, {...own, kind: 'artists'}]) {
    assert.equal(render(h.runtime, occurrence(), context), '');
  }
  for (const patch of [{kind: 'track'}, {kind: 'album'}, {kind: 'artist'}, {kind: 'now_playing'},
    {source_readable: false}, {source_readable: undefined}, {scrobble_delivery: undefined},
    {scrobble_delivery: dto('unknown', 'none', false)},
    {scrobble_delivery: {...dto(), raw_error: 'PRIVATE'}}]) {
    assert.equal(render(h.runtime, {...occurrence(), ...patch}, own), '');
  }
});
test('actual activity row adds only title status and preserves native identity, cells and controls', async t => {
  const h = fixture(t), {activityTrackRow} = await load('activity-tracks.mjs');
  const row = Object.freeze(occurrence(dto('not_sent', 'retry_check')));
  const cells = {artist: {content: 'Artist'}, time: {content: '<time>retained</time>'}};
  const without = activityTrackRow(h.runtime, {...row, scrobble_delivery: undefined}, 4, own, cells);
  const withStatus = activityTrackRow(h.runtime, row, 4, own, cells);
  for (const key of ['key', 'className', 'tabIndex', 'ariaDisabled']) assert.equal(withStatus[key], without[key]);
  assert.deepEqual(withStatus.dataAttributes, without.dataAttributes);
  for (const key of Object.keys(without.cells).filter(key => key !== 'title')) assert.deepEqual(withStatus.cells[key], without.cells[key]);
  const a = h.document.createElement('div'), b = h.document.createElement('div');
  a.innerHTML = withStatus.cells.title.content; b.innerHTML = without.cells.title.content;
  const icon = a.querySelector('[data-recent-scrobble-delivery]'); assert.ok(icon); icon.remove();
  assert.equal(a.innerHTML, b.innerHTML, 'removing passive icon leaves native title/select/artwork byte-equivalent');
  assert.match(a.textContent, /Song <safe>/);
  assert.equal(row.scrobble_delivery.next_step, 'retry_check');
});

