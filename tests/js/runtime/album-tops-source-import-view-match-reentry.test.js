'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {F, fixture, button, click, search, settle} = V;
test.before(V.load);
function region(h, ref) {const root = h.host.querySelector(`[aria-label="Match source row ${ref}"]`); assert.ok(root, `current row ${ref} picker`); return root;}
async function open(h, ref) {click(button(h.row(ref), `Match album for source row ${ref}`)); await settle(); return region(h, ref);}
async function chooseLocal(h, root) {
  search(root, 'Found'); await settle(); click(root.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle();
}
async function acquire(h, root) {
  click(button(root, 'Remote albums')); F.input(root, 'Remote album title', 'Remote album');
  click(button(root, 'Search remote albums')); await settle(); click(button(root, 'Select remote album Remote album')); await settle();
  return h.api.last('acquireRemoteAlbum');
}
const selections = h => h.actual.getSnapshot().rows.map(row => [row.row_ref, row.selection]);
const pickers = h => [...h.host.querySelectorAll('[aria-label]')].filter(node => node.getAttribute('aria-label').startsWith('Match source row '));

test('Confirm match cannot retire a successor picker opened synchronously by the actual selection subscriber', async t => {
  const h = await fixture(t, {opened: true}), original = h.actual.getSnapshot().job;
  const previous = await open(h, '2'); await chooseLocal(h, previous); const oldConfirm = button(previous, 'Confirm match');
  let entered = false;
  const off = h.actual.subscribe(() => {
    if (!entered && h.actual.getSnapshot().rows.some(row => row.row_ref === '2' && row.selection)) {
      entered = true; click(button(h.row('3'), 'Match album for source row 3'));
    }
  });
  try {
    click(oldConfirm); await settle(); assert.equal(entered, true);
    const successor = region(h, '3'); assert.equal(h.host.querySelector('[aria-label="Match source row 2"]'), null);
    assert.equal(pickers(h).length, 1);
    assert.deepEqual(selections(h), [['3', null], ['2', {kind: 'local_catalog', album_ref: F.C}], ['1', null]]);
    click(oldConfirm); await settle(); assert.equal(region(h, '3'), successor);
    await chooseLocal(h, successor); assert.equal(h.api.count('admitAlbum'), 2);
    assert.equal(h.actual.getSnapshot().rows.find(row => row.row_ref === '3').selection, null);
    click(button(successor, 'Confirm match')); await settle();
    assert.deepEqual(selections(h), [['3', {kind: 'local_catalog', album_ref: F.C}],
      ['2', {kind: 'local_catalog', album_ref: F.C}], ['1', null]]);
    assert.deepEqual(h.actual.getSnapshot().job, original); V.noSave(h);
    h.view.dispose(); await settle(); assert.equal(h.subscriptions.top, 0); assert.equal(h.subscriptions.imported, 0);
    assert.equal(h.host.children.length, 0); assert.equal(h.calls.importDispose, 0);
  } finally {off();}
});

test('beginMatch retirement cannot overwrite or orphan a newer picker opened by the real acquisition abort callback', async t => {
  const oldGate = F.deferred(), newGate = F.deferred(); let acquisitionCount = 0;
  const h = await fixture(t, {opened: true, handlers: {acquireRemoteAlbum: () => ++acquisitionCount === 1 ? oldGate.promise : newGate.promise}});
  const previous = await open(h, '2'), oldRequest = await acquire(h, previous), oldConfirm = button(previous, 'Confirm match');
  assert.equal(oldRequest.args[1].signal.aborted, false); let reentered = 0;
  const onAbort = () => {reentered++; click(button(h.row('3'), 'Match album for source row 3'));};
  oldRequest.args[1].signal.addEventListener('abort', onAbort, {once: true});
  try {
    // Row1 is the interrupted outer transition. Row3 is the newer transition
    // installed synchronously while the old row2 draft releases its request.
    click(button(h.row('1'), 'Match album for source row 1')); await settle();
    assert.equal(reentered, 1); assert.equal(oldRequest.args[1].signal.aborted, true);
    const successor = region(h, '3'); assert.equal(h.host.querySelector('[aria-label="Match source row 1"]'), null);
    assert.equal(h.host.querySelector('[aria-label="Match source row 2"]'), null);
    assert.equal(pickers(h).length, 1);
    assert.ok(h.actual.getSnapshot().rows.every(row => row.selection === null));
    const currentRequest = await acquire(h, successor);
    assert.equal(h.api.count('acquireRemoteAlbum'), 2); assert.notEqual(currentRequest, oldRequest);
    assert.equal(currentRequest.args[1].signal.aborted, false);
    assert.deepEqual(currentRequest.args[0].destination, {kind: 'create', draft_ref: V.JOB});
    oldGate.resolve(h.api.acquisition(oldRequest.args[0])); await settle(); click(oldConfirm); await settle();
    assert.equal(region(h, '3'), successor); assert.equal(currentRequest.args[1].signal.aborted, false);
    assert.ok(h.actual.getSnapshot().rows.every(row => row.selection === null));
    newGate.resolve(h.api.acquisition(currentRequest.args[0])); await settle();
    assert.equal(button(successor, 'Confirm match').disabled, false); click(button(successor, 'Confirm match')); await settle();
    assert.deepEqual(selections(h), [['3', {kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION}],
      ['2', null], ['1', null]]); V.noSave(h);
    h.view.dispose(); await settle(); assert.equal(h.subscriptions.top, 0); assert.equal(h.subscriptions.imported, 0);
    assert.equal(h.host.children.length, 0); assert.equal(h.calls.importDispose, 0);
  } finally {oldRequest.args[1].signal.removeEventListener('abort', onAbort);}
});
