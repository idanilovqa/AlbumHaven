const test = require('node:test');
const assert = require('node:assert/strict');
const {load, deferred} = require('./runtime/album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./runtime/album-tops-native-fixtures/actual-choice-runtime.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const textContent = node => node.textContent;
const button = (root, label) => root.querySelectorAll('button').find(node =>
  !node.closest('[hidden]') && (node.getAttribute('aria-label') || node.textContent.trim()) === label);
const choice = (root, label) => root.querySelectorAll('button[aria-haspopup="menu"]').find(node =>
  !node.closest('[hidden]') && node.getAttribute('aria-label')?.startsWith(`${label}: `));
const selectedRole = trigger => ({Viewer: 'viewer', Editor: 'editor'})[trigger.getAttribute('aria-label').split(': ').at(-1)];
// Deliver hostile/retained activation to actual owners even when disabled.
// The ordinary fixture click models browser suppression and cannot test this.
function adversarialClick(h, target) {
  assert.ok(target instanceof h.context.Element, 'adversarial activation targets actual DOM');
  target.dispatchEvent(new h.context.Event('click', {bubbles: true}));
}
function choose(h, trigger, value, adversarial = false) {
  const activate = target => adversarial ? adversarialClick(h, target) : h.click(target);
  assert.ok(trigger, 'native choice trigger exists');
  activate(trigger);
  const menu = h.document.querySelector('[role="menu"]');
  if (trigger.disabled) {assert.ok(!menu || menu.hidden, 'disabled native Choice cannot open'); return;}
  assert.ok(menu, 'canonical native Choice menu is mounted');
  const option = menu.querySelector(`[data-foobar-format="${value}"]`);
  assert.ok(option, `native menu option ${value}`); activate(option);
}
function roleMenuOptions(h, trigger) {
  h.click(trigger);
  const menu = h.document.querySelector('[role="menu"]'); assert.ok(menu);
  const options = menu.querySelectorAll('[data-foobar-format]').map(node =>
    [node.getAttribute('data-foobar-format'), node.textContent.trim()]);
  h.click(menu.querySelector('[data-foobar-format="viewer"]'));
  return options;
}
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
async function fixture(t, {actions = {can_share: true, can_copy: true}, sharingReply = sharing(), grantsReply = grants(), candidatesReply = candidates()} = {}) {
  const native = actualChoiceEnvironment(), calls = {writes: [], sharing: [], grants: [], candidates: [], opens: []};
  let state = {scopeKey: SCOPE, selectedTopRef: TOP, directory: {status: 'ready', data: {tops: [top()], allowed_actions: {[BROWSE]: true}}},
    detail: {status: 'ready', data: top(actions)}, mutation: {status: 'idle'}};
  const read = (name, value) => async options => {calls[name].push(options); return typeof value === 'function' ? value(options) : envelope(value);};
  // Preserve the original authored controller boundary. The presentation and all
  // native form/menu/control owners below are actual delivered implementations.
  const listeners = new Set();
  const controller = {getSnapshot: () => state,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, readSharing: read('sharing', sharingReply), readAccessGrants: read('grants', grantsReply),
    readAccessCandidates: read('candidates', candidatesReply), canRetryMutation: () => false, retryMutation: async () => false,
    mutate(action, value) {calls.writes.push({action, value}); return Promise.resolve(true);}, open(ref) {calls.opens.push(ref);}};
  const props = () => ({controller, state: controller.getSnapshot(), onOpen: ref => calls.opens.push(ref)});
  const nativeSnapshot = native.runtime.snapshot;
  // This shell owns this scope and Top; later controller invalidation must not
  // silently authenticate a replacement scope in the native owner.
  native.runtime.snapshot = () => ({...nativeSnapshot(), scopeKey: SCOPE, topRef: TOP});
  const {mountAlbumTopsView} = await load('album-tops/app.mjs');
  const owner = mountAlbumTopsView(native.host, native.runtime, props());
  const renderView = () => {owner.update(props()); return native.host;};
  const renderShare = () => {renderView(); assert.equal(native.modal().hidden, false, 'current header action owns native Share'); return native.content();};
  const renderForm = () => {const form = renderShare(); assert.equal(native.opens.at(-1).title, 'Share Album Top'); return form;};
  const open = async () => {
    native.click(button(renderView(), 'Share')); renderShare(); await settle(); renderShare(); await settle(); return renderForm();
  };
  t.after(async () => {owner.dispose(); assert.equal(listeners.size, 0, 'all controller subscriptions retired'); await settle(); native.assertClean();});
  return {...native, calls, controller, props, renderView, renderShare, renderForm, open,
    replace(patch) {state = {...state, ...patch}; for (const listener of [...listeners]) listener();}, state: () => state};
}

const emptyGrants = () => grants({grants: []});
const emptyCandidates = () => candidates({candidates: []});
const roleOptions = [['viewer', 'Viewer'], ['editor', 'Editor']];

test('owner selects Viewer or Editor with native Choice and explicitly adds the selected role', async t => {
  const h = await fixture(t, {grantsReply: emptyGrants()});
  let form = await h.open();
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), 'viewer', 'initial role before any menu selection');
  assert.deepEqual(plain(roleMenuOptions(h, choice(form, 'Access for Candidate'))), roleOptions);
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), 'viewer');
  assert.equal(button(form, 'Add access').disabled, false);
  assert.equal(h.calls.writes.length, 0);
  h.click(button(form, 'Add access'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_viewer', value: {account_id: 42, role: 'viewer'}});
  choose(h, choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  assert.equal(h.calls.writes.length, 0, 'selection is a draft until Add');
  h.click(button(form, 'Add access'));
  assert.deepEqual(plain(h.calls.writes.pop()), {action: 'grant_editor', value: {account_id: 42, role: 'editor'}});
});

for (const currentRole of ['viewer', 'editor']) test(`owner grant shows actual ${currentRole} and applies a role switch without revoke or duplicate add`, async t => {
  const person = {...grants().grants[0], role: currentRole, display_name: 'Existing member', is_active: true};
  const h = await fixture(t, {grantsReply: grants({grants: [person]}), candidatesReply: emptyCandidates()});
  let form = await h.open();
  assert.equal(selectedRole(choice(form, 'Access for Existing member')), currentRole);
  assert.equal(button(form, 'Apply access').disabled, true);
  adversarialClick(h, button(form, 'Apply access')); assert.equal(h.calls.writes.length, 0);
  const nextRole = currentRole === 'editor' ? 'viewer' : 'editor';
  choose(h, choice(form, 'Access for Existing member'), nextRole); form = h.renderForm();
  assert.equal(h.calls.writes.length, 0);
  assert.equal(button(form, 'Apply access').disabled, false);
  h.click(button(form, 'Apply access'));
  assert.deepEqual(plain(h.calls.writes), [{action: `grant_${nextRole}`, value: {account_id: 41, role: nextRole}}]);
  h.click(button(form, 'Remove access'));
  assert.deepEqual(plain(h.calls.writes.at(-1)), {action: 'revoke_editor', value: {grant_ref: GRANT}});
});

for (const currentRole of ['viewer', 'editor']) test(`candidate with ${currentRole} grant initializes actual role and respects independent destination-role permission`, async t => {
  const nextRole = currentRole === 'editor' ? 'viewer' : 'editor';
  const person = {...candidates().candidates[0], role: currentRole, grant_ref: GRANT,
    allowed_actions: {can_grant_viewer: currentRole !== 'viewer', can_grant_editor: currentRole !== 'editor'}};
  const h = await fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [person]})});
  let form = await h.open();
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), currentRole);
  assert.equal(button(form, 'Apply access').disabled, true);
  choose(h, choice(form, 'Access for Candidate'), nextRole); form = h.renderForm();
  assert.equal(button(form, 'Apply access').disabled, false);
  h.click(button(form, 'Apply access'));
  assert.deepEqual(plain(h.calls.writes), [{action: `grant_${nextRole}`, value: {account_id: 42, role: nextRole}}]);
});

