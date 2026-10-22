'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const J = require('./album-tops-joined-share-fixtures/joined.cjs');
const {fixture, backend, joined, settle, deferred, sharing, candidate, publication, source, TOP, OTHER, SCOPE, ITEM} = J;

// J1: actual native dialog and keyed content, with no synthetic publication.
test('joined Share exposes one native shell and both labelled panes immediately, including the loading first render', async t => {
  const gate = deferred(), data = backend({handlers: {readSharing: () => gate.promise}}), env = await fixture(t, data);
  const before = joined(env); assert.equal(env.opens.length, 1); assert.equal(env.opens[0].title, 'Share Album Top');
  assert.equal(env.opens[0].pageId, 'share-album-top'); assert.equal(env.opens[0].showCloseButton, true);
  assert.equal(typeof env.opens[0].beforeDismiss, 'function'); assert.equal(env.document.getElementById('app-form-close').hidden, false);
  assert.equal(env.content().querySelector('[role="dialog"]'), null); assert.equal(env.content().querySelectorAll('#album-top-share-public-heading').length, 1);
  assert.equal(J.buttons(env.content()).filter(node => node.textContent.trim() === 'Close').length, 1);
  assert.equal(J.button(env.content(), 'Generate image'), undefined); assert.doesNotMatch(env.content().textContent, /https?:\/\/|demo URL/i);
  assert.equal(data.count('execute'), 0); assert.equal(data.count('readPublicationSources'), 0);
  gate.resolve(sharing({publication: publication()})); await settle();
  const after = joined(env); assert.equal(after.grid, before.grid); assert.equal(after.publicPane, before.publicPane); assert.equal(after.people, before.people);
  const panel = after.publicPane.querySelector('.album-top-share__publication'), refresh = env.button(after.publicPane, 'Refresh Album Top');
  assert.ok(panel); assert.ok(after.publicPane.lastElementChild.contains(refresh)); assert.equal(after.publicPane.contains(panel), true);
  assert.ok(env.button(after.people, 'Save visibility')); assert.equal(data.count('execute'), 0);
});

// J2: cross-pane refresh, actual directory pages and retry preserve keyed input.
test('joined updates preserve member row, role, focus, list and scroll through publication/query/page/retry changes', async t => {
  let failPage = true;
  const data = backend({handlers: {readAccessCandidates: (_ref, options) => {
    if (options.cursor && failPage) throw new Error('Temporary directory failure');
    return {top_ref: TOP, revision: '7', candidates: options.q ? [candidate(71, 'Ben')] : [candidate()], next_cursor: options.cursor ? null : 'page-2'};
  }}}), env = await fixture(t, data), panes = joined(env);
  J.selectChoice(env.button(panes.people, 'Access for Ada: Viewer'), 'editor'); await settle();
  const role = env.button(panes.people, 'Access for Ada: Editor'), row = role.closest('.playlists__share-person');
  const list = row.closest('.album-top-share__member-results'), input = panes.people.querySelector('input[type="search"]');
  let sources = null; list.scrollTop = 73; input.focus();
  const stable = () => {const next = joined(env); assert.equal(next.grid, panes.grid); assert.equal(next.publicPane, panes.publicPane);
    assert.equal(next.people, panes.people); assert.equal(next.people.querySelector('input[type="search"]'), input);
    assert.equal(env.button(next.people, 'Access for Ada: Editor'), role); assert.equal(role.closest('.playlists__share-person'), row);
    assert.equal(role.closest('.album-top-share__member-results'), list); assert.equal(list.scrollTop, 73);
    if (sources) {assert.equal(next.publicPane.querySelector('.album-top-share__source-results'), sources); assert.equal(sources.scrollTop, 29);}
    assert.equal(env.document.activeElement, input);};
  await env.controller.readSharing(); await settle(); stable();
  // A new publication observation correctly retires old source authority.
  // The source list is acquired afterward and persists across People updates.
  env.click(env.button(panes.publicPane.querySelector(`[data-item-ref="${ITEM}"]`), 'Choose source')); await settle();
  sources = panes.publicPane.querySelector('.album-top-share__source-results'); assert.ok(sources); sources.scrollTop = 29; input.focus();
  env.input(input, 'Ben'); await settle(); stable(); assert.ok(env.button(panes.people, 'Access for Ben: Viewer'));
  env.click(env.button(list, 'More library members')); await settle(); input.focus(); stable();
  assert.match(list.textContent, /Eligible library members could not be loaded/); assert.equal(data.last('readAccessCandidates').args[1].cursor, 'page-2');
  failPage = false; env.click(env.button(list, 'Retry')); await settle(); input.focus(); stable();
  assert.equal(data.last('readAccessCandidates').args[1].cursor, 'page-2'); assert.equal(data.count('execute'), 0);
  assert.equal(panes.people.querySelectorAll('.album-top-share__member-results').length, 1);
});

