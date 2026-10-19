const test = require('node:test');
const assert = require('node:assert/strict');
let createTopQueuePlan;
test.before(async () => ({createTopQueuePlan} = await import('../../../music_app/static/js/album-tops/queue-plan.mjs')));
const blocks = () => [{id: 'a', tracks: ['a1', 'a2', 'a3']}, {id: 'b', tracks: ['b1', 'b2']}, {id: 'c', tracks: ['c1', 'c2']}];
const forward = (plan, options) => {const id = plan.candidate(options); if (id) assert.equal(plan.commit(id), true); return id;};
function assertBlocks(plan) {
  const ids = plan.snapshot().order.map(id => plan.albumFor(id));
  const entered = new Set(); let prior;
  for (const id of ids) {if (id !== prior) {assert.equal(entered.has(id), false); entered.add(id); prior = id;}}
}
test('capture copies canonical order without mutating input and exposes frozen snapshots', () => {
  const input = blocks(), plan = createTopQueuePlan(input), first = plan.snapshot();
  assert.deepEqual(first.order, ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2']);
  assert.equal(first.mode, 'in_order'); assert.equal(first.stopAfterAlbum, false);
  input[0].tracks.reverse(); input.reverse();
  assert.deepEqual(plan.snapshot().order, first.order);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.order));
  assert.equal(first.visitedEnd, -1); assert.equal(plan.commit(first.currentId), true);
  assert.equal(plan.snapshot().visitedEnd, 0); assert.equal(first.visitedEnd, -1);
});
test('random albums permutes whole blocks and never repeats an album in the cycle', () => {
  const plan = createTopQueuePlan(blocks(), {mode: 'random_albums', random: () => 0});
  assert.deepEqual(plan.snapshot().order, ['b1', 'b2', 'c1', 'c2', 'a1', 'a2', 'a3']);
  assertBlocks(plan); assert.equal(new Set(plan.snapshot().order).size, 7);
});
test('random songs permutes only inside each captured album', () => {
  const plan = createTopQueuePlan(blocks(), {mode: 'random_songs', random: () => 0});
  assert.deepEqual(plan.snapshot().order, ['a2', 'a3', 'a1', 'b2', 'b1', 'c2', 'c1']);
  assertBlocks(plan);
});
test('mode edits preserve current occurrence and the complete furthest visited prefix after Previous', () => {
  const plan = createTopQueuePlan(blocks(), {random: () => 0});
  plan.commit('a1'); forward(plan); forward(plan); forward(plan);
  assert.equal(plan.snapshot().currentId, 'b1');
  const prefix = plan.snapshot().order.slice(0, 4);
  forward(plan, {direction: -1}); forward(plan, {direction: -1});
  assert.equal(plan.snapshot().currentId, 'a2'); assert.equal(plan.snapshot().visitedEnd, 3);
  for (const mode of ['random_albums', 'random_songs', 'in_order']) {
    assert.equal(plan.configure({mode}), true);
    assert.equal(plan.snapshot().currentId, 'a2'); assert.equal(plan.snapshot().currentIndex, 1);
    assert.equal(plan.snapshot().visitedEnd, 3); assert.deepEqual(plan.snapshot().order.slice(0, 4), prefix);
    assertBlocks(plan); assert.equal(new Set(plan.snapshot().order).size, 7);
  }
});
test('changing modes finishes the partly visited album before random unvisited albums', () => {
  const plan = createTopQueuePlan(blocks(), {random: () => 0});
  plan.commit('a1');
  assert.equal(plan.configure({mode: 'random_albums'}), true);
  assert.deepEqual(plan.snapshot().order, ['a1', 'a2', 'a3', 'c1', 'c2', 'b1', 'b2']);
  assert.equal(plan.configure({mode: 'random_songs'}), true);
  assert.deepEqual(plan.snapshot().order, ['a1', 'a3', 'a2', 'b2', 'b1', 'c2', 'c1']);
  assert.equal(plan.snapshot().currentId, 'a1'); assertBlocks(plan);
});
test('Stop after current album blocks automatic crossing, while explicit Next stays deliberate', () => {
  const plan = createTopQueuePlan(blocks(), {stopAfterAlbum: true});
  plan.commit('a1'); forward(plan); forward(plan);
  const stopped = plan.snapshot();
  assert.equal(plan.candidate(), null); assert.equal(plan.snapshot(), stopped);
  assert.equal(plan.candidate({automatic: false}), 'b1');
  assert.equal(forward(plan, {automatic: false}), 'b1');
  assert.equal(plan.snapshot().stopAfterAlbum, true);
  assert.equal(forward(plan), 'b2'); assert.equal(plan.candidate(), null);
  assert.equal(plan.configure({stopAfterAlbum: false}), true); assert.equal(plan.candidate(), 'c1');
});
test('stop-only edits do not rerandomize, restart or discard history', () => {
  let samples = 0;
  const plan = createTopQueuePlan(blocks(), {mode: 'random_albums', random: () => {samples++; return 0;}});
  plan.commit(plan.snapshot().currentId); forward(plan);
  const before = plan.snapshot(), count = samples;
  assert.equal(plan.configure({stopAfterAlbum: true}), true);
  assert.deepEqual(plan.snapshot().order, before.order); assert.equal(plan.snapshot().currentId, before.currentId);
  assert.equal(plan.snapshot().visitedEnd, before.visitedEnd); assert.equal(samples, count);
});
test('previewing or failed/stale transitions never advances visited history', () => {
  const plan = createTopQueuePlan(blocks()), first = plan.snapshot();
  assert.equal(plan.candidate(), 'a2'); assert.equal(plan.candidate(), 'a2');
  assert.equal(plan.snapshot(), first); assert.equal(plan.commit('c1'), false);
  assert.equal(plan.commit('missing'), false); assert.equal(plan.snapshot(), first);
  plan.commit('a1'); assert.equal(plan.commit('a2', first), false);
  assert.equal(plan.configure({mode: 'random_albums'}, first), false);
  assert.equal(plan.snapshot().currentId, 'a1');
});
test('end and start remain bounded; Previous deliberately replays visited occurrences', () => {
  const plan = createTopQueuePlan([{id: 'a', tracks: ['a1', 'a2']}]);
  plan.commit('a1'); assert.equal(plan.candidate({direction: -1}), null);
  forward(plan); assert.equal(plan.candidate(), null); assert.equal(plan.candidate({automatic: false}), null);
  forward(plan, {direction: -1}); assert.equal(plan.snapshot().currentId, 'a1');
  assert.equal(plan.snapshot().visitedEnd, 1); assert.equal(forward(plan), 'a2');
});
test('unavailable global popularity and malformed mode changes preserve the accepted plan', () => {
  const plan = createTopQueuePlan(blocks()), current = plan.snapshot();
  for (const mode of ['popular_songs', 'personal_plays', '', null]) assert.equal(plan.configure({mode}), false);
  assert.equal(plan.configure({stopAfterAlbum: 1}), false); assert.equal(plan.snapshot(), current);
  assert.throws(() => createTopQueuePlan(blocks(), {mode: 'popular_songs'}), TypeError);
});
test('duplicate, sparse, empty and malformed identities are rejected before scheduling', () => {
  for (const value of [null, [], Array(1), [{id: 'a', tracks: Array(1)}], [{id: 'a', tracks: []}],
    [{id: 'a', tracks: ['x']}, {id: 'a', tracks: ['y']}], [{id: 'a', tracks: ['x', 'x']}],
    [{id: 'a', tracks: ['x']}, {id: 'b', tracks: ['x']}], [{id: '', tracks: ['x']}]]) {
    assert.throws(() => createTopQueuePlan(value), TypeError);
  }
});
test('random generator failures leave an existing schedule unchanged', () => {
  for (const sample of [-1, 1, NaN, Infinity]) {
    const plan = createTopQueuePlan(blocks(), {random: () => sample}), before = plan.snapshot();
    assert.throws(() => plan.configure({mode: 'random_albums'}), TypeError);
    assert.equal(plan.snapshot(), before);
  }
});
test('a reentrant successor change wins over an older random-mode computation', () => {
  let plan, changed = false;
  plan = createTopQueuePlan(blocks(), {random: () => {
    if (!changed) {changed = true; assert.equal(plan.configure({stopAfterAlbum: true}), true);}
    return 0;
  }});
  const before = plan.snapshot();
  assert.equal(plan.configure({mode: 'random_albums'}, before), false);
  assert.equal(plan.snapshot().mode, 'in_order'); assert.equal(plan.snapshot().stopAfterAlbum, true);
  assert.deepEqual(plan.snapshot().order, before.order);
});
test('failed fresh resolution skips unavailable occurrences without advancing played history', () => {
  const plan = createTopQueuePlan(blocks()); plan.commit('a1');
  const before = plan.snapshot();
  assert.equal(plan.reject('a2', before), true);
  assert.equal(plan.snapshot().currentId, 'a1'); assert.equal(plan.snapshot().visitedEnd, 0);
  assert.deepEqual(plan.snapshot().order, before.order); assert.deepEqual(plan.snapshot().unavailableIds, ['a2']);
  assert.equal(plan.candidate(), 'a3'); assert.equal(plan.commit('a3'), true);
  assert.equal(plan.candidate({direction: -1}), 'a1');
  assert.equal(plan.commit('a2'), false); assert.equal(plan.reject('c2'), false);
  assert.equal(plan.reject('a3', before), false);
});
test('unavailable tail tracks cannot bypass Stop after current album', () => {
  const plan = createTopQueuePlan(blocks(), {stopAfterAlbum: true}); plan.commit('a1');
  assert.equal(plan.reject('a2'), true); assert.equal(plan.reject('a3'), true);
  assert.equal(plan.candidate(), null); assert.equal(plan.candidate({automatic: false}), 'b1');
  assert.equal(plan.snapshot().currentId, 'a1'); assert.equal(plan.snapshot().visitedEnd, 0);
  assert.equal(plan.configure({mode: 'random_albums'}), true); assert.equal(plan.candidate(), null);
});

test('malformed or unknown rejection cannot match an absent adjacent candidate or change the snapshot', () => {
  for (const atEnd of [false, true]) {
    const plan = createTopQueuePlan(blocks());
    if (atEnd) {plan.commit('a1'); while (forward(plan)) {}}
    const before = plan.snapshot();
    assert.equal(plan.candidate({direction: atEnd ? 1 : -1, automatic: false}), null);
    for (const id of [null, undefined, '', 0, false, {}, [], 'unknown']) {
      assert.equal(plan.reject(id), false);
      assert.equal(plan.snapshot(), before, 'Rejected input preserves the exact published snapshot');
    }
  }
});
