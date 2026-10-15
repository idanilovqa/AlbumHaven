const test = require('node:test');
const assert = require('node:assert/strict');
const {button, buttons, plain, deferred, settle, nativeRuntime, loadOwners, viewOwner, playlistShareOwner, click, textContent, choice, choiceValue, choiceOptions, selectChoice, search} = require('./runtime/album-tops-sharing-harness.cjs');
test.before(loadOwners);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), GRANT = id(3), REQUEST = id(4), ACCOUNT = id(5), SCOPE = 'share-ui:actor:library';
const BROWSE = 'library.browse.read';
const top = (actions = {}, patch = {}) => ({top_ref: TOP, title: 'Shared Top', description: 'Subtitle', revision: '7',
  visibility: 'server_shared', items: [], allowed_actions: {[BROWSE]: true, can_read: true, can_view_sharing: true, ...actions}, ...patch});
const sharing = patch => ({top_ref: TOP, revision: '7', visibility: 'server_shared', can_manage: true,
  can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: [{request_ref: REQUEST,
    top_ref: TOP, title: 'Shared Top', account_ref: ACCOUNT, display_name: 'Reader', username_display: 'reader'}], next_pending_cursor: null, ...patch});
const grants = patch => ({top_ref: TOP, revision: '7', visibility: 'server_shared', grants: [{account_ref: ACCOUNT,
  grant_ref: GRANT, role: 'editor', display_name: 'Inactive editor', username_display: 'editor', is_active: false}], next_cursor: null, ...patch});
const candidates = patch => ({top_ref: TOP, revision: '7', candidates: [{account_ref: id(6), account_id: 42,
  display_name: 'Candidate', username_display: 'candidate', grant_ref: null, role: null, allowed_actions: {can_grant_editor: true}}], next_cursor: null, ...patch});
const envelope = data => ({status: 'ready', data, error: null});

function fixture(t, {actions = {can_share: true, can_copy: true}, sharingReply = sharing(), grantsReply = grants(), candidatesReply = candidates(), controller: externalController = null} = {}) {
  const native = nativeRuntime(t), calls = {...native.calls, writes: [], sharing: [], grants: [], candidates: [], opens: []};
  let state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [top()], allowed_actions: {[BROWSE]: true}}},
    detail: {status: 'ready', data: top(actions)}, mutation: {status: 'idle'}};
  const read = (name, value) => async options => {calls[name].push(options); return typeof value === 'function' ? value(options) : envelope(value);};
  const controller = externalController || {getSnapshot: () => state, readSharing: read('sharing', sharingReply), readAccessGrants: read('grants', grantsReply),
    readAccessCandidates: read('candidates', candidatesReply), canRetryMutation: () => false, retryMutation: async () => false,
    mutate(action, value) {calls.writes.push({action, value}); return Promise.resolve(true);}, open(ref) {calls.opens.push(ref);}};
  const props = () => ({runtime: native.runtime, controller, state: controller.getSnapshot(), onOpen: ref => calls.opens.push(ref)});
  if (externalController) native.own({dispose() {externalController.dispose();}});
  const mounted = viewOwner(native, props());
  const renderView = () => {mounted.update(props()); return native.host;};
  const renderShare = () => {
    renderView(); assert.equal(native.modal().hidden, false, 'the current header action must own Share');
    return native.content();
  };
  const renderForm = () => {const content = renderShare(); assert.equal(native.opens.at(-1).title, 'Share Album Top'); return content;};
  const open = async () => {click(button(renderView(), 'Share')); await settle(); return renderForm();};
  return {...native, mounted, calls, controller, props, renderView, renderShare, renderForm, open,
    replace(patch) {state = {...state, ...patch};}, state: () => state};
}

test('Viewer header owns Share and independent Copy while request edit lives inside the native Share dialog', async t => {
  const h = fixture(t, {actions: {can_copy: true, can_request_edit: true, can_share: false, can_edit: false, can_delete: false},
    sharingReply: sharing({can_manage: false, can_request_edit: true, pending_requests: []})});
  const header = h.renderView();
  assert.ok(button(header, 'Share')); assert.ok(button(header, 'Save a copy'));
  for (const label of ['Request edit access', 'Edit Album Top', 'Delete Album Top']) assert.equal(button(header, label), undefined);
  let form = await h.open();
  assert.equal(h.calls.owners.length, 1); assert.equal(h.calls.owners[0].options.title, 'Share Album Top');
  assert.equal(h.calls.owners[0].options.showCloseButton, true);
  assert.ok(button(form, 'Request edit access')); assert.equal(button(form, 'Save visibility'), undefined);
  assert.deepEqual([h.calls.grants.length, h.calls.candidates.length], [0, 0]);
  click(button(form, 'Request edit access'));
  assert.deepEqual(plain(h.calls.writes), [{action: 'request_edit'}]);
  h.replace({mutation: {status: 'loading', action: 'request_edit'}}); form = h.renderForm();
  assert.equal(button(form, 'Request edit access').disabled, true);
  click(button(form, 'Request edit access')); assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.owners[0].dismissDisabled, true); assert.equal(h.calls.owners[0].options.beforeDismiss(), false);
});

