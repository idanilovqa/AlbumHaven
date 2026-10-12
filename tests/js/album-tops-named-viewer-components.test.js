const test = require('node:test');
const assert = require('node:assert/strict');
const {React, elements, component, button, plain, deferred, settle, hookDriver, nativeRuntime} = require('./runtime/album-tops-sharing-harness.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), GRANT = id(3), REQUEST = id(4), ACCOUNT = id(5), SCOPE = 'share-ui:actor:library';
const BROWSE = 'library.browse.read';
const top = (actions = {}, patch = {}) => ({top_ref: TOP, title: 'Shared Top', description: 'Subtitle', revision: '7',
  visibility: 'server_shared', items: [], allowed_actions: {[BROWSE]: true, can_read: true, can_view_sharing: true, ...actions}, ...patch});
const sharing = patch => ({top_ref: TOP, revision: '7', visibility: 'server_shared', can_manage: true,
  can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: [{request_ref: REQUEST,
    top_ref: TOP, title: 'Shared Top', account_ref: ACCOUNT, display_name: 'Reader', username_display: 'reader'}], next_pending_cursor: null, ...patch});
const grants = patch => ({top_ref: TOP, revision: '7', visibility: 'server_shared', grants: [{account_id: 41, account_ref: ACCOUNT,
  grant_ref: GRANT, role: 'editor', display_name: 'Inactive editor', username_display: 'editor', is_active: false}], next_cursor: null, ...patch});
const candidates = patch => ({top_ref: TOP, revision: '7', candidates: [{account_ref: id(6), account_id: 42,
  display_name: 'Candidate', username_display: 'candidate', grant_ref: null, role: null, allowed_actions: {can_grant_editor: true, can_grant_viewer: true}}], next_cursor: null, ...patch});
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

function fixture(t, {actions = {can_share: true, can_copy: true}, sharingReply = sharing(), grantsReply = grants(), candidatesReply = candidates()} = {}) {
  const driver = hookDriver('album-tops/app.jsx'), native = nativeRuntime(), calls = {...native.calls, writes: [], sharing: [], grants: [], candidates: [], opens: []};
  let state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [top()], allowed_actions: {[BROWSE]: true}}},
    detail: {status: 'ready', data: top(actions)}, mutation: {status: 'idle'}};
  const read = (name, value) => async options => {calls[name].push(options); return typeof value === 'function' ? value(options) : envelope(value);};
  const controller = {getSnapshot: () => state, readSharing: read('sharing', sharingReply), readAccessGrants: read('grants', grantsReply),
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


const emptyGrants = () => grants({grants: []});
const emptyCandidates = () => candidates({candidates: []});
const roleOptions = [['viewer', 'Viewer'], ['editor', 'Editor']];

test('owner selects Viewer or Editor with native Choice and explicitly adds the selected role', async t => {
  const h = fixture(t, {grantsReply: emptyGrants()});
  let form = await h.open();
  assert.deepEqual(plain(choice(form, 'Access for Candidate').props.options), roleOptions);
  assert.equal(choice(form, 'Access for Candidate').props.value, 'viewer');
  assert.equal(button(form, 'Add access').props.disabled, false);
  assert.equal(h.calls.writes.length, 0);
  button(form, 'Add access').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_viewer', value: {account_id: 42, role: 'viewer'}});
  choice(form, 'Access for Candidate').props.onChange('editor'); form = h.renderForm();
  assert.equal(h.calls.writes.length, 0, 'selection is a draft until Add');
  button(form, 'Add access').props.onClick();
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_editor', value: {account_id: 42, role: 'editor'}});
});

for (const currentRole of ['viewer', 'editor']) test(`owner grant shows actual ${currentRole} and applies a role switch without revoke or duplicate add`, async t => {
  const person = {...grants().grants[0], role: currentRole, display_name: 'Existing member', is_active: true};
  const h = fixture(t, {grantsReply: grants({grants: [person]}), candidatesReply: emptyCandidates()});
  let form = await h.open();
  assert.equal(choice(form, 'Access for Existing member').props.value, currentRole);
  assert.equal(button(form, 'Apply access').props.disabled, true);
  button(form, 'Apply access').props.onClick(); assert.equal(h.calls.writes.length, 0);
  const nextRole = currentRole === 'editor' ? 'viewer' : 'editor';
  choice(form, 'Access for Existing member').props.onChange(nextRole); form = h.renderForm();
  assert.equal(h.calls.writes.length, 0);
  assert.equal(button(form, 'Apply access').props.disabled, false);
  button(form, 'Apply access').props.onClick();
  assert.deepEqual(plain(h.calls.writes), [{action: `grant_${nextRole}`, value: {account_id: 41, role: nextRole}}]);
  button(form, 'Remove access').props.onClick();
  assert.deepEqual(plain(h.calls.writes.at(-1)), {action: 'revoke_editor', value: {grant_ref: GRANT}});
});

for (const currentRole of ['viewer', 'editor']) test(`candidate with ${currentRole} grant initializes actual role and respects independent destination-role permission`, async t => {
  const nextRole = currentRole === 'editor' ? 'viewer' : 'editor';
  const person = {...candidates().candidates[0], role: currentRole, grant_ref: GRANT,
    allowed_actions: {can_grant_viewer: currentRole !== 'viewer', can_grant_editor: currentRole !== 'editor'}};
  const h = fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [person]})});
  let form = await h.open();
  assert.equal(choice(form, 'Access for Candidate').props.value, currentRole);
  assert.equal(button(form, 'Apply access').props.disabled, true);
  choice(form, 'Access for Candidate').props.onChange(nextRole); form = h.renderForm();
  assert.equal(button(form, 'Apply access').props.disabled, false);
  button(form, 'Apply access').props.onClick();
  assert.deepEqual(plain(h.calls.writes), [{action: `grant_${nextRole}`, value: {account_id: 42, role: nextRole}}]);
});