test('a candidate cannot use Editor eligibility to obtain Viewer access or dispatch from disabled controls', async t => {
  const person = {...candidates().candidates[0], allowed_actions: {can_grant_viewer: false, can_grant_editor: true}};
  const h = await fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [person]})});
  let form = await h.open();
  assert.equal(button(form, 'Add access').disabled, true);
  adversarialClick(h, button(form, 'Add access')); assert.equal(h.calls.writes.length, 0);
  choose(h, choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  assert.equal(button(form, 'Add access').disabled, false);
  h.click(button(form, 'Add access')); assert.equal(h.calls.writes[0].action, 'grant_editor');
});

for (const invalidation of ['busy', 'refreshing', 'authority', 'scope', 'detail']) test(`retained named role controls cannot write after ${invalidation}`, async t => {
  const h = await fixture(t, {grantsReply: emptyGrants()});
  const form = await h.open(), select = choice(form, 'Access for Candidate'), add = button(form, 'Add access');
  if (invalidation === 'busy') h.replace({mutation: {status: 'loading'}});
  if (invalidation === 'refreshing') h.replace({mutation: {status: 'ready', refreshing: true}});
  if (invalidation === 'authority') h.replace({detail: {...h.state().detail, sharing_actions: {can_share: false}}});
  if (invalidation === 'scope') h.replace({scopeKey: 'replacement:actor:library'});
  if (invalidation === 'detail') h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision: '8'})}});
  choose(h, select, 'editor', true); adversarialClick(h, add);
  assert.equal(h.calls.writes.length, 0);
});

