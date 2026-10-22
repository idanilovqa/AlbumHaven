'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, service, id, TOP, SCOPE} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {loadOwners, nativeRuntime, viewOwner, button, click, search, plain, deferred, settle} = require('./album-tops-sharing-harness.cjs');
let createAlbumTopController, createAlbumTopDraft, albumTopAddAllowed;
test.before(async () => {
  await loadOwners();
  ({createAlbumTopController} = await load('album-tops/model.mjs'));
  ({createAlbumTopDraft, albumTopAddAllowed} = await load('album-tops/draft.mjs'));
});
const grants = () => ({'library.browse.read': true, can_add: true});
async function fixture(t, {overrides = {}, detail = {}, mounted = false} = {}) {
  const env = nativeRuntime(t), api = service(overrides); let sequence = 300;
  api.data.detail = {...api.data.detail, allowed_actions: grants(), ...detail};
  const controller = env.own(createAlbumTopController({providers: api.providers, requestKey: () => id(++sequence)}));
  controller.setScope(SCOPE); await controller.load(); await controller.open(TOP);
  let owner, unsubscribe, props;
  if (mounted) {
    props = {controller, providers: api.providers, state: controller.getSnapshot(), onOpen() {}};
    env.own({dispose() {unsubscribe?.();}});
    unsubscribe = controller.subscribe(() => {props = {...props, state: controller.getSnapshot()}; owner?.update(props);});
    owner = viewOwner(env, props);
  }
  const draft = mounted ? null : env.own(createAlbumTopDraft({controller, providers: api.providers, mode: 'add'}));
  return {...env, api, controller, draft, owner,
    form: () => env.content().querySelector('form.album-top-add'),
    open() {click(button(env.host, 'Add albums')); assert.ok(this.form());},
    replaceProviders(providers) {props = {...props, providers}; owner.update(props);},
  };
}
async function choose(f, query = 'Found') {
  await f.draft.setQuery(query); const row = f.draft.getSnapshot().search.items[0]; assert.ok(row);
  await f.draft.select(row); return row;
}
async function chooseUI(f) {
  search(f.content(), 'Found'); await settle();
  const control = f.content().querySelector('[data-gallery-card-intent="select"]'); assert.ok(control); click(control); await settle();
  assert.match(f.content().textContent, /Selected \(1\)/);
}
async function submitUI(f) {const form = f.form(); form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit')); await settle();}

test('Add uses exact can_add without metadata, remove or reorder grants, including empty Tops', async t => {
  const f = await fixture(t, {mounted: true});
  assert.equal(albumTopAddAllowed(f.controller.getSnapshot()), true);
  assert.equal(button(f.host, 'Edit Album Top'), undefined);
  f.open(); assert.equal(f.api.count('searchAlbums'), 0);
  assert.equal(f.calls.owners.at(-1).options.title, 'Add albums');
  assert.match(f.content().textContent, /Curated Top/);
  assert.equal(f.content().querySelectorAll('[name="title"],[name="description"],textarea').length, 0);
  assert.equal(button(f.content(), 'Find'), undefined); assert.equal(button(f.content(), 'Back'), undefined);
  assert.ok(f.document.getElementById('app-form-close'));
  assert.match(f.content().textContent, /Selected \(0\)/); assert.match(f.content().textContent, /Type an album or artist/);
  assert.equal(button(f.content(), 'Add albums').disabled, true);
});
test('Add fails closed for missing, nonboolean or inherited grants and locked or derived sources', async t => {
  const f = await fixture(t);
  const state = f.controller.getSnapshot();
  for (const allowed_actions of [{}, {'library.browse.read': true}, {'library.browse.read': true, can_add: 'true'},
    {can_add: true}, Object.create(grants())]) {
    assert.equal(albumTopAddAllowed({...state, detail: {...state.detail, data: {...state.detail.data, allowed_actions}}}), false);
  }
  for (const patch of [{source_locked: true}, {source_locked: 'false'}, {type: 'artist'}]) {
    assert.equal(albumTopAddAllowed({...state, detail: {...state.detail, data: {...state.detail.data, ...patch}}}), false);
  }
});
test('Add queries and admits within captured scope and destination, then writes only selected canonical refs', async t => {
  const f = await fixture(t); await choose(f);
  const searched = f.api.calls.find(row => row.method === 'searchAlbums').args[0];
  assert.equal(searched.scopeKey, SCOPE); assert.equal(searched.topRef, TOP); assert.equal(searched.q, 'Found');
  const admitted = f.api.calls.find(row => row.method === 'admitAlbum').args;
  assert.equal(admitted[0], 11); assert.equal(admitted[1].scopeKey, SCOPE); assert.equal(admitted[1].topRef, TOP);
  assert.equal(f.draft.edit({title: 'Overwrite'}), false); assert.equal(f.api.count('execute'), 0);
  assert.equal(await f.draft.submit(), true);
  const [action, command] = f.api.calls.find(row => row.method === 'execute').args;
  assert.equal(action, 'add'); assert.deepEqual(plain(command), {album_refs: [id(11)], request_key: id(301), top_ref: TOP, revision: '7'});
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 1);
});
test('Existing canonical members are excluded and duplicate admission cannot create a second selection', async t => {
  const f = await fixture(t, {detail: {items: [{album_ref: id(11), item_ref: id(91)}]}, overrides: {
    searchAlbums: async () => ({albums: [{local_album_id: 11, album_ref: id(11)}, {local_album_id: 12, title: 'Alias'}], next_cursor: null}),
    admitAlbum: async () => ({album_ref: id(11)}),
  }});
  await f.draft.setQuery('Alias'); assert.deepEqual(f.draft.getSnapshot().search.items.map(row => row.local_album_id), [12]);
  await f.draft.select(f.draft.getSnapshot().search.items[0]);
  assert.equal(f.draft.getSnapshot().items.length, 0); assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 0);
});
test('Pending selection survives search changes and can be reordered or removed without touching existing membership', async t => {
  const f = await fixture(t, {overrides: {searchAlbums: async ({q}) => ({albums: [{local_album_id: q === 'one' ? 11 : 12, title: q}], next_cursor: null})}});
  await choose(f, 'one'); await choose(f, 'two');
  assert.equal(f.draft.reorder([id(12), id(11)]), true); assert.equal(f.draft.remove(id(11)), true);
  assert.deepEqual(f.draft.getSnapshot().items.map(row => row.album_ref), [id(12)]); assert.equal(f.api.count('execute'), 0);
});
test('Add counts existing members against the 5000-album cap', async t => {
  const f = await fixture(t, {detail: {items: Array.from({length: 5000}, (_, n) => ({album_ref: id(1000 + n), item_ref: id(7000 + n)}))}});
  assert.equal(f.draft.getSnapshot().capacity, 0); await f.draft.setQuery('Found');
  assert.equal(await f.draft.select(f.draft.getSnapshot().search.items[0]), false); assert.equal(f.api.count('admitAlbum'), 0);
});
test('Retired query response cannot replace the latest query', async t => {
  const pending = deferred();
  const f = await fixture(t, {overrides: {searchAlbums: ({q}) => q === 'old' ? pending.promise : Promise.resolve({albums: [], next_cursor: null})}});
  const old = f.draft.setQuery('old'); await f.draft.setQuery('new');
  pending.resolve({albums: [{local_album_id: 90, title: 'Retired private result'}], next_cursor: null}); await old;
  assert.equal(f.draft.getSnapshot().query, 'new'); assert.equal(f.draft.getSnapshot().search.items.length, 0);
});
test('Scope ABA aborts admission, clears private selection and never revives the old Add intent', async t => {
  const pending = deferred(); const f = await fixture(t, {overrides: {admitAlbum: () => pending.promise}});
  await f.draft.setQuery('Found'); const selection = f.draft.select(f.draft.getSnapshot().search.items[0]);
  const signal = f.api.calls.find(row => row.method === 'admitAlbum').args[1].signal;
  f.controller.setScope('another'); f.controller.setScope(SCOPE); await f.controller.load(); await f.controller.open(TOP);
  assert.equal(signal.aborted, true); pending.resolve({album_ref: id(11)}); await selection;
  assert.equal(f.draft.getSnapshot().denied, true); assert.equal(f.draft.getSnapshot().title, '');
  assert.equal(f.draft.getSnapshot().query, ''); assert.equal(f.draft.getSnapshot().items.length, 0);
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 0);
});
test('Revision ABA permanently retires captured Add revision', async t => {
  const f = await fixture(t); await choose(f);
  f.api.data.detail = {...f.api.data.detail, revision: '8'}; await f.controller.open(TOP);
  f.api.data.detail = {...f.api.data.detail, revision: '7'}; await f.controller.open(TOP);
  assert.equal(f.draft.getSnapshot().stale, true); assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 0);
});
test('Denied admission clears private fields and selected rows at the denial phase', async t => {
  let count = 0; const f = await fixture(t, {overrides: {
    searchAlbums: async () => ({albums: [{local_album_id: ++count, title: 'Private album'}], next_cursor: null}),
    admitAlbum: async local => {if (local === 2) throw Object.assign(new Error('Denied'), {status: 403}); return {album_ref: id(local)};},
  }});
  await choose(f); await choose(f, 'second'); const value = f.draft.getSnapshot();
  assert.equal(value.denied, true); assert.equal(value.title, ''); assert.equal(value.description, '');
  assert.equal(value.query, ''); assert.deepEqual(plain(value.items), []); assert.deepEqual(plain(value.search.items), []);
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 0);
});
test('Actual native Add submits once, waits for acknowledged refresh, then returns without metadata navigation', async t => {
  const refresh = deferred(); let reads = 0;
  const f = await fixture(t, {mounted: true, overrides: {read: () => ++reads === 1 ? Promise.resolve({top_ref: TOP, revision: '7', title: 'Destination', items: [], allowed_actions: grants()}) : refresh.promise}});
  f.open(); await chooseUI(f); await submitUI(f);
  assert.equal(f.api.count('execute'), 1); assert.ok(f.form()); assert.equal(button(f.content(), 'Add albums').disabled, true);
  await submitUI(f); assert.equal(f.api.count('execute'), 1);
  refresh.resolve({top_ref: TOP, revision: '8', title: 'Destination', items: [{album_ref: id(11), item_ref: id(31)}], allowed_actions: grants()}); await settle();
  assert.equal(f.form(), null); assert.equal(f.controller.getSnapshot().selectedTopRef, TOP);
});
test('Uncertain Add locks controls and exact retry retains request key, revision and payload', async t => {
  let attempts = 0; const f = await fixture(t, {mounted: true, overrides: {execute: async (action, command) => {
    if (++attempts === 1) throw new Error('connection lost'); return {action, request_key: command.request_key, top_ref: TOP, revision: '8'};
  }}});
  f.open(); await chooseUI(f); await submitUI(f);
  assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(button(f.content(), 'Add albums').disabled, true); assert.equal(button(f.content(), 'Cancel').disabled, true);
  assert.equal(await f.calls.owners.at(-1).options.beforeDismiss(), false);
  await submitUI(f); assert.equal(f.api.count('execute'), 1);
  const confirmations = []; f.runtime.confirmRetryOriginal = async scope => {confirmations.push(scope); return true;};
  click(button(f.content(), 'Retry original request')); await settle();
  assert.deepEqual(confirmations, [SCOPE]);
  const writes = f.api.calls.filter(row => row.method === 'execute'); assert.equal(writes.length, 2);
  assert.deepEqual(plain(writes[0].args.slice(0, 2)), plain(writes[1].args.slice(0, 2))); assert.equal(f.form(), null);
});
test('Cancel confirmation preserves pending selection on rejection and performs no write', async t => {
  const f = await fixture(t, {mounted: true}); f.open(); await chooseUI(f);
  click(button(f.content(), 'Cancel')); await settle(); assert.ok(f.form());
  assert.equal(f.calls.confirms.length, 1); assert.match(f.content().textContent, /Selected \(1\)/); assert.equal(f.api.count('execute'), 0);
  f.runtime.confirm = async () => true; click(button(f.content(), 'Cancel')); await settle();
  assert.equal(f.form(), null); assert.equal(f.api.count('execute'), 0);
});
test('Provider replacement retires actual Add controls and late search cannot repopulate the form', async t => {
  const pending = deferred(); const f = await fixture(t, {mounted: true, overrides: {searchAlbums: () => pending.promise}});
  f.open(); const retired = f.form(); search(f.content(), 'Private'); await settle();
  const signal = f.api.calls.find(row => row.method === 'searchAlbums').args[0].signal;
  f.replaceProviders({...f.api.providers}); assert.equal(signal.aborted, true); assert.equal(f.form(), null);
  pending.resolve({albums: [{local_album_id: 11, title: 'Late private album'}], next_cursor: null}); await settle();
  retired.dispatchEvent(new retired.ownerDocument.defaultView.Event('submit'));
  assert.doesNotMatch(f.content().textContent, /Late private album/); assert.equal(f.api.count('execute'), 0);
});
test('Failed native return preserves acknowledged truth and cannot repeat Add', async t => {
  const f = await fixture(t, {mounted: true}); const open = f.runtime.openForm;
  f.runtime.openForm = options => open({...options, onMount(host, close) {
    return options.onMount(host, (value, closeOptions) => closeOptions?.returnToParent === false
      ? close(value, closeOptions) : Promise.resolve(false));
  }});
  f.open(); await chooseUI(f); await submitUI(f);
  assert.equal(f.controller.getSnapshot().mutation.status, 'ready'); assert.ok(f.form());
  assert.match(f.form().textContent, /albums were added, but this form could not return/);
  assert.equal(button(f.content(), 'Add albums').disabled, true);
  await submitUI(f); assert.equal(f.api.count('execute'), 1);
});
test('Add revocation clears retained form selection immediately and grant restoration does not revive it', async t => {
  const f = await fixture(t, {mounted: true}); f.open(); await chooseUI(f);
  f.controller.observeDenial(SCOPE, Object.assign(new Error('denied'), {status: 403}));
  assert.equal(f.form(), null); assert.doesNotMatch(f.content().textContent, /Selected \(1\)|Found album/);
  await f.controller.load(); await f.controller.open(TOP); assert.equal(f.form(), null); assert.equal(f.api.count('execute'), 0);
});
test('Owner disposal aborts search and detached submit has no provider effect', async t => {
  const pending = deferred(); const f = await fixture(t, {mounted: true, overrides: {searchAlbums: () => pending.promise}});
  f.open(); const form = f.form(); search(f.content(), 'Found'); await settle();
  const signal = f.api.calls.find(row => row.method === 'searchAlbums').args[0].signal;
  f.owner.dispose(); assert.equal(signal.aborted, true);
  pending.resolve({albums: [{local_album_id: 11}], next_cursor: null}); await settle();
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit')); assert.equal(f.api.count('execute'), 0);
  assert.equal(f.form(), null);
});
test('Already stale Add draft still clears private selection when scope subsequently retires', async t => {
  const f = await fixture(t); await choose(f);
  f.api.data.detail = {...f.api.data.detail, revision: '8'}; await f.controller.open(TOP);
  assert.equal(f.draft.getSnapshot().stale, true); f.controller.setScope('another');
  assert.equal(f.draft.getSnapshot().denied, true); assert.equal(f.draft.getSnapshot().title, '');
  assert.equal(f.draft.getSnapshot().query, ''); assert.equal(f.draft.getSnapshot().items.length, 0);
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 0);
});
test('Foreign shared-controller Add acknowledgement cannot close or claim this unsent selection', async t => {
  const f = await fixture(t, {mounted: true}); f.open(); await chooseUI(f);
  assert.equal(await f.controller.mutate('add', {album_refs: [id(99)]}), true); await settle();
  assert.ok(f.form(), 'unsent Add owner remains open'); assert.match(f.content().textContent, /Selected \(1\)/);
  assert.match(f.content().textContent, /Top changed/); assert.equal(button(f.content(), 'Add albums').disabled, true);
  assert.equal(f.api.count('execute'), 1); assert.deepEqual(plain(f.api.calls.find(row => row.method === 'execute').args[1].album_refs), [id(99)]);
  assert.equal(f.calls.closes.length, 0, 'foreign acknowledgement never starts native return');
});
test('Synchronous definitive provider rejection captures no successful Add identity', async t => {
  const f = await fixture(t, {overrides: {execute() {throw Object.assign(new Error('rejected'), {status: 409});}}});
  await choose(f); assert.equal(await f.draft.submit(), false);
  assert.equal(f.draft.getSnapshot().submittedRequestKey, null); assert.equal(f.controller.getSnapshot().mutation.status, 'error');
  assert.equal(f.api.count('execute'), 1); assert.equal(f.draft.getSnapshot().items.length, 1);
});
test('Asynchronous definitive rejection releases captured Add identity while retaining selection', async t => {
  const pending = deferred(); const f = await fixture(t, {overrides: {execute: () => pending.promise}});
  await choose(f); const attempt = f.draft.submit(); assert.equal(f.draft.getSnapshot().submittedRequestKey, id(301));
  pending.reject(Object.assign(new Error('conflict'), {status: 409})); assert.equal(await attempt, false);
  assert.equal(f.draft.getSnapshot().submittedRequestKey, null); assert.equal(f.draft.getSnapshot().items.length, 1);
});
test('Synchronous uncertain provider throw retains exactly the draft-owned request for retry', async t => {
  const f = await fixture(t, {overrides: {execute() {throw new Error('unknown result');}}});
  await choose(f); assert.equal(await f.draft.submit(), false);
  assert.equal(f.draft.getSnapshot().submittedRequestKey, id(301)); assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.count('execute'), 1);
  await f.controller.retryMutation(); assert.equal(f.api.count('execute'), 2);
  assert.equal(f.draft.getSnapshot().submittedRequestKey, id(301));
  const commands = f.api.calls.filter(row => row.method === 'execute').map(row => plain(row.args[1])); assert.deepEqual(commands[0], commands[1]);
});
test('Asynchronous denied write clears submitted identity and private selection together', async t => {
  const pending = deferred(); const f = await fixture(t, {overrides: {execute: () => pending.promise}});
  await choose(f); const attempt = f.draft.submit(); assert.equal(f.draft.getSnapshot().submittedRequestKey, id(301));
  pending.reject(Object.assign(new Error('denied'), {status: 403})); assert.equal(await attempt, false);
  assert.equal(f.draft.getSnapshot().submittedRequestKey, null); assert.equal(f.draft.getSnapshot().items.length, 0);
  assert.equal(f.draft.getSnapshot().title, ''); assert.equal(f.controller.getSnapshot().mutation.status, 'denied');
});
test('Acknowledged Add returns after deferred same-revision refresh and never reports a false close failure', async t => {
  const pending = deferred(); let reads = 0;
  const detail = {top_ref: TOP, revision: '7', title: 'Destination', items: [], allowed_actions: grants()};
  const f = await fixture(t, {mounted: true, overrides: {read: () => ++reads === 1 ? Promise.resolve(detail) : pending.promise}});
  f.open(); await chooseUI(f); await submitUI(f);
  assert.ok(f.form()); assert.equal(await f.calls.owners.at(-1).options.beforeDismiss(), false);
  assert.equal(f.calls.closes.length, 0); pending.resolve(detail); await settle();
  assert.equal(f.form(), null); assert.equal(f.api.count('execute'), 1);
  assert.doesNotMatch(f.content().textContent, /could not return/);
});
test('Accepted delayed discard cannot dismiss Add after a shared-controller write starts', async t => {
  const confirmation = deferred(), write = deferred();
  const f = await fixture(t, {mounted: true, overrides: {execute: () => write.promise}});
  f.runtime.confirm = () => confirmation.promise; f.open(); await chooseUI(f);
  click(button(f.content(), 'Cancel')); await settle(); assert.ok(f.form());
  const attempt = f.controller.mutate('add', {album_refs: [id(99)]});
  confirmation.resolve(true); await settle(); assert.ok(f.form(), 'pending mutation blocks late discard acceptance');
  assert.equal(f.controller.getSnapshot().mutation.status, 'loading');
  const command = f.api.calls.find(row => row.method === 'execute').args[1];
  write.resolve({action: 'add', request_key: command.request_key, top_ref: TOP, revision: '8'}); await attempt; await settle();
  assert.ok(f.form(), 'foreign success still cannot claim selection'); assert.equal(f.api.count('execute'), 1);
});