// J3: truthful read/error/unavailable projections never expand permission.
test('sharing error and retry keep both joined sections without fabricated publication or access writes', async t => {
  const data = backend({handlers: {readSharing: () => {throw new Error('Private provider failure');}}}), env = await fixture(t, data), panes = joined(env);
  assert.match(env.content().textContent, /Album Top sharing could not be loaded/);
  assert.equal(J.button(panes.people, 'Save visibility'), undefined); assert.equal(J.button(panes.publicPane, 'Publish'), undefined);
  assert.doesNotMatch(panes.publicPane.textContent, /Not published/); delete data.control.readSharing;
  env.click(env.button(env.content(), 'Retry')); await settle(); const next = joined(env);
  assert.equal(next.grid, panes.grid); assert.equal(next.people, panes.people); assert.equal(next.publicPane, panes.publicPane);
  assert.equal(data.count('execute'), 0); assert.equal(data.count('readPublicationSources'), 0);
});

for (const manage of [false, true]) test(`missing public authority keeps joined People ${manage ? 'owner controls' : 'reader access'} truthful`, async t => {
  const data = backend({handlers: {readSharing: () => sharing({can_manage: manage})}}), env = await fixture(t, data), panes = joined(env);
  assert.equal(env.controller.getSnapshot().publication.status, 'unavailable'); assert.equal(env.controller.getSnapshot().publication.data, null);
  assert.doesNotMatch(panes.publicPane.textContent, /Not published|https?:\/\//);
  for (const action of ['Publish','Republish','Revoke public link','Copy link','Generate image']) assert.equal(J.button(panes.publicPane, action), undefined);
  if (manage) assert.ok(env.button(panes.people, 'Save visibility'));
  else {assert.match(panes.people.textContent, /Only the owner can change access/); assert.ok(env.button(panes.people, 'Request edit access'));
    assert.equal(data.count('readAccessGrants'), 0); assert.equal(data.count('readAccessCandidates'), 0);}
  assert.equal(data.count('execute'), 0); assert.equal(data.count('readPublicationSources'), 0);
});

// J4: layout cannot change existing page/controller subject fences.
for (const retirement of ['actor', 'resource', 'detail revision']) test(`joined pending readers reject old ${retirement} results`, async t => {
  const grants = deferred(), candidates = deferred(), sources = deferred();
  const data = backend({handlers: {readAccessGrants: () => grants.promise, readAccessCandidates: () => candidates.promise,
    readPublicationSources: () => sources.promise}}), env = await fixture(t, data); joined(env);
  env.click(env.button(env.content().querySelector(`[data-item-ref="${ITEM}"]`), 'Choose source')); await settle();
  const reads = ['readAccessGrants','readAccessCandidates','readPublicationSources'].map(method => data.last(method)); assert.ok(reads.every(Boolean));
  delete data.control.readAccessGrants; delete data.control.readAccessCandidates; delete data.control.readPublicationSources;
  if (retirement === 'actor') env.controller.setScope(`${SCOPE}:new`);
  else if (retirement === 'resource') await env.controller.open(OTHER);
  else {data.data.detail = {...data.data.detail, revision: '8'}; await env.controller.open(TOP);}
  await settle(); assert.ok(reads.every(read => read.args.at(-1).signal.aborted));
  grants.resolve({top_ref: TOP, revision: '7', grants: [{...candidate(80, 'Late private grant'), grant_ref: J.id(81), role: 'viewer', is_active: true}], next_cursor: null});
  candidates.resolve({top_ref: TOP, revision: '7', candidates: [candidate(82, 'Late private candidate')], next_cursor: null});
  const late = source(); late.sources[0].title = 'Late private source'; sources.resolve(late); await settle();
  assert.doesNotMatch(env.document.body.textContent, /Late private (grant|candidate|source)/); assert.equal(data.count('execute'), 0);
  if (retirement !== 'detail revision') assert.equal(env.modal().hidden, true);
});

// J5: the existing native shell, rather than a joined-pane Close facade, owns dismissal.
for (const action of ['Close', 'X', 'Escape']) test(`joined native ${action} dismisses a clean form and restores the same trigger focus`, async t => {
  const env = await fixture(t, backend(), {open: false}), trigger = await env.launch(); joined(env);
  if (action === 'Close') env.click(env.button(env.content(), 'Close'));
  else if (action === 'X') env.click(env.document.getElementById('app-form-close'));
  else env.modal().dispatchEvent(new env.context.Event('keydown', {key: 'Escape'}));
  await settle(); assert.equal(env.modal().hidden, true); assert.equal(env.content().textContent, '');
  assert.equal(env.document.activeElement, trigger); assert.equal(env.data.count('execute'), 0);
});

for (const reentry of ['refresh', 'close']) test(`joined native presentation ${reentry} reentry cannot duplicate or revive keyed content`, async t => {
  const env = await fixture(t, backend(), {open: false}), actualOpen = env.runtime.openForm; let armed = false, entered = false, pending;
  env.runtime.openForm = options => {const owner = actualOpen(options); return {...owner, updatePresentation(next) {
    owner.updatePresentation(next); if (armed) {armed = false; entered = true;
      pending = reentry === 'refresh' ? env.controller.load() : owner.close(null, {force: true, restoreFocus: false});}
  }};};
  await env.launch(); const before = joined(env); armed = true; await env.controller.readSharing(); await settle(); await pending; await settle();
  assert.equal(entered, true); assert.equal(env.opens.length, 1); assert.equal(env.data.count('execute'), 0);
  if (reentry === 'close') {assert.equal(env.modal().hidden, true); assert.equal(env.content().textContent, '');}
  else {const after = joined(env); assert.equal(after.grid, before.grid); assert.equal(after.people, before.people); assert.equal(after.publicPane, before.publicPane);}
});

// J6: unknown real publication outcome exposes recovery in the public section.
test('unknown revoke exposes guarded public Refresh immediately while native dismissal and people writes remain blocked', async t => {
  const data = backend({owner: publication('enabled'), handlers: {execute: () => {throw new Error('Acknowledgment lost');}}}), env = await fixture(t, data);
  const panes = joined(env); env.click(env.button(panes.publicPane, 'Revoke public link')); await settle();
  env.click(env.document.getElementById('app-confirm-accept')); await settle();
  assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain'); const refresh = env.button(panes.publicPane, 'Refresh Album Top');
  assert.equal(refresh.disabled, false); assert.ok(panes.publicPane.lastElementChild.contains(refresh));
  // An unknown write retires publication retry authority. The real public
  // Refresh reacquires it; a current projection still is not an acknowledgment.
  const authorityReads = data.calls.length; env.click(refresh); await settle();
  const recoveryCalls = data.calls.slice(authorityReads).map(call => call.method);
  assert.ok(recoveryCalls.indexOf('read') >= 0);
  assert.ok(recoveryCalls.indexOf('readSharing') > recoveryCalls.indexOf('read'));
  assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(env.controller.canRetryMutation(), true); assert.equal(data.count('execute'), 1);
  assert.equal(env.button(env.content(), 'Close').disabled, true); assert.equal(env.document.getElementById('app-form-close').disabled, true);
  assert.equal(env.button(panes.people, 'Save visibility').disabled, true);
  env.click(env.button(env.content(), 'Close')); env.click(env.document.getElementById('app-form-close'));
  env.modal().dispatchEvent(new env.context.Event('keydown', {key: 'Escape'})); await settle(); assert.equal(env.modal().hidden, false);
  const read = deferred(); data.control.read = () => read.promise;
  const count = data.count('read'); env.click(refresh); await settle(); assert.equal(data.count('read'), count + 1);
  assert.equal(env.button(joined(env).publicPane, 'Refresh Album Top').disabled, true); env.click(refresh); await settle(); assert.equal(data.count('read'), count + 1);
  read.resolve(data.data.detail); await settle(); assert.equal(data.count('execute'), 1); joined(env);
});

// J7: use the actual unchanged Playlist controller and native sharing consumer.
test('Playlist Share remains people-only with its existing disabled public-link Choice and no publication provider', async t => {
  const {actualChoiceEnvironment} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
  const {createPlaylistController} = await J.load('playlists/model.mjs'), {mountSharePlaylist} = await J.load('playlists/native-sharing.mjs');
  const env = actualChoiceEnvironment(), calls = [];
  const controller = createPlaylistController({providers: {readSharing(options) {calls.push(options); return Promise.resolve({visibility: 'private', revision: '7',
    next_cursor: null, can_manage: true, people: [{account_ref: 'peer', display_name: 'Existing editor', username_display: null, role: 'editor', selected: true, can_edit: true}]});}}});
  controller.setScope(SCOPE); controller.accept({playlist_sidebar: {items: [{playlist_id: 'playlist-A', title: 'Playlist', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'playlist-A', title: 'Playlist', revision: '7', description: '', track_rows: [], items_complete: true,
      active_sort: {key: 'playlist_position', direction: 'asc'}, allowed_actions: {can_open: true, can_share: true, can_view_sharing: true}}}, 'playlist-A');
  let owner; t.after(async () => {owner?.dispose(); controller.dispose(); await settle(); env.assertClean(); env.host.remove();});
  owner = mountSharePlaylist(env.host, env.runtime, {controller, state: controller.getSnapshot()}); await settle();
  assert.equal(env.opens.length, 1); assert.equal(env.opens[0].title, 'Share playlist'); assert.equal(calls.length, 1);
  assert.equal(env.content().querySelector('.app-form-joined'), null); assert.equal(env.content().querySelector('#album-top-share-public'), null);
  assert.match(env.content().textContent, /Public links are unavailable/); assert.ok(env.button(env.content(), 'Remove editor'));
  assert.deepEqual(J.choiceOptions(env.button(env.content(), 'Playlist visibility: Private')),
    [['private','Private'], ['server_shared','Shared with this server'], ['link','Public link unavailable',true]]);
  for (const label of ['Public Share','Generate link','Generate image','Publish','Copy link','Revoke public link']) assert.equal(J.button(env.content(), label), undefined);
  assert.equal(controller.available('enable_external'), false); assert.equal(calls.length, 1);
});
