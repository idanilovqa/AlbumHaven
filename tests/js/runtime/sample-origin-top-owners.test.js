'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
let capture;
test.before(async () => {
  ({captureAlbumTopSampleOrigin: capture} = await import('../../../music_app/static/js/playlists/sample-playlist-origins.mjs'));
  assert.equal(typeof capture, 'function', 'Proposed narrow owner seam is specified in NATIVE-SEAMS.md; do not substitute a test adapter');
});
function fixture({draft = null, state = F.topState()} = {}) {
  let current = true, saved = state, working = draft; const returns = [];
  const controller = {getSnapshot: () => saved}, draftOwner = {getSnapshot: () => working};
  const input = {controller, ...(draft ? {draft: draftOwner} : {}), libraryRef: '5', isCurrent: () => current,
    returnToOrigin: async () => {returns.push(working || saved); return true;}};
  return {input, returns, state: () => saved, draft: () => working,
    setState: value => {saved = value;}, setDraft: value => {working = value;}, retire: () => {current = false;}};
}
test('saved locked/read-only Top captures actual selected Top ref and exact bigint revision, not display rows', async () => {
  const h = fixture(), lease = capture(h.input); assert.ok(lease);
  assert.deepEqual(lease.origin, F.origins.album_top()); assert.equal(lease.isCurrent(), true);
  assert.equal(Object.isFrozen(lease.origin), true);
  h.state().displayedItems = []; h.state().readView = {sort: 'title', query: 'filtered'};
  assert.equal(lease.isCurrent(), true); assert.deepEqual(lease.origin, F.origins.album_top());
  assert.equal(await lease.back(), true); assert.equal(h.returns[0], h.state());
});
const topInvalidations = [
  ['selected Top replacement', h => h.setState({...h.state(), selectedTopRef: F.id(999)})],
  ['actual revision replacement', h => {h.state().detail.data.revision = '2';}],
  ['Top detail identity replacement', h => h.setState({...h.state(), detail: {status: 'ready', data: F.plain(h.state().detail.data)}})],
  ['detail denied', h => h.setState({...h.state(), detail: {status: 'denied', data: null}})],
  ['directory denied', h => h.setState({...h.state(), directory: {status: 'denied', data: null}})],
  ['Browse removed', h => {h.state().detail.data.allowed_actions['library.browse.read'] = false;}],
  ['detail loading', h => h.setState({...h.state(), detail: {...h.state().detail, status: 'loading'}})],
  ['mutation loading', h => h.setState({...h.state(), mutation: {status: 'loading'}})],
  ['mutation uncertain', h => h.setState({...h.state(), mutation: {status: 'uncertain'}})],
  ['scope replacement', h => h.setState({...h.state(), scopeKey: 'other:scope'})],
  ['origin lifetime retirement', h => h.retire()],
];
for (const [name, invalidate] of topInvalidations) test(`saved Top owner ${name} cannot return or revive old Sample`, async () => {
  const h = fixture(), lease = capture(h.input); assert.ok(lease); const original = h.state();
  invalidate(h); assert.equal(lease.isCurrent(), false); h.setState(original);
  assert.equal(lease.isCurrent(), false, 'Retirement must latch, even if an old snapshot is restored');
  assert.equal(await lease.back(), false); assert.equal(h.returns.length, 0);
});
test('unsaved draft maps authoritative selected/string refs in source order and ignores rounded numeric aliases', () => {
  const items = [{album_ref: F.id(700), selected_source_ref: F.id(701), selected_local_album_id: 9007199254740992,
    local_album_id: 12, inventory_album_ref: 'inventory-album:5:12', selected_inventory_album_ref: F.albumRefs[0]},
  {album_ref: F.id(702), local_album_id: 9223372036854776000, inventory_album_ref: F.albumRefs[1]},
  {source_kind: 'remote_summary', album_ref: F.id(703), title: 'Remote private title', source: {kind: 'remote_existing', acquisition_ref: F.id(704)}},
  {album_ref: F.id(705), source: {kind: 'unselected'}}, {source_kind: 'remote_summary'}];
  const h = fixture({draft: F.draftState(items)}), lease = capture(h.input); assert.ok(lease);
  assert.deepEqual(lease.origin, {kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: F.albumRefs[0]},
    {kind: 'local', inventory_album_ref: F.albumRefs[1]}, {kind: 'unavailable'}, {kind: 'unavailable'}, {kind: 'unavailable'}]});
  assert.equal(Object.hasOwn(lease.origin, 'revision'), false); assert.equal(Object.hasOwn(lease.origin, 'top_ref'), false);
  assert.doesNotMatch(JSON.stringify(lease.origin), /Remote private title|acquisition_ref|selected_source_ref|9007199254740992/);
  assert.deepEqual(items[0].selected_inventory_album_ref, F.albumRefs[0]); assert.equal(h.draft().dirty, true);
});
const badLocalRows = [
  ['numeric picker without authoritative ref', {local_album_id: 9007199254740992}],
  ['selected binding without authoritative ref', {selected_local_album_id: 9007199254740992, selected_source_ref: F.id(701)}],
  ['selected binding malformed ref cannot fall back', {selected_source_ref: F.id(701), selected_inventory_album_ref: 'bad', inventory_album_ref: F.albumRefs[0]}],
  ['selected source kind local without ref', {source: {kind: 'local', selected_local_album_id: 7, selected_source_ref: F.id(701)}}],
  ['foreign library ref', {local_album_id: 7, inventory_album_ref: 'inventory-album:6:7'}],
  ['rounded string identity', {local_album_id: 7, inventory_album_ref: '9007199254740992'}],
  ['overflow ref', {local_album_id: 7, inventory_album_ref: 'inventory-album:5:9223372036854775808'}],
  ['numeric authoritative ref', {local_album_id: 7, inventory_album_ref: 7}],
  ['zero identity', {local_album_id: 7, inventory_album_ref: 'inventory-album:5:0'}],
  ['leading zero', {local_album_id: 7, inventory_album_ref: 'inventory-album:5:07'}],
];
for (const [name, row] of badLocalRows) test(`claimed local ${name} rejects whole draft, not an unavailable omission`, () => {
  const h = fixture({draft: F.draftState([{source_kind: 'remote_summary'}, row])});
  assert.equal(capture(h.input), null); assert.equal(h.returns.length, 0); assert.equal(h.draft().items.length, 2);
});
test('explicitly remote/unselected rows ignore forged local hints rather than gaining inventory authority', () => {
  const h = fixture({draft: F.draftState([{source_kind: 'remote_summary', inventory_album_ref: F.albumRefs[0]},
    {source: {kind: 'unselected'}, inventory_album_ref: F.albumRefs[1]}])});
  assert.deepEqual(capture(h.input).origin.selections, [{kind: 'unavailable'}, {kind: 'unavailable'}]);
});
for (const flag of ['busy', 'stale', 'denied']) test(`draft ${flag} blocks launch and retires an existing capture`, async () => {
  const h = fixture({draft: F.draftState([{inventory_album_ref: F.albumRefs[0], local_album_id: 1}])});
  const lease = capture(h.input); assert.ok(lease); h.setDraft({...h.draft(), [flag]: true});
  assert.equal(capture(h.input), null); assert.equal(lease.isCurrent(), false); assert.equal(await lease.back(), false);
});
test('duplicate local selectors reject but independently indexed unavailable rows remain valid', () => {
  const repeated = {local_album_id: 1, inventory_album_ref: F.albumRefs[0]};
  assert.equal(capture(fixture({draft: F.draftState([repeated, {...repeated}])}).input), null);
  assert.deepEqual(capture(fixture({draft: F.draftState([{source_kind: 'remote_summary'}, {source: {kind: 'unselected'}}])}).input).origin.selections,
    [{kind: 'unavailable'}, {kind: 'unavailable'}]);
});
test('draft edits retire its captured owner and cannot mutate the frozen request or Save the Top', async () => {
  const first = {local_album_id: 1, inventory_album_ref: F.albumRefs[0]}, h = fixture({draft: F.draftState([first])});
  h.input.controller.mutate = () => assert.fail('Sample must not save a Top'); h.input.draft.save = () => assert.fail('Sample must not save its draft');
  const lease = capture(h.input); assert.ok(lease); h.setDraft({...h.draft(), items: [{local_album_id: 2, inventory_album_ref: F.albumRefs[1]}]});
  assert.equal(lease.isCurrent(), false); assert.equal(await lease.back(), false);
  assert.deepEqual(lease.origin.selections, [{kind: 'local', inventory_album_ref: F.albumRefs[0]}]);
  const next = capture(h.input); assert.deepEqual(next.origin.selections, [{kind: 'local', inventory_album_ref: F.albumRefs[1]}]);
  assert.equal(await next.back(), true); assert.equal(h.returns[0], h.draft()); assert.equal(h.draft().dirty, true);
});
test('actual existing edit-draft copy retains authoritative binding strings without retyping mutation numbers', async () => {
  const {createAlbumTopDraft} = await import('../../../music_app/static/js/album-tops/draft.mjs');
  const state = F.topState(); state.detail.data.type = 'manual'; state.detail.data.source_locked = false;
  Object.assign(state.detail.data.allowed_actions, {can_read: true, can_edit: true, can_add: true, can_remove: true, can_reorder: true,
    'library.album_tops.items.manage': true});
  state.detail.data.edit_draft = {item_selections: [{item_ref: F.id(510), album_ref: F.id(520),
    selected_inventory_album_ref: F.albumRefs[0], selected_local_album_id: 9007199254740992, selected_source_ref: F.id(701)}]};
  const listeners = new Set(), controller = {getSnapshot: () => state, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const draft = createAlbumTopDraft({controller, providers: {}});
  try {
    assert.equal(draft.getSnapshot().items[0].selected_inventory_album_ref, F.albumRefs[0]);
    assert.equal(draft.getSnapshot().items[0].selected_local_album_id, 9007199254740992);
    const lease = capture({controller, draft, libraryRef: '5', isCurrent: () => true, returnToOrigin: async () => true});
    assert.deepEqual(lease.origin.selections, [{kind: 'local', inventory_album_ref: F.albumRefs[0]}]);
  } finally {draft.dispose();}
});
