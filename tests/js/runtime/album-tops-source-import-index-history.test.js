'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, open, close, fill, button, click, settle, F} = I;
test.before(I.load);
async function settleReads(h) {
  for (const request of h.calls('navigate').filter(row => !row.settled)) {
    const url = new URL(request.url, h.location); request.reply(I.route(url.searchParams.get('top_ref')));
  }
  await settle();
}

for (const action of ['Close', 'Escape', 'Back']) test(`actual dirty ${action} cancellation preserves the same intake, then acceptance retires it`, async t => {
  const h = await fixture(t, {width: 400}), root = await open(h); fill(root, {content: 'Private unfinished input'});
  const form = h.owner('activeAppFormDialog'), position = h.history.state.albumHavenNavigationPosition;
  const attempt = async () => {
    if (action === 'Close') click(button(h.formHost(), 'Close'));
    else if (action === 'Escape') h.dispatch(h.document.getElementById('app-form-modal'), 'keydown', {key: 'Escape'});
    else h.history.back();
    await settle();
  };
  await attempt(); assert.equal(h.document.getElementById('app-confirm-modal').hidden, false);
  I.answer(h, false); await settle(); assert.equal(h.owner('activeAppFormDialog'), form);
  assert.equal(I.field(h.formHost(), 'Source content').value, 'Private unfinished input');
  assert.equal(h.history.state.albumHavenNavigationPosition, position); assert.equal(h.count('submit'), 0);
  await attempt(); I.answer(h, true); await settle(); await settleReads(h);
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.count('submit'), 0); assert.equal(h.count('cancel'), 0);
  h.history.forward(); await settle(); await settleReads(h);
  assert.equal(h.owner('activeAppFormDialog'), null, 'Forward cannot restore a retired source form');
  assert.equal(h.count('submit'), 0); I.privateFree(h, ['Private unfinished input']);
});

test('native form history carries only opaque form identity and preserves private evidence outside mobile descriptors', async t => {
  const h = await fixture(t, {width: 400}), root = await open(h); fill(root, {content: 'SECRET_SOURCE_BODY'});
  assert.equal(h.document.getElementById('mobile-page-outlet').dataset.mobilePageKind, 'form');
  assert.equal(h.document.getElementById('mobile-page-title').textContent, 'Import Album Top');
  const pages = h.history.state.mobilePages; assert.equal(pages.length, 1); assert.deepEqual(Object.keys(pages[0]).sort(), ['formToken', 'kind']);
  assert.equal(pages[0].kind, 'form'); assert.equal(typeof pages[0].formToken, 'string');
  I.privateFree(h); assert.equal(await close(h, true), null);
});

test('a real replacement navigation waits for dirty confirmation and does not dispatch on cancellation', async t => {
  const h = await fixture(t), root = await open(h); fill(root, {content: 'Unsaved native source'});
  const first = h.runtime.navigate({top_ref: F.TOP}); await settle(); assert.equal(h.count('navigate'), 0);
  I.answer(h, false); assert.equal(await first, false); await settle(); assert.equal(h.formHost(), root);
  const second = h.runtime.navigate({top_ref: F.TOP}); await settle(); I.answer(h, true); await settle();
  assert.equal(h.count('navigate'), 1); h.last('navigate').reply(I.route(F.TOP)); assert.equal(await second, true); await settle();
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.runtime.snapshot().topRef, F.TOP); assert.equal(h.count('submit'), 0);
});

test('nested native departure confirmation stays single-flight and stale acceptance after scope loss cannot reopen or write', async t => {
  const h = await fixture(t), root = await open(h); fill(root, {content: 'Pending private intent'});
  click(button(root, 'Close')); await settle(); const confirmation = h.owner('activeAppConfirmDialog'); assert.ok(confirmation);
  h.dispatch(h.document.getElementById('app-form-modal'), 'keydown', {key: 'Escape'}); await settle();
  assert.equal(h.owner('activeAppConfirmDialog'), confirmation); const staleAccept = h.document.getElementById('app-confirm-accept');
  await h.change('logout'); click(staleAccept); await settle();
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.owner('activeAppConfirmDialog'), null);
  assert.equal(h.count('submit'), 0); assert.equal(h.count('finalize'), 0);
});

test('pending file completion after an accepted native Close is inert and never reopens or submits', async t => {
  const h = await fixture(t), root = await open(h), gate = F.deferred(); fill(root, {kind: 'uploaded_html'});
  I.file(root, I.fakeFile({promise: gate.promise}).value); await settle(); assert.equal(await close(h, true), null);
  gate.resolve('<p>Late private file</p>'); await settle(); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.count('submit'), 0); await open(h); assert.equal(I.field(h.formHost(), 'Album Top title').value, '');
});

