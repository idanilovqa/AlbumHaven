'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./album-tops-source-match-fixtures/session.cjs');
const {F, JOB} = M;
const {loadOwners, nativeRuntime, button, click, search, settle} = require('./album-tops-sharing-harness.cjs');
test.before(async () => {await loadOwners(); await M.load();});

async function fixture(t, options) {
  const env = nativeRuntime(t), h = await M.fixture(t, options), session = h.create();
  const props = () => {
    const value = session.draft.getSnapshot(), blocked = value.stale || value.denied || value.remote.retired;
    return {draft: session.draft, providers: h.providers, value, disabled: blocked || value.busy, blocked};
  };
  const picker = env.own(M.mount(env.host, env.runtime, props()));
  const off = session.draft.subscribe(() => picker.update(props())); t.after(off);
  return {...env, ...h, session, picker, redraw: () => picker.update(props())};
}
async function remoteSearch(h) {
  click(button(h.host, 'Remote albums')); F.input(h.host, 'Remote album title', 'Remote album');
  click(button(h.host, 'Search remote albums')); await settle();
}

test('actual picker admission leaves source evidence unresolved until explicit row confirmation', async t => {
  const h = await fixture(t), original = h.importController.getSnapshot();
  search(h.host, 'Found'); await settle();
  click(h.host.querySelector('.playlists__tracks [data-gallery-card-intent="select"]')); await settle();
  assert.deepEqual(M.selections(h), []); assert.equal(h.importController.getSnapshot(), original);
  click(h.host.querySelector('[data-in-page-tab="selected"]'));
  assert.equal(h.host.querySelector('[data-album-draft-key]').getAttribute('data-album-draft-key'), F.C);
  assert.equal(button(h.host, 'Remove Found local album').disabled, false);
  assert.equal(h.session.confirm(), true);
  assert.deepEqual(M.selections(h).map(row => row.args), [['2', M.local(F.C)]]);
  assert.deepEqual(h.importController.getSnapshot().job, original.job);
  assert.deepEqual(h.importController.getSnapshot().job.source, M.SOURCE);
  h.redraw(); await settle(); assert.equal(h.session.confirm(), false); assert.equal(M.selections(h).length, 1);
  M.noImplicitSave(h);
});

test('actual remote picker passes one source-job-bound acquisition only after explicit confirmation', async t => {
  const h = await fixture(t); await remoteSearch(h);
  click(button(h.host, 'Select remote album Remote album')); await settle();
  assert.deepEqual(h.api.last('beginRemotePreparation').args[0], {destination: {kind: 'create', draft_ref: JOB}, form_ref: JOB});
  assert.equal(button(h.host, 'Select remote album Second remote album').disabled, true);
  assert.deepEqual(M.selections(h), []);
  assert.equal(h.session.confirm(), true); assert.deepEqual(M.selections(h).map(row => row.args), [['2', M.remote()]]);
  click(h.host.querySelector('[data-in-page-tab="selected"]'));
  assert.equal(h.host.querySelector('[data-album-draft-key]').getAttribute('data-album-draft-key'), 'remote:' + F.ACQUISITION);
  assert.equal(h.session.confirm(), false); M.noImplicitSave(h);
});

test('canceling source review retires an actual picker acquisition and retained controls cannot later publish', async t => {
  const gate = F.deferred(), h = await fixture(t, {handlers: {acquireRemoteAlbum: () => gate.promise}});
  await remoteSearch(h); const retained = button(h.host, 'Select remote album Remote album');
  click(retained); await F.drain(); assert.equal(h.api.count('acquireRemoteAlbum'), 1);
  const sent = h.api.last('acquireRemoteAlbum'); assert.equal(h.session.confirm(), false);
  h.reply('cancel', M.job({status: 'canceled', phase: 'source_processing'}));
  assert.equal(await h.actualImport.cancel(), true);
  gate.resolve(h.api.acquisition(sent.args[0])); await settle();
  assert.equal(sent.args[1].signal.aborted, true); assert.deepEqual(h.session.draft.getSnapshot().items, []);
  assert.equal(h.session.confirm(), false); assert.deepEqual(M.selections(h), []);
  h.picker.dispose(); h.session.dispose(); const calls = h.api.calls.length + h.transport.length;
  click(retained); h.redraw(); await settle();
  assert.equal(h.host.children.length, 0); assert.equal(h.api.calls.length + h.transport.length, calls); M.noImplicitSave(h);
  // The existing nativeRuntime teardown checks actual owner resource cleanup.
});
