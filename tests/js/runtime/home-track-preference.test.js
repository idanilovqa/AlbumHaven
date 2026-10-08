const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
let preferences, model;
test.before(async () => {
  preferences = await import('../../../music_app/static/js/home-friends/track-preference.mjs');
  model = await import('../../../music_app/static/js/playlists/model.mjs');
});
const saved = (love_tier = 'off', patch = {}) => ({identity: 'opaque:one', love_tier, rating: null,
  allowed_actions: {can_set_love_tier: true}, ...patch});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(preference = saved()) {
  const row = Object.freeze({id: 'row:one', title: 'Owned track', source_readable: true}), calls = [], errors = [], changes = [];
  const response = deferred();
  const runtime = {trackPreference: () => preference, setTrackLove: request => {calls.push(request); return response.promise;}};
  let view = {runtime, rows: [row], source: {}, context: {scopeKey: 'scope:one', account_ref: null, kind: 'tracks', period: 'month'}};
  const controller = preferences.createTrackPreferenceController({getView: () => view, onChange: () => changes.push(true), onError: value => errors.push(value)});
  return {row, runtime, controller, calls, errors, changes, response, get view() {return view;},
    setView(value) {view = value;}, setPreference(value) {preference = value;}};
}

test('Love requires an exact current native preference and setter, never row-granted authority', async () => {
  for (const value of [null, saved('unknown'), saved('off', {identity: ''}),
    saved('off', {allowed_actions: {can_set_love_tier: 'true'}}), saved('off', {allowed_actions: Object.create({can_set_love_tier: true})})]) {
    const sample = fixture(value);
    assert.equal(sample.controller.get(sample.row).editable, false);
    assert.equal(await sample.controller.cycle(sample.row), false); assert.equal(sample.calls.length, 0);
  }
  const sample = fixture(); sample.runtime.setTrackLove = undefined;
  assert.equal(sample.controller.get(sample.row).editable, false);
  assert.equal(await sample.controller.cycle(sample.row), false);
});

test('one desired-state call stays pending, deduplicates and displays only native acknowledgement', async () => {
  const sample = fixture(), result = sample.controller.cycle(sample.row);
  assert.equal(sample.controller.get(sample.row).pending, true);
  assert.equal(sample.controller.get(sample.row).preference.love_tier, 'off');
  assert.equal(await sample.controller.cycle(sample.row), false); await turn();
  assert.equal(sample.calls.length, 1); const request = sample.calls[0];
  assert.equal(request.row, sample.row); assert.equal(request.love_tier, 'loved'); assert.equal(request.signal.aborted, false);
  assert.deepEqual(Object.keys(request).sort(), ['context', 'love_tier', 'row', 'signal']);
  sample.setPreference(saved('loved')); sample.response.resolve(saved('loved'));
  assert.equal(await result, true); assert.equal(sample.controller.get(sample.row).pending, false);
  assert.equal(sample.controller.get(sample.row).preference.love_tier, 'loved'); assert.deepEqual(sample.errors, []);
});

test('Loved advances to Obsessed, Obsessed to off, and ambiguous failures never retry or show success', async () => {
  for (const [before, after] of [['loved', 'obsessed'], ['obsessed', 'off']]) {
    const sample = fixture(saved(before)), result = sample.controller.cycle(sample.row); await turn();
    assert.equal(sample.calls[0].love_tier, after); sample.response.reject(new Error('connection lost'));
    assert.equal(await result, false); assert.equal(sample.calls.length, 1);
    assert.equal(sample.controller.get(sample.row).preference.love_tier, before);
    assert.match(sample.errors[0], /not confirmed/);
  }
});

test('retiring a source, query, scope, row, provider or exact grant aborts and ignores late success', async () => {
  const retirements = [sample => sample.setView({...sample.view, source: {}}),
    sample => sample.setView({...sample.view, context: {...sample.view.context, period: 'week'}}),
    sample => sample.setView({...sample.view, context: {...sample.view.context, scopeKey: 'scope:next'}}),
    sample => sample.setView({...sample.view, rows: []}),
    sample => {sample.runtime.setTrackLove = () => Promise.resolve(saved('loved'));},
    sample => sample.setPreference(saved('off', {allowed_actions: {can_set_love_tier: false}})),
    sample => sample.setPreference(saved('off', {identity: 'opaque:replacement'})),
    sample => sample.setView({...sample.view, isCurrent: () => false})];
  for (const retire of retirements) {
    const sample = fixture(), result = sample.controller.cycle(sample.row); await turn();
    retire(sample); sample.controller.sync(); assert.equal(sample.calls[0].signal.aborted, true);
    sample.response.resolve(saved('loved')); assert.equal(await result, false); assert.deepEqual(sample.errors, []);
  }
});

test('source retirement before the deferred send never writes; cancellation silences a late rejection', async () => {
  const sample = fixture(), result = sample.controller.cycle(sample.row);
  sample.setView({...sample.view, rows: []}); sample.controller.sync();
  assert.equal(await result, false); assert.equal(sample.calls.length, 0);
  for (const error of [new Error('late rejection'), Object.assign(new Error('late denial'), {status: 403})]) {
    const cancelled = fixture(), pending = cancelled.controller.cycle(cancelled.row); await turn();
    cancelled.controller.cancel(); assert.equal(cancelled.calls[0].signal.aborted, true);
    cancelled.response.reject(error); assert.equal(await pending, false); assert.deepEqual(cancelled.errors, []);
  }
});

