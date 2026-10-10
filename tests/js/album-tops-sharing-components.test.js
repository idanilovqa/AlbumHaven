const test = require('node:test');
const assert = require('node:assert/strict');
const {renderToStaticMarkup} = require('react-dom/server');
const {React, elements, component, button, buttons, plain, deferred, settle, hookDriver, componentExports, nativeRuntime} = require('./runtime/album-tops-sharing-harness.cjs');
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
const sharedPresentations = new Set(['SharingVisibility', 'SharingMember', 'SharingReaderAccess', 'SharingRequestDecision', 'SharingPages', 'SharingFields']);
function expand(node) {
  if (!React.isValidElement(node)) return node;
  if (sharedPresentations.has(node.type?.name)) return expand(node.type(node.props));
  return React.cloneElement(node, {}, ...React.Children.toArray(node.props.children).map(expand));
}
const textContent = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(textContent).join(' ') : '';
const choice = (tree, label) => elements(tree).find(node => node.type?.name === 'NativeChoice' && (!label || node.props.label === label));

function fixture(t, {actions = {can_share: true, can_copy: true}, sharingReply = sharing(), grantsReply = grants(), candidatesReply = candidates(), controller: externalController = null} = {}) {
  const driver = hookDriver('album-tops/app.jsx'), native = nativeRuntime(), calls = {...native.calls, writes: [], sharing: [], grants: [], candidates: [], opens: []};
  let state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [top()], allowed_actions: {[BROWSE]: true}}},
    detail: {status: 'ready', data: top(actions)}, mutation: {status: 'idle'}};
  const read = (name, value) => async options => {calls[name].push(options); return typeof value === 'function' ? value(options) : envelope(value);};
  const controller = externalController || {getSnapshot: () => state, readSharing: read('sharing', sharingReply), readAccessGrants: read('grants', grantsReply),
    readAccessCandidates: read('candidates', candidatesReply), canRetryMutation: () => false, retryMutation: async () => false,
    mutate(action, value) {calls.writes.push({action, value}); return Promise.resolve(true);}, open(ref) {calls.opens.push(ref);}};
  const props = () => ({runtime: native.runtime, controller, state: controller.getSnapshot(), onOpen: ref => calls.opens.push(ref)});
  const renderView = () => driver.render('view', driver.exports.AlbumTopsView, props());
  const renderShare = () => {
    const share = component(renderView(), 'ShareAlbumTop'); assert.ok(share, 'the current header action must own Share');
    return driver.render('share', share.type, share.props);
  };
  const renderForm = () => {
    const dialog = renderShare(); assert.equal(dialog.type.name, 'NativeDialog');
    driver.render('dialog', dialog.type, dialog.props);
    const portal = driver.render('dialog', dialog.type, dialog.props);
    return expand(portal.props.children);
  };
  const open = async () => {
    button(renderView(), 'Share').props.onClick(); renderShare(); await settle(); renderShare(); await settle(); return renderForm();
  };
  t.after(() => driver.dispose());
  return {...native, driver, calls, controller, props, renderView, renderShare, renderForm, open,
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
  button(form, 'Request edit access').props.onClick();
  assert.deepEqual(plain(h.calls.writes), [{action: 'request_edit'}]);
  h.replace({mutation: {status: 'loading', action: 'request_edit'}}); form = h.renderForm();
  assert.equal(button(form, 'Request edit access').props.disabled, true);
  button(form, 'Request edit access').props.onClick(); assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.owners[0].dismissDisabled, true); assert.equal(h.calls.owners[0].options.beforeDismiss(), false);
});

test('pending Viewer request remains visible without a duplicate request or invented edit permissions', async t => {
  const h = fixture(t, {actions: {can_request_edit: true, can_edit: false},
    sharingReply: sharing({can_manage: false, can_request_edit: true, request_status: 'pending', pending_requests: []})});
  const form = await h.open();
  assert.equal(button(form, 'Request edit access').props.disabled, true);
  button(form, 'Request edit access').props.onClick(); assert.equal(h.calls.writes.length, 0);
  assert.match(textContent(form), /Edit access requested/);
  assert.equal(button(h.renderView(), 'Edit Album Top'), undefined);
});