test('pending Viewer request remains visible without a duplicate request or invented edit permissions', async t => {
  const h = fixture(t, {actions: {can_request_edit: true, can_edit: false},
    sharingReply: sharing({can_manage: false, can_request_edit: true, request_status: 'pending', pending_requests: []})});
  const form = await h.open();
  assert.equal(button(form, 'Request edit access').disabled, true);
  click(button(form, 'Request edit access')); assert.equal(h.calls.writes.length, 0);
  assert.match(textContent(form), /Edit access requested/);
  assert.equal(button(h.renderView(), 'Edit Album Top'), undefined);
});

test('owner changes current visibility, revokes retained inactive grants and grants only explicit eligible candidates', async t => {
  const h = fixture(t); let form = await h.open();
  assert.match(textContent(form), /Inactive account/);
  assert.equal(button(form, 'Remove access').disabled, false);
  click(button(form, 'Remove access'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'revoke_editor', value: {grant_ref: GRANT}});
  assert.equal(choiceValue(choice(form, 'Access for Candidate')), 'viewer');
  assert.equal(button(form, 'Add access').disabled, true, 'Editor eligibility does not authorize the default Viewer role');
  click(button(form, 'Add access')); assert.equal(h.calls.writes.length, 0);
  selectChoice(choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  assert.equal(choiceValue(choice(form, 'Access for Candidate')), 'editor');
  assert.equal(h.calls.writes.length, 0, 'role choice alone cannot grant access');
  assert.equal(button(form, 'Add access').disabled, false);
  click(button(form, 'Add access'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_editor', value: {account_id: 42, role: 'editor'}});
  const visibility = choice(form, 'Album Top visibility');
  assert.deepEqual(plain(choiceOptions(visibility)), [['private', 'Private'], ['server_shared', 'Shared with this server']]);
  assert.equal(button(form, 'Save visibility').disabled, true);
  selectChoice(visibility, 'private'); form = h.renderForm();
  assert.equal(button(form, 'Save visibility').disabled, false);
  click(button(form, 'Save visibility'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'visibility', value: {visibility: 'private'}});
  assert.equal(h.state().detail.data.revision, '7');
});

test('owner request approval requires explicit Editor selection; Decline never creates a grant', async t => {
  const h = fixture(t); let form = await h.open();
  assert.equal(button(form, 'Apply').disabled, true);
  click(button(form, 'Apply')); assert.equal(h.calls.writes.length, 0);
  assert.equal(choiceValue(choice(form, 'Access for Reader')), 'viewer');
  selectChoice(choice(form, 'Access for Reader'), 'editor'); form = h.renderForm();
  assert.equal(button(form, 'Apply').disabled, false);
  click(button(form, 'Apply'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'decide_edit_request', value: {request_ref: REQUEST, decision: 'approve'}});
  click(button(form, 'Decline'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'decide_edit_request', value: {request_ref: REQUEST, decision: 'decline'}});
});

test('revision conflicts disable every owner access write and stale callbacks recheck current authority', async t => {
  const h = fixture(t, {grantsReply: grants({revision: '8'})});
  const form = await h.open();
  assert.match(textContent(form), /changed. Refresh it/);
  for (const label of ['Remove access', 'Add access', 'Apply access', 'Apply', 'Decline', 'Save visibility']) {
    const control = button(form, label); assert.equal(control.disabled, true, label); click(control);
  }
  assert.equal(h.calls.writes.length, 0);
  const fresh = fixture(t); let original = await fresh.open();
  selectChoice(choice(original, 'Access for Candidate'), 'editor'); original = fresh.renderForm();
  const retainedRemove = button(original, 'Remove access'), retainedAdd = button(original, 'Add access');
  assert.equal(retainedRemove.disabled, false); assert.equal(retainedAdd.disabled, false);
  fresh.replace({detail: {status: 'ready', data: top({can_share: false})}});
  click(retainedRemove); click(retainedAdd);
  assert.equal(fresh.calls.writes.length, 0, 'retained rendered controls are never authority');
});

test('grant, pending-request and candidate directories page independently; query changes abort and retire old candidate pages', async t => {
  const late = deferred();
  const h = fixture(t, {sharingReply: sharing({next_pending_cursor: 'request-page-2'}), grantsReply: grants({next_cursor: 'grant-page-2'}),
    candidatesReply: options => options.q === 'slow' ? late.promise : envelope(candidates({next_cursor: 'candidate-page-2'}))});
  let form = await h.open();
  for (const [label, owner, cursor] of [['More edit requests', 'sharing', 'request-page-2'], ['More people with access', 'grants', 'grant-page-2'],
    ['More library members', 'candidates', 'candidate-page-2']]) {
    click(button(form, label)); h.renderShare(); await settle(); form = h.renderForm();
    assert.equal(h.calls[owner].at(-1).cursor, cursor);
    assert.equal(button(form, label).disabled, true, 'a repeated cursor cannot loop');
  }
  search(form, 'slow'); h.renderShare(); await settle();
  const slow = h.calls.candidates.at(-1); assert.equal(slow.cursor, null);
  form = h.renderForm(); search(form, 'new'); h.renderShare(); await settle();
  assert.equal(slow.signal.aborted, true);
  late.resolve(envelope(candidates({candidates: [{...candidates().candidates[0], display_name: 'Stale private member'}]})));
  await settle(); form = h.renderForm();
  assert.doesNotMatch(textContent(form), /Stale private member/);
  assert.equal(h.calls.candidates.at(-1).q, 'new'); assert.equal(h.calls.candidates.at(-1).cursor, null);
});

test('ineligible candidate controls stay disabled and cannot dispatch a grant through retained handlers', async t => {
  const h = fixture(t, {candidatesReply: candidates({candidates: [
    {...candidates().candidates[0], allowed_actions: {can_grant_editor: false}},
    {...candidates().candidates[0], account_ref: id(8), grant_ref: GRANT, role: 'editor', allowed_actions: {can_grant_editor: false}},
  ]})});
  let form = await h.open();
  assert.equal(choiceValue(choice(form, 'Access for Candidate')), 'viewer');
  assert.equal(button(form, 'Add access').disabled, true);
  click(button(form, 'Add access')); assert.equal(h.calls.writes.length, 0);
  selectChoice(choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  assert.equal(choiceValue(choice(form, 'Access for Candidate')), 'editor');
  const add = button(form, 'Add access'); assert.equal(add.disabled, true); click(add);
  const existing = buttons(form).filter(control => control.textContent.trim() === 'Apply access');
  assert.equal(existing.length, 2, 'inactive grant and already-Editor candidate both retain explicit Apply controls');
  for (const control of existing) {assert.equal(control.disabled, true); click(control);}
  assert.equal(h.calls.writes.length, 0);
});

test('native Share Close and unmount abort current reads and never allow late callbacks or private repaint', async t => {
  const delayed = deferred();
  const h = fixture(t, {candidatesReply: () => delayed.promise});
  const form = await h.open(), candidateRead = h.calls.candidates.at(-1);
  click(button(form, 'Close')); await settle();
  assert.equal(h.modal().hidden, true);
  h.renderView(); assert.equal(h.modal().hidden, true);
  const retiredMarkup = h.content().innerHTML;
  assert.equal(candidateRead.signal.aborted, true);
  delayed.resolve(envelope(candidates())); await settle();
  assert.equal(h.content().innerHTML, retiredMarkup, 'late private result cannot repaint retired native form');
  const unmountReply = deferred(), unmount = fixture(t, {candidatesReply: () => unmountReply.promise});
  await unmount.open(); const unmountRead = unmount.calls.candidates.at(-1);
  unmount.mounted.dispose(); assert.equal(unmountRead.signal.aborted, true);
  assert.ok(unmount.calls.closes.some(value => value.force && value.restoreFocus === false && value.returnToParent === false));
  unmountReply.resolve(envelope(candidates())); await settle();
  assert.equal(unmount.modal().hidden, true); assert.equal(unmount.content().childNodes.length, 0);
});

test('Editor keeps approved metadata editing while owner-only Delete/access stay unavailable', async t => {
  const h = fixture(t, {actions: {can_edit: true, can_rename: true, can_share: false, can_delete: false, can_copy: true},
    sharingReply: sharing({can_manage: false, can_request_edit: false, pending_requests: []})});
  assert.ok(button(h.renderView(), 'Edit Album Top'));
  assert.equal(button(h.renderView(), 'Delete Album Top'), undefined);
  const form = await h.open();
  for (const label of ['Apply', 'Decline', 'Add access', 'Apply access', 'Remove access', 'Save visibility', 'Request edit access']) assert.equal(button(form, label), undefined);
});

for (const owner of [false, true]) test(`shared Share presentation preserves ${owner ? 'owner' : 'Viewer'} Playlist actions and native lifetime`, async t => {
  const h = nativeRuntime(t), writes = [];
  const detail = {playlist_id: TOP, revision: '7', title: 'Existing Playlist', description: '', track_rows: []};
  const state = {scopeKey: SCOPE, selectedPlaylistId: TOP, resource: {status: 'ready', data: {detail}}, drafts: {}, mutation: {status: 'idle'}};
  const value = {playlist_id: TOP, revision: '7', visibility: 'server_shared', can_manage: owner,
    can_request_edit: !owner, request_status: 'none', people: [], pending_requests: owner ? [sharing().pending_requests[0]] : [], next_cursor: null};
  const controller = {getSnapshot: () => state, readSharing: async () => envelope(value), available: () => true,
    mutate(action, data) {writes.push({action, data});}, getLifecycleVersion: () => 1};
  const props = {runtime: h.runtime, controller, state, onClose() {}};
  const mounted = playlistShareOwner(h, props);
  const render = () => {mounted.update(props); return h.content();};
  render(); await settle(); let form = render();
  assert.equal(h.calls.owners[0].options.title, 'Share playlist');
  assert.equal(h.calls.owners[0].options.showCloseButton, true);
  if (owner) {
    assert.equal(button(form, 'Apply').disabled, true);
    click(button(form, 'Apply')); assert.equal(writes.length, 0);
    selectChoice(choice(form, 'Access for Reader'), 'editor'); form = render();
    click(button(form, 'Apply'));
    assert.deepEqual(plain(writes.pop()), {action: 'decideEditRequest', data: {request_ref: REQUEST, decision: 'approve'}});
    click(button(form, 'Decline'));
    assert.deepEqual(plain(writes.pop()), {action: 'decideEditRequest', data: {request_ref: REQUEST, decision: 'decline'}});
    assert.deepEqual(plain(choiceOptions(choice(form, 'Playlist visibility'))), [
      ['private', 'Private'], ['server_shared', 'Shared with this server'], ['link', 'Public link unavailable', true],
    ]);
  } else {
    assert.ok(button(form, 'Request edit access'));
    click(button(form, 'Request edit access'));
    assert.deepEqual(plain(writes), [{action: 'requestEditAccess'}]);
    assert.equal(button(form, 'Apply'), undefined); assert.equal(button(form, 'Save visibility'), undefined);
  }
});


test('native Share and Copy controls render accessible visible-disabled button semantics during uncertain writes', t => {
  const h = nativeRuntime(t);
  const detail = top({can_copy: true, can_share: true});
  const state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [detail]}},
    detail: {status: 'ready', data: detail}, mutation: {status: 'uncertain', action: 'copy'}};
  const controller = {getSnapshot: () => state, canRetryMutation: () => false};
  const host = h.host; viewOwner(h, {controller, state});
  for (const label of ['Share', 'Save a copy']) {
    const control = host.querySelector(`button[aria-label="${label}"]`);
    assert.ok(control); assert.equal(control.disabled, true); assert.equal(control.getAttribute('aria-disabled'), 'true');
    assert.equal(control.classList.contains('action-button'), true);
  }
  assert.equal(host.querySelector('button[aria-label="Request edit access"]'), null);
});

test('known-denied uncertain access write can leave the actual native form without losing or replaying its original operation', async t => {
  const {createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs');
  const h = nativeRuntime(t), native = h, writes = [];
  let canManage = true;
  const controller = createAlbumTopController({requestKey: () => id(90), providers: {
    list: () => ({tops: [top({can_share: true})], allowed_actions: {[BROWSE]: true}}),
    read: () => top({can_share: true}),
    readSharing: () => sharing({can_manage: canManage, pending_requests: canManage ? sharing().pending_requests : []}),
    readAccessGrants: () => grants(), readAccessCandidates: () => candidates(),
    execute(action, command) {
      writes.push({action, command: plain(command)});
      if (writes.length === 1) throw new TypeError('Result was lost after the access write');
      return {action, request_key: command.request_key, top_ref: TOP, revision: '8'};
    },
  }});
  controller.setScope(SCOPE); await controller.load(); await controller.open(TOP);
  h.own({dispose() {controller.dispose();}});
  const props = () => ({controller, state: controller.getSnapshot(), onOpen: ref => controller.open(ref)});
  const mounted = viewOwner(h, props());
  const view = () => {mounted.update(props()); return h.host;};
  const share = () => {view(); assert.equal(h.modal().hidden, false); return h.content();};
  const form = share;
  click(button(view(), 'Share')); await settle();
  const owner = h.calls.owners.at(-1).owner;
  let fields = form(); selectChoice(choice(fields, 'Album Top visibility'), 'private'); fields = form();
  click(button(fields, 'Save visibility')); await settle(); form();
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  const original = plain(controller.getSnapshot().mutation.command);
  assert.equal(controller.canRetryMutation(), true);
  assert.equal(native.document.getElementById('app-form-close').disabled, true);
  assert.equal(await owner.dismiss('back'), false, 'an uncertain operation with available exact recovery keeps its existing guard');
  canManage = false;
  // A fresh detail lifetime causes the actual Share read effect to consume the
  // later Sharing denial; it must not clear the unresolved operation.
  await controller.open(TOP); share(); await settle(); share(); await settle(); fields = form();
  assert.equal(controller.canRetryMutation(), false);
  assert.equal(button(fields, 'Close').disabled, false);
  assert.equal(native.document.getElementById('app-form-close').disabled, false);
  assert.equal(await controller.retryMutation(), false); assert.equal(writes.length, 1);
  assert.equal(await owner.dismiss('back'), true, 'the actual native owner permits leaving once exact recovery is denied');
  await owner.promise;
  assert.equal(native.document.getElementById('app-form-modal').hidden, true);
  view(); assert.equal(h.modal().hidden, true);
  assert.equal(h.content().childNodes.length, 0);
  assert.deepEqual(plain(controller.getSnapshot().mutation.command), original);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(controller.canRetryMutation(), false);
  click(button(view(), 'Back')); await settle();
  assert.equal(controller.getSnapshot().selectedTopRef, null);
  assert.deepEqual(plain(controller.getSnapshot().mutation.command), original);
  canManage = true; await controller.open(TOP);
  assert.equal(controller.canRetryMutation(), true);
  assert.equal(await controller.retryMutation(), true);
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].command, original);
});