test('a candidate cannot use Editor eligibility to obtain Viewer access or dispatch from disabled controls', async t => {
  const person = {...candidates().candidates[0], allowed_actions: {can_grant_viewer: false, can_grant_editor: true}};
  const h = fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [person]})});
  let form = await h.open();
  assert.equal(button(form, 'Add access').props.disabled, true);
  button(form, 'Add access').props.onClick(); assert.equal(h.calls.writes.length, 0);
  choice(form, 'Access for Candidate').props.onChange('editor'); form = h.renderForm();
  assert.equal(button(form, 'Add access').props.disabled, false);
  button(form, 'Add access').props.onClick(); assert.equal(h.calls.writes[0].action, 'grant_editor');
});

for (const invalidation of ['busy', 'refreshing', 'authority', 'scope', 'detail']) test(`retained named role controls cannot write after ${invalidation}`, async t => {
  const h = fixture(t, {grantsReply: emptyGrants()});
  const form = await h.open(), select = choice(form, 'Access for Candidate'), add = button(form, 'Add access');
  if (invalidation === 'busy') h.replace({mutation: {status: 'loading'}});
  if (invalidation === 'refreshing') h.replace({mutation: {status: 'ready', refreshing: true}});
  if (invalidation === 'authority') h.replace({detail: {...h.state().detail, sharing_actions: {can_share: false}}});
  if (invalidation === 'scope') h.replace({scopeKey: 'replacement:actor:library'});
  if (invalidation === 'detail') h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision: '8'})}});
  select.props.onChange('editor'); add.props.onClick();
  assert.equal(h.calls.writes.length, 0);
});

test('revision conflict disables named grant selection and dispatch', async t => {
  const h = fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({revision: '8'})});
  const form = await h.open();
  assert.equal(choice(form, 'Access for Candidate').props.disabled, true);
  assert.equal(button(form, 'Add access').props.disabled, true);
  choice(form, 'Access for Candidate').props.onChange('editor'); button(form, 'Add access').props.onClick();
  assert.equal(h.calls.writes.length, 0);
});

test('late pre-downgrade candidate reply cannot restore Editor role after new detail revision', async t => {
  const old = deferred(); let phase = 'old';
  const h = fixture(t, {grantsReply: () => envelope(grants({revision: phase === 'old' ? '7' : '8', grants: []})), candidatesReply: () => phase === 'old' ? old.promise : envelope(candidates({revision: '8', candidates: [
    {...candidates().candidates[0], grant_ref: GRANT, role: 'viewer', allowed_actions: {can_grant_viewer: false, can_grant_editor: true}},
  ]})), sharingReply: () => envelope(sharing({revision: phase === 'old' ? '7' : '8'}))});
  await h.open(); const original = h.calls.candidates.at(-1);
  phase = 'new'; h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision: '8'})}});
  h.renderShare(); await settle(); h.renderShare(); await settle();
  old.resolve(envelope(candidates({candidates: [{...candidates().candidates[0], grant_ref: GRANT, role: 'editor'}]})));
  await settle();
  assert.equal(original.signal.aborted, true);
  const form = h.renderForm();
  assert.equal(choice(form, 'Access for Candidate').props.value, 'viewer');
  assert.equal(button(form, 'Apply access').props.disabled, true);
  assert.equal(h.calls.writes.length, 0);
});