test('owner changes current visibility, revokes retained inactive grants and grants only explicit eligible candidates', async t => {
  const h = fixture(t); let form = await h.open();
  assert.match(textContent(form), /Inactive account/);
  assert.equal(button(form, 'Remove editor').props.disabled, false);
  button(form, 'Remove editor').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'revoke_editor', value: {grant_ref: GRANT}});
  assert.equal(button(form, 'Add editor').props.disabled, false);
  button(form, 'Add editor').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_editor', value: {account_id: 42, role: 'editor'}});
  const visibility = choice(form, 'Album Top visibility');
  assert.deepEqual(plain(visibility.props.options), [['private', 'Private'], ['server_shared', 'Shared with this server']]);
  assert.equal(button(form, 'Save visibility').props.disabled, true);
  visibility.props.onChange('private'); form = h.renderForm();
  assert.equal(button(form, 'Save visibility').props.disabled, false);
  button(form, 'Save visibility').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'visibility', value: {visibility: 'private'}});
  assert.equal(h.state().detail.data.revision, '7');
});

test('owner request approval requires explicit Editor selection; Decline never creates a grant', async t => {
  const h = fixture(t); let form = await h.open();
  assert.equal(button(form, 'Apply').props.disabled, true);
  button(form, 'Apply').props.onClick(); assert.equal(h.calls.writes.length, 0);
  assert.equal(choice(form, 'Access for Reader').props.value, 'viewer');
  choice(form, 'Access for Reader').props.onChange('editor'); form = h.renderForm();
  assert.equal(button(form, 'Apply').props.disabled, false);
  button(form, 'Apply').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'decide_edit_request', value: {request_ref: REQUEST, decision: 'approve'}});
  button(form, 'Decline').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'decide_edit_request', value: {request_ref: REQUEST, decision: 'decline'}});
});

test('revision conflicts disable every owner access write and stale callbacks recheck current authority', async t => {
  const h = fixture(t, {grantsReply: grants({revision: '8'})});
  const form = await h.open();
  assert.match(textContent(form), /changed. Refresh it/);
  for (const label of ['Remove editor', 'Add editor', 'Apply', 'Decline', 'Save visibility']) {
    const control = button(form, label); assert.equal(control.props.disabled, true, label); control.props.onClick();
  }
  assert.equal(h.calls.writes.length, 0);
  const fresh = fixture(t); const original = await fresh.open();
  fresh.replace({detail: {status: 'ready', data: top({can_share: false})}});
  button(original, 'Remove editor').props.onClick(); button(original, 'Add editor').props.onClick();
  assert.equal(fresh.calls.writes.length, 0, 'retained rendered controls are never authority');
});

test('grant, pending-request and candidate directories page independently; query changes abort and retire old candidate pages', async t => {
  const late = deferred();
  const h = fixture(t, {sharingReply: sharing({next_pending_cursor: 'request-page-2'}), grantsReply: grants({next_cursor: 'grant-page-2'}),
    candidatesReply: options => options.q === 'slow' ? late.promise : envelope(candidates({next_cursor: 'candidate-page-2'}))});
  let form = await h.open();
  for (const [label, owner, cursor] of [['More edit requests', 'sharing', 'request-page-2'], ['More editors', 'grants', 'grant-page-2'],
    ['More library members', 'candidates', 'candidate-page-2']]) {
    button(form, label).props.onClick(); h.renderShare(); await settle(); form = h.renderForm();
    assert.equal(h.calls[owner].at(-1).cursor, cursor);
    assert.equal(button(form, label).props.disabled, true, 'a repeated cursor cannot loop');
  }
  let search = component(form, 'CreationSearch'); search.props.onChange('slow'); h.renderShare();
  const slow = h.calls.candidates.at(-1); assert.equal(slow.cursor, null);
  form = h.renderForm(); component(form, 'CreationSearch').props.onChange('new'); h.renderShare(); await settle();
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
  const form = await h.open();
  for (const label of ['Add editor', 'Editor']) {const control = button(form, label); assert.equal(control.props.disabled, true); control.props.onClick();}
  assert.equal(h.calls.writes.length, 0);
});

