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