test('revision conflict disables named grant selection and dispatch', async t => {
  const h = await fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({revision: '8'})});
  const form = await h.open();
  assert.equal(choice(form, 'Access for Candidate').disabled, true);
  assert.equal(button(form, 'Add access').disabled, true);
  choose(h, choice(form, 'Access for Candidate'), 'editor', true); adversarialClick(h, button(form, 'Add access'));
  assert.equal(h.calls.writes.length, 0);
});

test('late pre-downgrade candidate reply cannot restore Editor role after new detail revision', async t => {
  const old = deferred(); let phase = 'old';
  const h = await fixture(t, {grantsReply: () => envelope(grants({revision: phase === 'old' ? '7' : '8', grants: []})), candidatesReply: () => phase === 'old' ? old.promise : envelope(candidates({revision: '8', candidates: [
    {...candidates().candidates[0], grant_ref: GRANT, role: 'viewer', allowed_actions: {can_grant_viewer: false, can_grant_editor: true}},
  ]})), sharingReply: () => envelope(sharing({revision: phase === 'old' ? '7' : '8'}))});
  await h.open(); const original = h.calls.candidates.at(-1);
  phase = 'new'; h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision: '8'})}});
  h.renderShare(); await settle(); h.renderShare(); await settle();
  old.resolve(envelope(candidates({candidates: [{...candidates().candidates[0], grant_ref: GRANT, role: 'editor'}]})));
  await settle();
  assert.equal(original.signal.aborted, true);
  const form = h.renderForm();
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), 'viewer');
  assert.equal(button(form, 'Apply access').disabled, true);
  assert.equal(h.calls.writes.length, 0);
});

test('role draft is scoped to the exact Top detail and cannot carry Editor selection into a refreshed Viewer grant', async t => {
  let revision = '7';
  const h = await fixture(t, {grantsReply: () => envelope(grants({revision, grants: []})),
    sharingReply: () => envelope(sharing({revision})),
    candidatesReply: () => envelope(candidates({revision, candidates: [{...candidates().candidates[0], role: 'viewer', grant_ref: GRANT,
      allowed_actions: {can_grant_viewer: false, can_grant_editor: true}}]}))});
  let form = await h.open(); choose(h, choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  const retained = button(form, 'Apply access'); assert.equal(retained.disabled, false);
  revision = '8'; h.replace({detail: {status: 'ready', data: top({can_share: true}, {revision})}});
  h.renderShare(); await settle(); h.renderShare(); await settle(); form = h.renderForm();
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), 'viewer');
  adversarialClick(h, retained); assert.equal(h.calls.writes.length, 0);
});