test('native Share Close and unmount abort current reads and never allow late callbacks or private repaint', async t => {
  const delayed = deferred();
  const h = fixture(t, {candidatesReply: () => delayed.promise});
  const form = await h.open(), candidateRead = h.calls.candidates.at(-1);
  assert.equal(await button(form, 'Close').props.onClick(), true);
  assert.equal(component(h.renderView(), 'ShareAlbumTop'), undefined);
  // The real parent omits the subtree; dispose the matching hook owners here.
  h.driver.dispose('dialog'); h.driver.dispose('share');
  assert.equal(candidateRead.signal.aborted, true);
  delayed.resolve(envelope(candidates())); await settle();
  assert.equal(h.driver.lateUpdates(), 0);
  assert.ok(h.calls.closes.some(value => value.force && value.restoreFocus === false && value.returnToParent === false));
});

test('Editor keeps approved metadata editing while owner-only Delete/access stay unavailable', async t => {
  const h = fixture(t, {actions: {can_edit: true, can_rename: true, can_share: false, can_delete: false, can_copy: true},
    sharingReply: sharing({can_manage: false, can_request_edit: false, pending_requests: []})});
  assert.ok(button(h.renderView(), 'Edit Album Top'));
  assert.equal(button(h.renderView(), 'Delete Album Top'), undefined);
  const form = await h.open();
  for (const label of ['Apply', 'Decline', 'Add editor', 'Remove editor', 'Save visibility', 'Request edit access']) assert.equal(button(form, label), undefined);
});

for (const owner of [false, true]) test(`shared Share presentation preserves ${owner ? 'owner' : 'Viewer'} Playlist actions and native lifetime`, async t => {
  const driver = hookDriver('playlists/sharing.jsx'), h = nativeRuntime(), writes = [];
  const detail = {playlist_id: TOP, revision: '7', title: 'Existing Playlist', description: '', track_rows: []};
  const state = {scopeKey: SCOPE, selectedPlaylistId: TOP, resource: {status: 'ready', data: {detail}}, drafts: {}, mutation: {status: 'idle'}};
  const value = {playlist_id: TOP, revision: '7', visibility: 'server_shared', can_manage: owner,
    can_request_edit: !owner, request_status: 'none', people: [], pending_requests: owner ? [sharing().pending_requests[0]] : [], next_cursor: null};
  const controller = {getSnapshot: () => state, readSharing: async () => envelope(value), available: () => true,
    mutate(action, data) {writes.push({action, data});}, getLifecycleVersion: () => 1};
  const props = {runtime: h.runtime, controller, state, onClose() {}};
  const render = () => {
    const dialog = driver.render('share', driver.exports.SharePlaylist, props);
    driver.render('dialog', dialog.type, dialog.props);
    return expand(driver.render('dialog', dialog.type, dialog.props).props.children);
  };
  t.after(() => driver.dispose()); render(); await settle(); let form = render();
  assert.equal(h.calls.owners[0].options.title, 'Share playlist');
  assert.equal(h.calls.owners[0].options.showCloseButton, true);
  if (owner) {
    assert.equal(button(form, 'Apply').props.disabled, true);
    button(form, 'Apply').props.onClick(); assert.equal(writes.length, 0);
    choice(form, 'Access for Reader').props.onChange('editor'); form = render();
    button(form, 'Apply').props.onClick();
    assert.deepEqual(plain(writes.pop()), {action: 'decideEditRequest', data: {request_ref: REQUEST, decision: 'approve'}});
    button(form, 'Decline').props.onClick();
    assert.deepEqual(plain(writes.pop()), {action: 'decideEditRequest', data: {request_ref: REQUEST, decision: 'decline'}});
    assert.deepEqual(plain(choice(form, 'Playlist visibility').props.options), [
      ['private', 'Private'], ['server_shared', 'Shared with this server'], ['link', 'Public link unavailable', true],
    ]);
  } else {
    assert.ok(button(form, 'Request edit access'));
    button(form, 'Request edit access').props.onClick();
    assert.deepEqual(plain(writes), [{action: 'requestEditAccess'}]);
    assert.equal(button(form, 'Apply'), undefined); assert.equal(button(form, 'Save visibility'), undefined);
  }
});


test('native Share and Copy controls render accessible visible-disabled button semantics during uncertain writes', () => {
  const {AlbumTopsView} = componentExports('album-tops/app.jsx'), h = nativeRuntime();
  const detail = top({can_copy: true, can_share: true});
  const state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [detail]}},
    detail: {status: 'ready', data: detail}, mutation: {status: 'uncertain', action: 'copy'}};
  const controller = {getSnapshot: () => state, canRetryMutation: () => false};
  const host = h.native.document.createElement('div');
  host.innerHTML = renderToStaticMarkup(React.createElement(AlbumTopsView, {runtime: h.runtime, controller, state}));
  for (const label of ['Share', 'Save a copy']) {
    const control = host.querySelector(`button[aria-label="${label}"]`);
    assert.ok(control); assert.equal(control.disabled, true); assert.equal(control.getAttribute('aria-disabled'), 'true');
    assert.equal(control.classList.contains('action-button'), true);
  }
  assert.equal(host.querySelector('button[aria-label="Request edit access"]'), null);
});