test('Close while submit is pending releases only the surface; the acknowledged job updates the actual card without navigation', async t => {
  const h = await fixture(t), request = await I.submit(h); assert.equal(await close(h), null); assert.equal(request.options.signal.aborted, false);
  await I.acknowledge(h, request); assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.cards().length, 1);
  assert.match(h.cards()[0].markup, /Ready for review/); assert.equal(h.navigations.length, 0); assert.equal(h.count('process'), 0);
});

test('Close while finalization is pending retains exact receipt recovery without automatic Top navigation', async t => {
  const h = await fixture(t), request = await I.submit(h); await I.acknowledge(h, request); await I.match(h);
  click(button(h.formHost(), 'Save Album Top')); await settle(); const save = h.last('finalize'); assert.equal(await close(h), null);
  assert.equal(save.options.signal.aborted, false); save.reply(I.receipt(save.body)); await settle();
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.count('finalize'), 1); assert.equal(h.navigations.length, 0);
  assert.match(h.cards()[0].markup, /Album Top created/); h.activate(I.JOB); await settle(); await h.settleNavigation(I.SAVED_TOP);
  assert.equal(h.runtime.snapshot().topRef, I.SAVED_TOP); assert.equal(h.count('finalize'), 1);
});

for (const reason of ['actor', 'library', 'context', 'logout', 'registry', 'dispose']) test(`actual ${reason} retirement closes an active picker and aborts its current native search`, async t => {
  const h = await fixture(t), request = await I.submit(h); await I.acknowledge(h, request);
  const root = h.formHost(), row = root.querySelector('[data-source-row-ref="2"]'); click(button(row, 'Match album for source row 2')); await settle();
  const picker = h.formHost().querySelector('[aria-label="Match source row 2"]'); h.hold('search'); I.search(picker, 'Found'); await settle();
  const search = h.last('search'), staleConfirm = button(picker, 'Confirm match');
  if (reason === 'registry') await h.replaceRegistry(); else if (reason === 'dispose') await h.dispose(); else await h.change(reason);
  assert.equal(search.options.signal.aborted, true); search.reply({albums: [F.album(13)], next_cursor: null}); await settle();
  if (staleConfirm) click(staleConfirm); await settle(); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.count('admit'), 0); assert.equal(h.count('finalize'), 0); assert.equal(h.owner('activeAppConfirmDialog'), null);
});

for (const status of [401, 403]) test(`actual private source feed ${status} retires the dialog and admission before late submit completion`, async t => {
  const h = await fixture(t), request = await I.submit(h); h.hold('feed'); const refresh = h.showNotifications(); await settle();
  h.last('feed').reply({error_code: 'forbidden'}, status); await refresh; await settle();
  assert.equal(request.options.signal.aborted, true); assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.cards().length, 0);
  const entry = button(h.host, 'Import Album Top'); assert.ok(!entry || entry.disabled);
  await I.acknowledge(h, request); assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.cards().length, 0);
  assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});

test('selected-view navigation and dialog disposal preserve the one authenticated task source until index disposal', async t => {
  const h = await fixture(t), source = h.currentSource(), request = await I.submit(h); request.reject(new TypeError('unknown')); await settle();
  assert.equal(await close(h), null); await h.navigate(F.TOP); assert.equal(h.currentSource(), source); assert.equal(source.disposed, false);
  await h.navigate(); assert.equal(h.currentSource(), source); assert.equal(h.cards().length, 1);
  const oldOpen = h.cards()[0].source.onOpen, id = h.cards()[0].id;
  await h.dispose(); assert.equal(source.disposed, true); assert.equal(h.cards().length, 0);
  assert.equal(await oldOpen(id), false); assert.equal(h.count('submit'), 1);
});

test('Close during explicit cancellation keeps the task request alive and reports its completion without reopening', async t => {
  const h = await fixture(t), request = await I.submit(h), value = await I.acknowledge(h, request);
  click(button(h.formHost(), 'Cancel import')); await settle(); const cancel = h.last('cancel');
  assert.equal(await close(h), null); assert.equal(cancel.options.signal.aborted, false);
  cancel.reply({...value, revision: '5', status: 'canceled', phase: 'source_processing'}); await settle();
  assert.match(h.cards()[0].markup, /Import canceled/); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.count('cancel'), 1); assert.equal(h.navigations.length, 0); assert.equal(h.count('finalize'), 0);
});