for (const [action, field] of [['copy', 'can_copy'], ['visibility', 'can_manage'], ['request_edit', 'can_request_edit']]) {
  test(`current native controls consume Sharing ${field} denial and retained handlers cannot dispatch ${action}`, async t => {
    const {createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs');
    let allowed = true; const writes = [];
    const controller = createAlbumTopController({requestKey: () => id(90), providers: {
      list: () => ({tops: [top()], allowed_actions: {[BROWSE]: true}}),
      read: () => top({can_copy: true, can_share: action !== 'request_edit', can_request_edit: true}),
      readSharing: () => sharing({can_manage: action !== 'request_edit', can_request_edit: true,
        pending_requests: action === 'request_edit' ? [] : sharing().pending_requests, [field]: allowed}),
      readAccessGrants: () => grants(), readAccessCandidates: () => candidates(),
      execute(kind, command) {writes.push({kind, command}); return {action: kind, top_ref: TOP, request_key: command.request_key, revision: '8'};},
    }});
    controller.setScope(SCOPE); await controller.load(); await controller.open(TOP);
    const h = fixture(t, {controller});
    const oldCopy = button(h.renderView(), 'Save a copy'); let fields = await h.open();
    if (action === 'visibility') {
      selectChoice(choice(fields, 'Album Top visibility'), 'private'); fields = h.renderForm();
      assert.equal(choiceValue(choice(fields, 'Album Top visibility')), 'private');
    }
    const retained = action === 'copy' ? oldCopy : action === 'visibility' ? button(fields, 'Save visibility') : button(fields, 'Request edit access');
    assert.ok(retained); assert.equal(retained.disabled, false);
    assert.equal(writes.length, 0, 'a local draft is not a write');
    allowed = false; await controller.readSharing({});
    h.renderShare(); await settle(); h.renderShare(); await settle(); fields = h.renderForm();
    click(retained); await settle();
    assert.equal(writes.length, 0);
    if (action === 'copy') assert.equal(button(h.renderView(), 'Save a copy'), undefined);
    if (action === 'visibility') {
      assert.equal(button(fields, 'Add access'), undefined); assert.equal(button(fields, 'Remove access'), undefined);
      assert.equal(button(fields, 'Apply access'), undefined);
      assert.equal(choice(fields, 'Album Top visibility'), undefined);
      assert.equal(button(fields, 'Save visibility'), undefined);
    }
    if (action === 'request_edit') {
      const request = button(fields, 'Request edit access');
      assert.equal(!request || request.disabled === true, true, 'fresh request denial hides or disables the read-only Share action');
    }
    assert.ok(button(h.renderView(), 'Share'), 'read-only Share remains available after action denial');
  });
}
