'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {F, JOB, fixture, job, review, button, click, search, settle} = V;
test.before(V.load);
const rows = h => [...h.host.querySelectorAll('[data-source-row-ref]')].map(node => node.getAttribute('data-source-row-ref'));
function region(h, ref) {const value = h.host.querySelector(`[aria-label="Match source row ${ref}"]`); assert.ok(value); return value;}
async function openMatch(h, ref = '2') {click(button(h.row(ref), `Match album for source row ${ref}`)); await settle(); return region(h, ref);}
async function chooseLocal(h, ref = '2') {
  const root = await openMatch(h, ref); search(root, 'Found'); await settle();
  click(root.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle(); return root;
}
function move(h, ref, key) {
  const handle = h.row(ref).querySelector('[data-source-row-drag]'); assert.ok(handle);
  assert.equal(handle.getAttribute('aria-label'), `Move source row ${ref}`); handle.focus();
  handle.dispatchEvent(new h.context.Event('keydown', {key}));
}

test('completed review renders every immutable source row, issue and original rank as inert evidence in server order', async t => {
  const h = await fixture(t, {opened: true}); const evidence = h.host.querySelector('[aria-label="Source evidence"]');
  assert.ok(evidence); assert.ok(h.host.querySelector('[aria-label="Source review"]'));
  for (const text of [V.SOURCE.title, V.SOURCE.description, V.SOURCE.content]) assert.ok(evidence.textContent.includes(text));
  assert.deepEqual(rows(h), ['3', '2', '1']);
  for (const row of review().rows) assert.ok(h.row(row.row_ref).textContent.includes(row.raw_text));
  assert.ok(h.host.textContent.includes(review().issues[0])); assert.equal(h.host.querySelector('script'), null);
  assert.equal([...h.host.querySelectorAll('b')].some(node => /Original source/.test(node.textContent)), false);
  assert.equal(h.context.inertEvidence, undefined); assert.match(h.host.textContent, /review/i);
  assert.equal(button(h.host, 'Save Album Top').disabled, true); assert.equal(h.count('read'), 1);
  assert.equal(h.api.count('searchAlbums'), 0); assert.equal(h.api.count('admitAlbum'), 0); V.noSave(h);
});

test('known server ordering stays fixed under keyboard input and is never guessed from display ranks', async t => {
  const h = await fixture(t, {opened: true}), before = h.actual.getSnapshot().rows;
  const row = h.row('3'), target = row.querySelector('[data-source-row-drag]') || row;
  target.dispatchEvent(new h.context.Event('keydown', {key: 'End'})); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows, before); assert.deepEqual(rows(h), ['3', '2', '1']);
  assert.equal(h.actual.getSnapshot().orderConfirmed, true); V.noSave(h);
});

test('ambiguous review retains source sequence until real keyboard reorder and explicit order confirmation', async t => {
  const evidence = review(); evidence.ordered_row_refs = null;
  const h = await fixture(t, {opened: true, wire: job({review: evidence})});
  assert.deepEqual(rows(h), ['1', '2', '3']); assert.equal(h.actual.getSnapshot().orderConfirmed, false);
  await V.localMatch(h, '2'); assert.equal(button(h.host, 'Save Album Top').disabled, true);
  move(h, '1', 'End'); await settle(); assert.deepEqual(rows(h), ['2', '3', '1']);
  assert.deepEqual(h.actual.getSnapshot().rows.map(row => row.row_ref), ['2', '3', '1']);
  assert.equal(h.actual.getSnapshot().orderConfirmed, false); assert.equal(button(h.host, 'Save Album Top').disabled, true);
  click(button(h.host, 'Confirm order')); await settle(); assert.equal(h.actual.getSnapshot().orderConfirmed, true);
  assert.equal(button(h.host, 'Save Album Top').disabled, false);
  move(h, '1', 'Home'); await settle(); assert.deepEqual(rows(h), ['1', '2', '3']);
  assert.equal(h.actual.getSnapshot().orderConfirmed, false); assert.equal(button(h.host, 'Save Album Top').disabled, true);
  assert.deepEqual(h.actual.getSnapshot().job.review, evidence); V.noSave(h);
});

test('zero candidate rows remain review-required and cannot create an empty Album Top', async t => {
  const empty = {...review(), rows: [], ordered_row_refs: []}; const h = await fixture(t, {opened: true, wire: job({review: empty})});
  assert.deepEqual(rows(h), []); assert.match(h.host.textContent, /review/i);
  const save = button(h.host, 'Save Album Top'); assert.ok(!save || save.disabled); if (save) click(save);
  await settle(); assert.equal(h.actual.getSnapshot().rows.length, 0); V.noSave(h);
});

test('actual local picker admission affects exactly its captured row only after explicit Confirm match', async t => {
  const h = await fixture(t, {opened: true}), before = h.actual.getSnapshot();
  const root = await chooseLocal(h); assert.equal(h.api.count('admitAlbum'), 1);
  assert.deepEqual(h.actual.getSnapshot().rows, before.rows); assert.equal(button(h.host, 'Save Album Top').disabled, true);
  const confirm = button(root, 'Confirm match'); click(confirm); await settle(); click(confirm); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows, [
    {row_ref: '3', selection: null}, {row_ref: '2', selection: {kind: 'local_catalog', album_ref: F.C}}, {row_ref: '1', selection: null}]);
  assert.deepEqual(h.actual.getSnapshot().job, before.job); assert.equal(button(h.host, 'Save Album Top').disabled, false);
  click(button(h.row('2'), 'Clear match for source row 2')); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows, before.rows); assert.equal(button(h.host, 'Save Album Top').disabled, true); V.noSave(h);
});