test('private named Viewer retains native Share, request and copy while source editing and playback stay absent', async t => {
  const h = await fixture(t, {actions: {can_read: true, can_view_sharing: true, can_request_edit: true, can_copy: true,
    can_share: false, can_edit: false, can_delete: false, can_manage_own_progress: true},
    sharingReply: sharing({visibility: 'private', can_manage: false, can_request_edit: true, pending_requests: []})});
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, visibility: 'private'}}});
  const header = h.renderView();
  assert.ok(button(header, 'Share')); assert.ok(button(header, 'Save a copy'));
  for (const label of ['Edit Album Top', 'Delete Album Top', 'Play', 'Add albums']) assert.equal(button(header, label), undefined);
  h.click(button(header, 'Save a copy')); assert.deepEqual(plain(h.calls.writes.pop()), {action: 'copy'});
  const form = await h.open();
  assert.match(textContent(form), /Shared with you/);
  assert.ok(button(form, 'Request edit access'));
  assert.equal(choice(form, 'Album Top visibility'), undefined);
  for (const label of ['Add access', 'Apply access', 'Remove access', 'Save visibility']) assert.equal(button(form, label), undefined);
  assert.deepEqual([h.calls.grants.length, h.calls.candidates.length], [0, 0]);
  h.click(button(form, 'Request edit access')); assert.deepEqual(plain(h.calls.writes.pop()), {action: 'request_edit'});
});

test('private Viewer completion uses own progress action without source or playback controls', async t => {
  const h = await fixture(t, {actions: {can_manage_own_progress: true, can_copy: true, can_share: false, can_edit: false}});
  const album = id(70), item = id(71), cards = [];
  const galleryCardHtml = h.runtime.galleryCardHtml;
  h.runtime.galleryCardHtml = config => {cards.push(config); return galleryCardHtml(config);};
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, visibility: 'private',
    items: [{item_ref: item, album_ref: album, title: 'Own-progress album', artist: 'Artist'}],
    top_viewer_overlay: {item_progress: {[album]: {progress_revision: '0', manual_completed_at: null}}}}}});
  const tree = h.renderView();
  let card = tree.querySelector('[data-gallery-card-intent="complete"]');
  assert.ok(card);
  assert.deepEqual(plain(cards[0].actions), {open: false, complete: true});
  assert.equal(cards[0].completion.completed, false);
  h.click(card);
  assert.equal(h.document.getElementById('app-confirm-modal').hidden, false);
  assert.deepEqual(h.calls.writes, [], 'opening confirmation is not a progress write');
  h.click(h.document.getElementById('app-confirm-cancel')); await settle();
  assert.deepEqual(h.calls.writes, [], 'declined confirmation cannot change progress');
  card = tree.querySelector('[data-gallery-card-intent="complete"]'); h.click(card);
  assert.equal(h.document.getElementById('app-confirm-modal').hidden, false);
  assert.deepEqual(h.calls.writes, []);
  h.click(h.document.getElementById('app-confirm-accept')); await settle();
  assert.deepEqual(plain(h.calls.writes), [{action: 'set_manual_completion', value: {album_ref: album, completed: true}}]);
  card = tree.querySelector('[data-gallery-card-intent="complete"]');
  h.replace({detail: {...h.state().detail, data: {...h.state().detail.data, allowed_actions: {...h.state().detail.data.allowed_actions, can_manage_own_progress: false}}}});
  adversarialClick(h, card); assert.equal(h.calls.writes.length, 1);
});

test('role drafts do not cross recipient identity', async t => {
  const first = candidates().candidates[0], second = {...first, account_ref: id(80), account_id: 80, display_name: 'Second member'};
  const h = await fixture(t, {grantsReply: emptyGrants(), candidatesReply: candidates({candidates: [first, second]})});
  let form = await h.open();
  choose(h, choice(form, 'Access for Candidate'), 'editor'); form = h.renderForm();
  assert.equal(selectedRole(choice(form, 'Access for Candidate')), 'editor');
  assert.equal(selectedRole(choice(form, 'Access for Second member')), 'viewer');
  assert.equal(h.calls.writes.length, 0);
});
