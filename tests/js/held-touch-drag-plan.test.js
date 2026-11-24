const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/helpers/heldTouchDragPlan.js')).href;

const options = { prefetchViewports: 8, maximumDrag: 233 };
// 614 px gallery, 6720 px content: the continuation threshold is scrollTop 1194.
const geometry = labelBottoms => ({ scrollTop: 900, scrollHeight: 6720, clientHeight: 614, labelBottoms });

test('the drag crosses the continuation threshold without crossing an artist label', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag(geometry([400, 1000, 2400]), options);
  assert.equal(plan.feasible, true);
  assert.equal(plan.threshold, 1194);
  const end = plan.target + plan.drag;
  assert.ok(plan.target < plan.threshold && end > plan.threshold, JSON.stringify(plan));
  assert.ok(plan.target >= 1000 + 24 || end <= 1000 - 24, 'the drag never passes an artist label');
  assert.ok(plan.target >= 1000 + 24 ? end <= 2400 - 24 : true);
});

test('a label just past the threshold shortens the drag so it ends before the label', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag(geometry([400, 1290]), options);
  assert.equal(plan.feasible, true);
  assert.ok(plan.target + plan.drag <= 1290 - 24, JSON.stringify(plan));
  assert.ok(plan.target + plan.drag > plan.threshold, JSON.stringify(plan));
});

test('artist sections too short for a crossing drag are reported, not planned', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag(geometry([1150, 1240]), options);
  assert.equal(plan.feasible, false);
  assert.deepEqual([plan.contextStart, plan.contextEnd], [1150, 1240]);
});

test('the current position is reported inside or outside the start band', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag({ ...geometry([400, 2400]), scrollTop: 1100 }, options);
  assert.equal(plan.inStartBand, plan.scrollTop >= plan.startLow && plan.scrollTop <= plan.startHigh);
  assert.equal(plan.inStartBand, true);
});

test('a label just before the threshold leaves no single-artist crossing', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag(geometry([400, 1180, 2400]), options);
  assert.equal(plan.feasible, false, JSON.stringify(plan));
});

// The hosted failure: a 656 px gallery puts the threshold at 852 inside a 253 px artist section.
const narrowSection = { scrollTop: 788, scrollHeight: 6756, scrollGranularity: 1, labelBottoms: [763.3125, 1016.6875, 1270.0625] };

test('a start band narrower than 1 px plus the scroll granularity is infeasible', async () => {
  const { planSingleArtistHeldDrag, planHeldDragForObservedHeights } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag({ ...narrowSection, clientHeight: 656 }, {
    prefetchViewports: 8, maximumDrag: 249,
  });
  assert.equal(plan.feasible, false, JSON.stringify(plan));
  assert.equal(plan.target, undefined);
  assert.deepEqual([plan.startLow, plan.startHigh, plan.minimumStartBand], [787.3125, 787.6875, 2]);
  const candidates = planHeldDragForObservedHeights(narrowSection, [656, 614], [], {
    prefetchViewports: 8, maximumDragRatio: 0.38,
  });
  assert.equal(candidates.find(candidate => candidate.plan.feasible), undefined, JSON.stringify(candidates));
});

test('the band width needed grows with a coarser scroll granularity', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  // A 50 px drag between margins of 24.25 px on both sides of the threshold leaves a 1.5 px band.
  const base = { ...geometry([400, 2400]), scrollTop: 900 };
  const options = { prefetchViewports: 8, maximumDrag: 50, minimumDrag: 0, thresholdMargin: 24.25 };
  assert.equal(planSingleArtistHeldDrag({ ...base, scrollGranularity: 0.5 }, options).feasible, true);
  assert.equal(planSingleArtistHeldDrag({ ...base, scrollGranularity: 1 }, options).feasible, false);
});

test('the preposition target is the band midpoint, inside the band', async () => {
  const { planSingleArtistHeldDrag } = await import(moduleUrl);
  const plan = planSingleArtistHeldDrag({ ...geometry([400, 1290]), scrollGranularity: 1 / 3 }, options);
  assert.equal(plan.feasible, true);
  assert.equal(plan.target, (plan.startLow + plan.startHigh) / 2);
  assert.ok(plan.target >= plan.startLow && plan.target <= plan.startHigh, JSON.stringify(plan));
});

test('the preposition swipe is never zero: below the 1 px resolution it stops with the numbers', async () => {
  const { prepositionSwipeDistance } = await import(moduleUrl);
  const plan = { target: 787.5, startLow: 787.3125, startHigh: 787.6875 };
  assert.throws(() => prepositionSwipeDistance(plan, 788), error => {
    assert.match(error.message, /1 px swipe resolution/);
    assert.match(error.message, /"scrollTop":788/);
    assert.match(error.message, /"startLow":787.3125/);
    return true;
  });
  assert.equal(prepositionSwipeDistance({ target: 1000.5 }, 600), 280);
  assert.equal(prepositionSwipeDistance({ target: 600 }, 1000), -280);
  assert.equal(prepositionSwipeDistance({ target: 803.5 }, 788), 16);
  assert.equal(prepositionSwipeDistance({ target: 787 }, 788), -1);
});

test('each observed gallery height gets its own threshold, nearest start first', async () => {
  const { planHeldDragForObservedHeights } = await import(moduleUrl);
  // 6756 px content: a 656 px gallery puts the threshold at 852, a 614 px gallery at 1230.
  const geometry = { scrollTop: 600, scrollHeight: 6756, labelBottoms: [500, 1016.6875, 1270.0625, 2300] };
  const plans = planHeldDragForObservedHeights(geometry, [656, 614, 656], [], {
    prefetchViewports: 8, maximumDragRatio: 0.38,
  });
  assert.deepEqual(plans.map(candidate => [candidate.clientHeight, candidate.plan.threshold, candidate.plan.feasible]),
    [[656, 852, true], [614, 1230, false]]);
  const remaining = planHeldDragForObservedHeights(geometry, [656, 614], [656], {
    prefetchViewports: 8, maximumDragRatio: 0.38,
  });
  assert.deepEqual(remaining.map(candidate => candidate.clientHeight), [614]);
});