test('closing an unconfirmed picker abandons its admission without selecting a source row', async t => {
  const h = await fixture(t, {opened: true}), before = h.actual.getSnapshot().rows, root = await chooseLocal(h);
  const confirm = button(root, 'Confirm match'); click(button(root, 'Close match')); await settle();
  assert.equal(h.host.querySelector('[aria-label="Match source row 2"]'), null); click(confirm); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows, before); V.noSave(h);
});

test('opening a different row retires the first picker and its retained Confirm cannot select either row', async t => {
  const h = await fixture(t, {opened: true}), first = await chooseLocal(h, '1'); const old = button(first, 'Confirm match');
  await openMatch(h, '3'); assert.equal(h.host.querySelector('[aria-label="Match source row 1"]'), null);
  click(old); await settle(); assert.ok(h.actual.getSnapshot().rows.every(row => row.selection === null));
  const root = region(h, '3'); search(root, 'Found'); await settle();
  click(root.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle();
  click(button(root, 'Confirm match')); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows.map(row => [row.row_ref, row.selection?.album_ref || null]), [['3', F.C], ['2', null], ['1', null]]); V.noSave(h);
});

test('actual remote picker retains capacity one and confirms only the exact source-job acquisition selector', async t => {
  const h = await fixture(t, {opened: true}), root = await openMatch(h);
  click(button(root, 'Remote albums')); F.input(root, 'Remote album title', 'Remote album');
  click(button(root, 'Search remote albums')); await settle(); click(button(root, 'Select remote album Remote album')); await settle();
  assert.deepEqual(h.api.last('beginRemotePreparation').args[0], {destination: {kind: 'create', draft_ref: JOB}, form_ref: JOB});
  assert.deepEqual(h.api.last('acquireRemoteAlbum').args[0].destination, {kind: 'create', draft_ref: JOB});
  assert.equal(button(root, 'Select remote album Second remote album').disabled, true);
  assert.ok(h.actual.getSnapshot().rows.every(row => row.selection === null));
  click(button(root, 'Confirm match')); await settle();
  assert.deepEqual(h.actual.getSnapshot().rows.find(row => row.row_ref === '2').selection,
    {kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION}); V.noSave(h);
});

test('matching two source rows to one canonical album preserves both selections until server finalization', async t => {
  const h = await fixture(t, {opened: true}); await V.localMatch(h, '3'); await V.localMatch(h, '1');
  assert.equal(h.api.count('admitAlbum'), 2); assert.deepEqual(h.actual.getSnapshot().rows, [
    {row_ref: '3', selection: {kind: 'local_catalog', album_ref: F.C}}, {row_ref: '2', selection: null},
    {row_ref: '1', selection: {kind: 'local_catalog', album_ref: F.C}}]);
  assert.deepEqual(rows(h), ['3', '2', '1']); V.noSave(h);
});

for (const retirement of ['new revision', 'cancel', 'permission loss', 'dispose', 'scope']) test(`inline remote acquisition is retired by ${retirement} and late evidence cannot confirm`, async t => {
  const gate = F.deferred(), h = await fixture(t, {opened: true, handlers: {acquireRemoteAlbum: () => gate.promise}});
  const root = await openMatch(h); click(button(root, 'Remote albums')); F.input(root, 'Remote album title', 'Remote album');
  click(button(root, 'Search remote albums')); await settle(); click(button(root, 'Select remote album Remote album')); await settle();
  const acquired = h.api.last('acquireRemoteAlbum'), confirm = button(root, 'Confirm match'); assert.equal(h.api.count('acquireRemoteAlbum'), 1);
  if (retirement === 'new revision') {h.setWire(job({revision: '5'})); assert.equal(await h.actual.open(JOB), true);}
  else if (retirement === 'cancel') {click(button(h.host, 'Cancel import')); await settle(); h.last('cancel').resolve(job({status: 'canceled', phase: 'source_processing'})); await settle();}
  else if (retirement === 'permission loss') {h.api.control.list = () => ({tops: [], next_cursor: null,
    allowed_actions: {[F.BROWSE]: true, [F.CREATE]: false, can_create: false}}); await h.topController.load();}
  else if (retirement === 'dispose') h.view.dispose(); else h.scope();
  gate.resolve(h.api.acquisition(acquired.args[0])); await settle(); click(confirm); await settle();
  assert.equal(acquired.args[1].signal.aborted, true);
  assert.ok(h.actual.getSnapshot().rows.every(row => row.selection === null)); V.noSave(h);
});

test('title, description, uploaded filename, parser issues and row evidence cannot inject markup into the native review', async t => {
  const attack = '<img id=source-attack src=x onerror=sourceAttack()>', source = {...V.SOURCE,
    title: attack, description: attack, kind: 'uploaded_html', filename: attack + '.html', content: attack};
  const evidence = review(); evidence.issues = [attack]; evidence.rows[0].raw_text = attack;
  const h = await fixture(t, {opened: true, wire: job({title: source.title, kind: source.kind, source, review: evidence})});
  const region = h.host.querySelector('[aria-label="Source evidence"]'); assert.ok(region);
  assert.ok(region.textContent.includes(source.title)); assert.ok(region.textContent.includes(source.filename));
  assert.ok(h.row('1').textContent.includes(attack)); assert.ok(h.host.textContent.includes(evidence.issues[0]));
  assert.equal(h.host.querySelector('#source-attack'), null); assert.equal(h.context.sourceAttack, undefined); V.noSave(h);
});
