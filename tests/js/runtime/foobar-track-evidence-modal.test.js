'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./foobar-track-evidence-fixture.cjs');
async function open(t, value = B.album()) {const f = await B.platform(t), m = f.modal(); m.render(value); await f.flush(); return {f, m, album: value};}
async function choose(f, m, index = 0, value = B.payload()) {
  const at = f.requests.length; f.click(m.controls()[index]); await f.flush();
  assert.equal(f.requests.length, at+1); f.reply(at, value); await f.flush(); return m.owner().host;
}
test('BM01 genuine modal render installs lazy controls but makes zero eager or per-row evidence calls', async t => {
  const {f, m} = await open(t, B.album({tracks: Array.from({length: 40}, (_, n) => B.track(n+11))}));
  assert.equal(m.list.querySelectorAll('.album-track-table__row').length, 40); assert.equal(m.controls().length, 40);
  assert.equal(m.list.querySelectorAll('.play-track-button').length, 40); assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
  for (const control of m.controls()) B.noPrivate(control);
});
test('BM02 actual row control uses exact inventory response identity not labels or path inference', async t => {
  const source = B.track(77, {path: B.track().path, title: 'Duplicate label'});
  const {f, m} = await open(t, B.album({tracks: [B.track(11, {title: 'Duplicate label'})], track_rows: [source]}));
  const host = await choose(f, m, 0, B.payload([B.item()], {track_id: '77'}));
  assert.deepEqual(B.body(f.requests[0]), {version: B.VERSION, track_id: '77', family: 'standard', cursor: null});
  assert.equal(f.imports.length, 1); assert.equal(host.querySelectorAll('section').length, 1); B.noPrivate(host);
});
test('BM03 malformed foreign missing and denied inventory refs never acquire evidence controls', async t => {
  const tracks = [B.track(11), B.track(12, {inventory_track_ref: null}), B.track(13, {inventory_track_ref: 'inventory-track:4:13'}), B.track(14, {inventory_track_ref: 'inventory-track:3:01'}), B.track(15, {inventory_track_ref: 'inventory-track:3:9223372036854775808'}), B.track(16, {allowed_actions: {can_read: false}})];
  const {f, m} = await open(t, B.album({tracks})); assert.equal(m.controls().length, 1); assert.match(m.controls()[0].getAttribute('aria-label'), /Track 11/); assert.equal(f.requests.length, 0);
});
test('BM04 subject unreadable and denied albums cannot attach own-account evidence controls', async t => {
  const f = await B.platform(t), m = f.modal();
  for (const patch of [{read_only_subject: true}, {source_readable: false}, {allowed_actions: {can_read: false}}]) {m.render(B.album(patch)); await f.flush(); assert.equal(m.controls().length, 0);}
  assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
});
test('BM05 account capability and native identity absence fail closed before importing controls', async t => {
  const f = await B.platform(t), m = f.modal();
  for (const [field, value] of [['accountFoobarHistoryAllowed', 'false'], ['nativeAccountId', ''], ['nativeLibraryId', '0']]) {
    Object.assign(f.shell.dataset, {accountFoobarHistoryAllowed: 'true', nativeAccountId: '7', nativeLibraryId: '3'}); f.shell.dataset[field] = value;
    m.render(B.album()); await f.flush(); assert.equal(m.controls().length, 0);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.imports.length, 0);
});
test('BM06 switching native rows retains one detail panel and aborts delayed prior-row response', async t => {
  const {f, m} = await open(t, B.album({tracks: [B.track(11), B.track(12)]}));
  f.click(m.controls()[0]); await f.flush(); const first = m.owner().host; assert.equal(f.requests.length, 1);
  f.click(m.controls()[1]); await f.flush(); const second = m.owner().host;
  assert.equal(first.isConnected, false); assert.notEqual(second, first); assert.equal(m.list.querySelectorAll('.foobar-history').length, 1); assert.equal(f.requests[0].options.signal.aborted, true);
  f.reply(1, B.payload([B.item(2)], {track_id: '12'})); await f.flush(); f.reply(0, B.payload()); await f.flush();
  assert.equal(second.querySelectorAll('section').length, 1); assert.ok(second.textContent.includes(B.item(2).source_ref)); assert.equal(second.textContent.includes(B.item(1).source_ref), false); B.noPrivate(second);
});
test('BM07 consecutive clicks during delayed asset import admit only the latest panel and request', async t => {
  const {f, m} = await open(t); const gate = f.holdImport();
  f.click(m.controls()[0]); const first = m.owner().host; f.click(m.controls()[0]); const last = m.owner().host;
  assert.equal(f.imports.length, 2); assert.equal(first.isConnected, false); assert.equal(f.requests.length, 0);
  gate.resolve(); await f.flush(); assert.equal(f.requests.length, 1); assert.equal(m.owner().host, last);
  f.reply(0, B.payload()); await f.flush(); assert.equal(m.list.querySelectorAll('.foobar-history').length, 1); assert.equal(last.querySelectorAll('section').length, 1);
});
test('BM08 keyboard-owned evidence activation focuses actual heading after successful current import', async t => {
  const {f, m} = await open(t); const control = m.controls()[0]; control.focus();
  const host = await choose(f, m); assert.equal(f.document.activeElement, host.querySelector('h4')); assert.equal(host.querySelector('h4').tabIndex, -1);
});
test('BM09 delayed import cannot steal focus moved to an unrelated native control', async t => {
  const {f, m} = await open(t); const gate = f.holdImport(), control = m.controls()[0], other = m.list.querySelector('.play-track-button');
  control.focus(); f.click(control); other.focus(); gate.resolve(); await f.flush();
  f.reply(0, B.payload()); await f.flush(); assert.equal(f.document.activeElement, other);
});
test('BM10 actual Close removes one detail while preserving lazy reopen and ordinary native controls', async t => {
  const {f, m} = await open(t), host = await choose(f, m); const native = m.list.querySelector('.play-track-button');
  f.click(f.button('Close evidence', host)); assert.equal(host.isConnected, false); assert.equal(m.controls().length, 1); assert.equal(native.isConnected, true);
  const fresh = await choose(f, m); assert.notEqual(fresh, host); assert.equal(f.requests.length, 2); assert.equal(m.list.querySelectorAll('.foobar-history').length, 1);
});
test('BM11 account change retires controls panel and pending read before late reply', async t => {
  const {f, m} = await open(t); const control = m.controls()[0]; f.click(control); await f.flush(); const host = m.owner().host;
  f.shell.dataset.nativeAccountId = '8'; f.mutate(f.shell); assert.equal(m.owner(), null); assert.equal(m.controls().length, 0); assert.equal(host.isConnected, false);
  assert.equal(f.requests[0].options.signal.aborted, true); f.reply(0, B.payload()); await f.flush(); f.click(control); assert.equal(f.requests.length, 1); assert.equal(host.childNodes.length, 0);
});
test('BM12 selected library change retires old-row authority without changing native response data', async t => {
  const {f, m, album} = await open(t); const before = B.clone(album); f.click(m.controls()[0]); await f.flush();
  f.shell.dataset.nativeLibraryId = '4'; f.mutate(f.shell); assert.equal(m.owner(), null); assert.equal(f.requests[0].options.signal.aborted, true);
  f.reply(0, B.payload()); await f.flush(); assert.deepEqual(album, before); assert.equal(m.list.querySelectorAll('.foobar-history').length, 0);
});
test('BM13 private context change retires modal evidence and genuine transport rejects delayed data', async t => {
  const {f, m} = await open(t); f.click(m.controls()[0]); await f.flush();
  f.shell.dataset.privateUiContext = 'd'.repeat(64); f.mutate(f.shell); assert.equal(m.owner(), null); assert.equal(f.requests[0].options.signal.aborted, true);
  f.reply(0, B.payload()); await f.flush(); assert.equal(m.list.querySelectorAll('.foobar-history').length, 0);
});
test('BM14 modal close during delayed asset loading prevents any evidence request', async t => {
  const {f, m} = await open(t); const gate = f.holdImport(); f.click(m.controls()[0]);
  m.overlay.hidden = true; f.mutate(m.overlay); assert.equal(m.owner(), null); gate.resolve(); await f.flush();
  assert.equal(f.requests.length, 0); assert.equal(m.controls().length, 0); assert.equal(m.list.querySelectorAll('.foobar-history').length, 0);
});
test('BM15 album replacement fences old reply observer and retained detached control', async t => {
  const {f, m} = await open(t); const oldControl = m.controls()[0]; f.click(oldControl); await f.flush(); const old = m.owner();
  m.render(B.album({key: 'replacement', tracks: [B.track(12)]})); await f.flush(); const next = m.owner();
  assert.notEqual(next, old); assert.equal(f.requests[0].options.signal.aborted, true); assert.equal(old.observer.active, false);
  old.observer.callback([]); f.reply(0, B.payload()); await f.flush(); f.click(oldControl); assert.equal(m.owner(), next); assert.equal(f.requests.length, 1);
  const host = await choose(f, m, 0, B.payload([B.item(2)], {track_id: '12'})); assert.equal(host.querySelectorAll('section').length, 1);
});
test('BM16 same-album rerender creates fresh ownership and removes the prior one-panel state', async t => {
  const {f, m, album} = await open(t); const host = await choose(f, m), old = m.owner();
  m.render(album); await f.flush(); assert.notEqual(m.owner(), old); assert.equal(host.isConnected, false); assert.equal(m.controls().length, 1); assert.equal(f.requests.length, 1);
  await choose(f, m); assert.equal(f.requests.length, 2);
});
test('BM17 asset failure is explicit and leaves native controls usable without invented empty evidence', async t => {
  const {f, m} = await open(t); f.failImport(); f.click(m.controls()[0]); await f.flush();
  assert.equal(f.requests.length, 0); assert.match(m.owner().host.textContent, /Imported evidence is unavailable/); assert.doesNotMatch(m.owner().host.textContent, /No currently matched|End of current/);
  const native = m.list.querySelector('.play-track-button'); f.c.activateSharedTrackButton(native);
  assert.equal(m.starts.length, 1); assert.equal(m.starts[0].path, B.track().path); assert.ok(m.starts[0].albumListeningIntent);
});
test('BM18 source-specific detail never alters genuine ordinary Album playback queue or intent', async t => {
  const {f, m, album} = await open(t); const host = await choose(f, m); B.noPrivate(host);
  assert.equal(m.starts.length, 0); assert.equal(f.c.state.player.playbackQueue, undefined);
  f.c.activateSharedTrackButton(m.list.querySelector('.play-track-button'));
  assert.equal(m.starts.length, 1); assert.equal(m.starts[0].inventory_track_ref, 'inventory-track:3:11'); assert.equal(m.starts[0].albumListeningIntent.albumKey, album.key);
  assert.equal(f.c.state.player.playbackQueue.albumRef, album.key); assert.equal(f.c.state.player.playbackQueue.tracks.length, 1); assert.equal(f.requests.length, 1);
  assert.ok(f.requests.every(r => r.url === '/integrations/foobar/account/history/native/evidence')); B.noPrivate(host);
});
test('BM19 capability revocation and transport generation retirement remove current evidence controls', async t => {
  const {f, m} = await open(t); await choose(f, m); f.shell.dataset.accountFoobarHistoryAllowed = 'false'; f.mutate(f.shell);
  assert.equal(m.owner(), null); assert.equal(m.controls().length, 0);
  f.shell.dataset.accountFoobarHistoryAllowed = 'true'; m.render(B.album()); await f.flush(); assert.equal(m.controls().length, 1);
  f.transport.invalidate(); assert.equal(m.owner(), null); assert.equal(m.controls().length, 0); assert.equal(f.requests.length, 1);
});
test('BM20 removed native list retires on its next observed mutation and cannot revive an old request', async t => {
  const {f, m} = await open(t); f.click(m.controls()[0]); await f.flush(); const old = m.owner(); m.list.remove(); f.mutate(m.list);
  assert.equal(m.owner(), null); assert.equal(old.observer.active, false); assert.equal(f.requests[0].options.signal.aborted, true);
  f.reply(0, B.payload()); await f.flush(); assert.equal(old.host.isConnected, false); assert.equal(old.host.childNodes.length, 0);
});
