const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture, load} = require('./home-friends-native-app-fixture.cjs');

async function fixture(t) {
  const h = nativeFixture(t), {mountQueueHeader} = await load('queue.mjs');
  const calls = [], confirms = []; let resolve, scope = 'scope:one';
  const api = {clear: ids => calls.push(ids)}, value = {enabled: true, entries: [{id: 'queued:one'}], revision: 1};
  Object.assign(h.runtime, {snapshot: () => ({scopeKey: scope}), confirm: (...args) => {confirms.push(args); return new Promise(done => {resolve = done;});}});
  const owner = h.own(mountQueueHeader(h.host, h.runtime, {api, value}));
  return {calls, confirms, clear() {const button = h.named('Clear queue', h.host); assert.ok(button); h.click(button);},
    accept: answer => resolve(answer), changeScope: () => {scope = 'scope:two';}, dispose: () => owner.dispose()};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('review v2: Queue Clear uses the native string confirmation contract', async t => {
  const f = await fixture(t); f.clear(); assert.equal(typeof f.confirms[0][0], 'string');
  f.accept(false); await settle(); assert.equal(f.calls.length, 0); f.dispose();
});
test('review v2: Queue Clear confirmation cannot act after header unmount or scope change', async t => {
  for (const retire of [f => f.dispose(), f => f.changeScope()]) {
    const f = await fixture(t); f.clear(); retire(f); f.accept(true); await settle();
    assert.equal(f.calls.length, 0); f.dispose();
  }
});
test('review v2: declined Queue Clear leaves the queued tracks intact', async t => {
  const f = await fixture(t); f.clear(); f.accept(false); await settle(); assert.equal(f.calls.length, 0); f.dispose();
});

async function panelFixture(t, {currentMiddle = false} = {}) {
  const h = nativeFixture(t), {mountQueuePanel} = await load('queue.mjs');
  const calls = {reorder: [], play: [], refresh: []};
  const value = {enabled: true, revision: 4, entries: [
    {id: 'current', current: true, sourceReadable: true, title: 'Current'},
    {id: 'a', sourceReadable: true, title: 'A', canPlay: true}, {id: 'b', sourceReadable: true, title: 'B', canPlay: true}]};
  if (currentMiddle) value.entries.splice(1, 0, value.entries.shift());
  const api = {getSnapshot: () => value, subscribe: () => () => {}, timingOptions: () => [],
    refresh: options => {calls.refresh.push(options);}, reorder: ids => calls.reorder.push(ids), play: (id, options) => calls.play.push({id, options})};
  const owner = h.own(mountQueuePanel(h.host, h.runtime, {api, value, scopeKey: 'scope:one'}));
  function click(attribute, id) {
    const button = h.host.querySelector(`[${attribute}="${id}"]`); assert.ok(button, `${attribute} control for ${id}`); h.click(button);
    return button;
  }
  return {calls, click, dispose: () => owner.dispose()};
}
test('Queue reordering excludes the current occurrence and play retires on panel unmount', async t => {
  const f = await panelFixture(t);
  f.click('data-queue-up', 'b'); assert.deepEqual(Array.from(f.calls.reorder[0]), ['b', 'a']);
  const firstUp = f.click('data-queue-up', 'a'); assert.equal(firstUp.disabled, true);
  assert.equal(f.calls.reorder.length, 1, 'current row is not a reorder target');
  f.click('data-queue-play', 'b'); assert.equal(f.calls.play[0].options.isCurrent(), true);
  assert.equal(f.calls.refresh.length, 1); f.dispose();
  assert.equal(f.calls.play[0].options.signal.aborted, true); assert.equal(f.calls.play[0].options.isCurrent(), false);
  assert.equal(f.calls.refresh[0].signal.aborted, true);
});

test('Queue keyboard reorder crosses the current display row using pending neighbors only', async t => {
  const f = await panelFixture(t, {currentMiddle: true}); f.click('data-queue-up', 'b');
  assert.deepEqual(Array.from(f.calls.reorder[0]), ['b', 'a']); f.dispose();
});