test('known-denied uncertain access write can leave the actual native form without losing or replaying its original operation', async t => {
  const {createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs');
  const {createNotificationDrawerHarness} = require('./runtime/notification-drawer-harness.cjs');
  const driver = hookDriver('album-tops/app.jsx'), h = nativeRuntime(), native = createNotificationDrawerHarness(), writes = [];
  const markup = native.document.createElement('div');
  markup.innerHTML = '<div id="app-shell" data-native-account-id="41" data-native-library-id="73"></div>'
    + '<div id="app-form-modal" hidden><div class="confirm-modal-dialog"><h2 id="app-form-title"></h2>'
    + '<button id="app-form-close" aria-label="Close"></button><div id="app-form-content"></div><p id="app-form-error"></p>'
    + '<div class="confirm-modal-actions"><button id="app-form-cancel"></button><button id="app-form-submit"></button></div></div></div>';
  native.document.body.appendChild(markup); native.loadForm();
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
  t.after(() => {driver.dispose(); controller.dispose();});
  let owner;
  h.runtime.openForm = options => {owner = native.context.openReactFormDialog(options); return owner;};
  const view = () => driver.render('view', driver.exports.AlbumTopsView, {runtime: h.runtime, controller,
    state: controller.getSnapshot(), onOpen: ref => controller.open(ref)});
  const share = () => {
    const node = component(view(), 'ShareAlbumTop'); assert.ok(node);
    return driver.render('share', node.type, node.props);
  };
  const form = () => {
    const dialog = share(); driver.render('dialog', dialog.type, dialog.props);
    return expand(driver.render('dialog', dialog.type, dialog.props).props.children);
  };
  button(view(), 'Share').props.onClick(); share(); await settle(); share(); await settle();
  let fields = form(); choice(fields, 'Album Top visibility').props.onChange('private'); fields = form();
  await button(fields, 'Save visibility').props.onClick(); form();
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
  assert.equal(button(fields, 'Close').props.disabled, false);
  assert.equal(native.document.getElementById('app-form-close').disabled, false);
  assert.equal(await controller.retryMutation(), false); assert.equal(writes.length, 1);
  assert.equal(await owner.dismiss('back'), true, 'the actual native owner permits leaving once exact recovery is denied');
  await owner.promise;
  assert.equal(native.document.getElementById('app-form-modal').hidden, true);
  assert.equal(component(view(), 'ShareAlbumTop'), undefined);
  driver.dispose('dialog'); driver.dispose('share');
  assert.deepEqual(plain(controller.getSnapshot().mutation.command), original);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(controller.canRetryMutation(), false);
  await button(view(), 'Back').props.onClick();
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
    t.after(() => controller.dispose());
    const h = fixture(t, {controller});
    const oldCopy = button(h.renderView(), 'Save a copy'); let fields = await h.open();
    const retained = action === 'copy' ? oldCopy : action === 'visibility' ? button(fields, 'Add editor') : button(fields, 'Request edit access');
    assert.ok(retained);
    allowed = false; await controller.readSharing({});
    h.renderShare(); await settle(); h.renderShare(); await settle(); fields = h.renderForm();
    retained.props.onClick(); await settle();
    assert.equal(writes.length, 0);
    if (action === 'copy') assert.equal(button(h.renderView(), 'Save a copy'), undefined);
    if (action === 'visibility') {
      assert.equal(button(fields, 'Add editor'), undefined); assert.equal(button(fields, 'Remove editor'), undefined);
      assert.equal(button(fields, 'Save visibility'), undefined);
    }
    if (action === 'request_edit') {
      const request = button(fields, 'Request edit access');
      assert.equal(!request || request.props.disabled === true, true, 'fresh request denial hides or disables the read-only Share action');
    }
    assert.ok(button(h.renderView(), 'Share'), 'read-only Share remains available after action denial');
  });
}