test('role draft is scoped to the exact Top detail and cannot carry Editor selection into a refreshed Viewer grant', async t => {
  let revision = '7';
  const h = fixture(t, {grantsReply: () => envelope(grants({revision, grants: []})),
    sharingReply: () => envelope(sharing({revision})),
    candidatesReply: () => envelope(candidates({revision, candidates: [{...candidates().candidates[0], role: 'viewer', grant_ref: GRANT,
      allowed_actions: {can_grant_viewer: false, can_grant_editor: true}}]}))});
  let form = await h.open(); choice(form, 'Access for Candidate').props.onChange('editor'); form = h.renderForm();
  const retained = button(form, 'Apply access'); assert.equal(retained.props.disabled, false);
  revision = '8'; h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision})}});
  h.renderShare(); await settle(); h.renderShare(); await settle(); form = h.renderForm();
  assert.equal(choice(form, 'Access for Candidate').props.value, 'viewer');
  retained.props.onClick(); assert.equal(h.calls.writes.length, 0);
});

test('private named Viewer retains native Share, request and copy while source editing and playback stay absent', async t => {
  const h = fixture(t, {actions: {can_read: true, can_view_sharing: true, can_request_edit: true, can_copy: true,
    can_share: false, can_edit: false, can_delete: false, can_manage_own_progress: true},
    sharingReply: sharing({visibility: 'private', can_manage: false, can_request_edit: true, pending_requests: []})});
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, visibility: 'private'}}});
  const header = h.renderView();
  assert.ok(button(header, 'Share')); assert.ok(button(header, 'Save a copy'));
  for (const label of ['Edit Album Top', 'Delete Album Top', 'Play', 'Add albums']) assert.equal(button(header, label), undefined);
  button(header, 'Save a copy').props.onClick(); assert.deepEqual(plain(h.calls.writes.pop()), {action: 'copy'});
  const form = await h.open();
  assert.match(textContent(form), /Shared with you/);
  assert.ok(button(form, 'Request edit access'));
  assert.equal(choice(form, 'Album Top visibility'), undefined);
  for (const label of ['Add access', 'Apply access', 'Remove access', 'Save visibility']) assert.equal(button(form, label), undefined);
  assert.deepEqual([h.calls.grants.length, h.calls.candidates.length], [0, 0]);
  button(form, 'Request edit access').props.onClick(); assert.deepEqual(plain(h.calls.writes.pop()), {action: 'request_edit'});
});

test('private Viewer completion uses own progress action without source or playback controls', t => {
  const h = fixture(t, {actions: {can_manage_own_progress: true, can_copy: true, can_share: false, can_edit: false}});
  const album = id(70), item = id(71), cards = [];
  h.runtime.galleryCardHtml = config => {cards.push(config); return '<div>Album card</div>';};
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, visibility: 'private',
    items: [{item_ref: item, album_ref: album, title: 'Own-progress album', artist: 'Artist'}],
    top_viewer_overlay: {item_progress: {[album]: {progress_revision: '0', manual_completed_at: null}}}}}});
  const tree = h.renderView(), card = elements(tree).find(node => node.type?.name === 'NativeHtml' && node.props.preserveFocus);
  assert.ok(card);
  assert.deepEqual(plain(cards[0].actions), {open: false, complete: true});
  assert.equal(cards[0].completion.completed, false);
  const target = {disabled: false, getAttribute: name => name === 'data-gallery-card-ref' ? album : null};
  const event = {target: {closest: selector => selector === '[data-gallery-card-intent="complete"]' ? target : null}, preventDefault() {}, stopPropagation() {}};
  card.props.onClick(event);
  assert.deepEqual(plain(h.calls.writes), [{action: 'set_manual_completion', value: {album_ref: album, completed: true}}]);
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, allowed_actions: {...h.state().detail.data.allowed_actions, can_manage_own_progress: false}}}});
  card.props.onClick(event); assert.equal(h.calls.writes.length, 1);
});

test('role drafts do not cross recipient identity', async t => {
  const first = candidates().candidates[0], second = {...first, account_ref: id(80), account_id: 80, display_name: 'Second member'};
  const h = fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [first, second]})});
  let form = await h.open();
  choice(form, 'Access for Candidate').props.onChange('editor'); form = h.renderForm();
  assert.equal(choice(form, 'Access for Candidate').props.value, 'editor');
  assert.equal(choice(form, 'Access for Second member').props.value, 'viewer');
  assert.equal(h.calls.writes.length, 0);
});