test('a wrong identity or tier cannot become successful feedback', async () => {
  for (const acknowledgement of [null, saved('loved', {identity: 'opaque:other'}), saved('obsessed'),
    saved('loved', {allowed_actions: {can_set_love_tier: false}})]) {
    const sample = fixture(), result = sample.controller.cycle(sample.row); await turn();
    sample.response.resolve(acknowledgement); assert.equal(await result, false);
    assert.equal(sample.errors.length, 1); assert.equal(sample.controller.get(sample.row).preference.love_tier, 'off');
  }
});

test('permission rejection remains visible when the native subscription first retires its edit grant', async () => {
  const sample = fixture(), result = sample.controller.cycle(sample.row); await turn();
  sample.setPreference(saved('off', {allowed_actions: {can_set_love_tier: false}})); sample.controller.sync();
  sample.response.reject(Object.assign(new Error('denied'), {status: 403}));
  assert.equal(await result, false); assert.match(sample.errors[0], /no longer have permission/);
  const retired = fixture(), pending = retired.controller.cycle(retired.row); await turn();
  retired.setPreference(saved('off', {allowed_actions: {can_set_love_tier: false}})); retired.controller.sync(); retired.controller.cancel();
  retired.response.reject(Object.assign(new Error('late denial'), {status: 403}));
  assert.equal(await pending, false); assert.deepEqual(retired.errors, []);
});

test('native Love paint retains the button through pending and acknowledged state; denied facts are redacted', () => {
  const native = createNativeHomeRuntime(), document = native.document;
  const runtime = {escapeHtml: native.context.escapeHtml, setTrackLove() {},
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value), iconHtml: native.context.ButtonComponent.renderIconSvg};
  const row = {title: '<track>', love_tier: 'off'}, host = document.createElement('div'); document.body.appendChild(host);
  host.innerHTML = preferences.trackLoveHtml(runtime, row, {preference: saved()});
  const cell = host.querySelector('[data-track-love-cell]'), button = cell.querySelector('button');
  Object.getPrototypeOf(button).focus = function () {document.activeElement = this;}; button.focus();
  assert.match(button.className, /action-button/); assert.equal(button.getAttribute('aria-label'), 'Love: <track>');
  preferences.paintTrackLoveCell(cell, runtime, row, {preference: saved(), pending: true});
  assert.equal(cell.querySelector('button'), button); assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
  document.activeElement = document.body;
  preferences.paintTrackLoveCell(cell, runtime, row, {preference: saved('loved')});
  assert.equal(cell.querySelector('button'), button); assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, button);
  assert.match(button.getAttribute('aria-label'), /Mark Obsessed/);
  preferences.paintTrackLoveCell(cell, runtime, row, {preference: saved('loved'), pending: true});
  const other = document.createElement('button'); document.body.appendChild(other); document.activeElement = other;
  preferences.paintTrackLoveCell(cell, runtime, row, {preference: saved('obsessed')});
  assert.equal(document.activeElement, other);
  button.focus(); preferences.paintTrackLoveCell(cell, runtime, row, {preference: saved('obsessed'), pending: true});
  document.activeElement = document.body; host.innerHTML = preferences.trackLoveHtml(runtime, row);
  preferences.paintTrackLoveCell(host.querySelector('[data-track-love-cell]'), runtime, row, {preference: saved('off')});
  assert.equal(document.activeElement, host.querySelector('button'));
  for (const invalid of [{...row, source_readable: false}, {...row, allowed_actions: {can_read: false}}, Object.assign([], row)]) {
    host.innerHTML = preferences.trackLoveHtml(runtime, invalid, {preference: saved()});
    assert.equal(host.querySelector('button'), null); assert.equal(host.querySelector('[role="img"]').getAttribute('aria-label'), 'Love unavailable');
  }
  host.innerHTML = preferences.trackLoveHtml(runtime, {title: 'Friend', love_tier: 'obsessed'});
  assert.equal(host.querySelector('button'), null); assert.equal(host.querySelector('[role="img"]').getAttribute('aria-label'), 'Obsessed');
  host.innerHTML = preferences.trackLoveHtml(runtime, {title: 'Friend', love_tier: null, track_preference: {love_tier: 'loved'}});
  assert.equal(host.querySelector('button'), null); assert.equal(host.querySelector('[role="img"]').getAttribute('aria-label'), 'Loved');
});

test('ack-aware filtering preserves original row identity and authored draft order', () => {
  const rows = [Object.freeze({playlist_item_id: 'a', love_tier: 'off'}), Object.freeze({playlist_item_id: 'b', love_tier: 'loved'})];
  const detail = {track_rows: rows}, draft = {item_order: ['b', 'a']};
  const project = row => ({...row, love_tier: row.playlist_item_id === 'a' ? 'obsessed' : 'loved'});
  const loved = model.visiblePlaylistRows(detail, draft, {love: 'loved', includeUnknown: false}, Date.now(), project);
  assert.deepEqual(loved, [rows[1], rows[0]]); assert.equal(loved[1], rows[0]);
  assert.deepEqual(model.visiblePlaylistRows(detail, draft, {love: 'obsessed', includeUnknown: false}, Date.now(), project), [rows[0]]);
  assert.equal(rows[0].love_tier, 'off'); assert.deepEqual(draft.item_order, ['b', 'a']);
});
