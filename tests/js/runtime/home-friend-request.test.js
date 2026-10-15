const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {environment, load, settle, visibleHtml} = require('./home-profile-native-observations.cjs');
const repo = path.resolve(__dirname, '../../..');
const model = import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
let FriendRequestContent, FriendRequestDialog, MemberProfile, FriendsDirectory, MemberResults, PersonNavigation;
test.before(async () => {
  ({mountFriendRequestContent: FriendRequestContent, mountFriendRequestDialog: FriendRequestDialog} = await load('friend-request.mjs'));
  ({mountMemberProfile: MemberProfile} = await load('member-profile.mjs'));
  ({mountFriendsDirectory: FriendsDirectory, mountMemberResults: MemberResults, mountPersonNavigation: PersonNavigation} = await load('friends-directory.mjs'));
});
const buttonNamed = (root, label, required = true) => {
  const button = root.querySelectorAll('button').find(node => !node.closest('[hidden]') && (node.getAttribute('aria-label') || node.textContent.trim()) === label) || null;
  if (required) assert.ok(button, `Expected native button ${label}`);
  return button;
};
let currentTest;
test.beforeEach(t => {currentTest = t;});
const nativeRuntime = () => environment(currentTest);
const request = (extra = {}) => ({request_ref: 'request:one', account_ref: 'member:one', display_name: 'Taylor <safe>',
  handle: 'taylor', bio: 'Listens together', avatar_url: '/avatars/taylor.webp', direction: 'incoming',
  allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}, ...extra});
const friend = (extra = {}) => ({account_ref: 'member:one', display_name: 'Taylor', handle: 'taylor', relationship: 'accepted',
  allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true, can_remove: true}, ...extra});
const friends = (extra = {}) => ({friends: [], requests: [request()], profile: null, allowed_actions: {can_discover_members: true}, ...extra});
async function setup(providers = {}) {
  const {createHomeFriendsController} = await model;
  const controller = createHomeFriendsController({providers: {readFriends: () => friends(), ...providers}});
  controller.setScope('account/library');
  await controller.loadFriends(); return controller;
}
function deferred() {
  let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};
}
function render(env, mount, props) {
  const host = env.document.createElement('section'); env.document.body.append(host);
  env.own(mount(host, env.runtime, props));
  return {html: visibleHtml(host), raw: host.innerHTML, host};
}
function dialogFixture(controller, options = {}) {
  const env = nativeRuntime(), closes = [], events = []; let pendingClose, ownerProps;
  const openForm = env.runtime.openForm;
  const runtime = {...env.runtime, openForm(props) {
    ownerProps = props;
    return openForm({...props, onMount(host, close) {
      props.onMount(host, (result, options) => {closes.push(options); return close(result, options);});
    }, onClose(host, value) {pendingClose = extra => props.onClose(host, {...value, ...extra});}});
  }};
  const owner = env.own(FriendRequestDialog(env.host, runtime, {controller, requestRef: 'request:one', parentSurface: '#cover-lookup-drawer',
    returnFocus: () => null, onClose: () => events.push('closed'), onProfile: ref => events.push(ref), ...options}));
  // Drive the real mounted buttons; never invoke a copied component callback.
  return {...env, closes, events, get ownerProps() {return ownerProps;},
    render() {
      const buttons = env.form.querySelectorAll('button');
      const activate = label => {const button = buttons.find(node => node.textContent.trim() === label); if (button) env.click(button);};
      return {message: visibleHtml(env.form),
      onAction: async action => {activate({acceptRequest:'Accept request', declineRequest:'Decline', cancelRequest:'Cancel request'}[action]); await settle();},
      onRefresh: async () => {activate('Refresh'); await settle();}, onProfile: () => activate('View profile'), onClose: () => activate('Close')};},
    nativeClosed(options = {}) {const close = pendingClose; pendingClose = null; if (close) close(options);},
    dispose: () => owner.dispose()};
}

test('incoming request uses shared identity and exact current action grants', async () => {
  const c = await setup(), env = nativeRuntime();
  const {html, raw, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one', onProfile() {}});
  assert.match(html, /Taylor &lt;safe&gt;/); assert.match(html, /home-profile__identity/);
  assert.equal(buttonNamed(host, 'Accept request').disabled, false);
  assert.equal(buttonNamed(host, 'Decline').disabled, false);
  assert.equal(buttonNamed(host, 'View profile').disabled, false);
  assert.equal(buttonNamed(host, 'Cancel request', false), null);
  assert.doesNotMatch(html, /Edit profile/); assert.doesNotMatch(raw, /<safe>|localStorage/);
});

test('outgoing request cannot expose incoming actions and unsafe artwork stays empty', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({direction: 'outgoing', avatar_url: 'javascript:alert(1)',
    allowed_actions: {can_cancel: true, can_accept: true, can_decline: true, can_view_profile: false}})]})});
  const env = nativeRuntime(), {html, raw, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one', onProfile() {}});
  assert.match(html, /album-artbox--empty/); assert.doesNotMatch(raw, /javascript:/); assert.doesNotMatch(html, /Accept request|>Decline</);
  assert.equal(buttonNamed(host, 'Cancel request').disabled, false);
  assert.equal(buttonNamed(host, 'View profile').disabled, true);
});

test('request without current change grants explains denial through the native status owner', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({allowed_actions: {can_accept: 'true', can_decline: false}})]})});
  const env = nativeRuntime(), {html, raw, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one'});
  assert.equal(buttonNamed(host, 'Accept request').disabled, true); assert.equal(buttonNamed(host, 'Decline').disabled, true);
  assert.match(host.textContent, /don't have access to Friend request changes/); assert.match(html, /role="status"/);
});

test('fabricated, stale, revoked and loading requests never retain old person facts', async () => {
  const c = await setup(), env = nativeRuntime(), initial = c.getSnapshot();
  for (const status of ['loading', 'error', 'denied', 'unavailable']) {
    const state = {...initial, friends: {status, data: initial.friends.data}};
    const {html, raw} = render(env, FriendRequestContent, {state, requestRef: 'request:one'});
    assert.doesNotMatch(raw, /Taylor|taylor.webp/);
    assert.doesNotMatch(html, /Taylor|taylor.webp|Accept request|View profile/);
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
  }
  const {html, raw} = render(env, FriendRequestContent, {state: initial, requestRef: 'request:invented'});
  assert.doesNotMatch(raw, /Taylor|taylor.webp/);
  assert.match(html, /no longer available/); assert.doesNotMatch(html, /Taylor|Accept request/);
});

test('request callbacks reject wrong direction and grants revoked after rendering', async () => {
  let writes = 0, payload = friends();
  const c = await setup({readFriends: () => payload, acceptRequest: () => {writes++; return {ok: true};}, cancelRequest: () => {writes++; return {ok: true};}});
  const h = dialogFixture(c), content = h.render();
  await content.onAction('cancelRequest'); assert.equal(writes, 0);
  payload = friends({requests: [request({allowed_actions: {can_accept: false}})]}); await c.loadFriends();
  await content.onAction('acceptRequest'); assert.equal(writes, 0); assert.equal(h.closes.length, 0);
  c.setScope('replacement'); await content.onAction('acceptRequest'); assert.equal(writes, 0);
  h.dispose();
});

test('double activation coalesces and closes only after authoritative accepted friendship', async () => {
  const write = deferred(); let writes = 0, payload = friends();
  const c = await setup({readFriends: () => payload, acceptRequest: async () => {writes++; await write.promise; return {ok: true};}});
  const h = dialogFixture(c), content = h.render(), first = content.onAction('acceptRequest');
  await content.onAction('acceptRequest'); assert.equal(writes, 1); assert.equal(h.closes.length, 0);
  payload = friends({friends: [friend()], requests: []}); write.resolve(); await first; await settle();
  assert.equal(h.closes.length, 1); assert.equal(h.closes[0].reason, 'request-resolved');
  h.dispose();
});

test('missing writer remains open and does not announce success', async () => {
  const c = await setup(), h = dialogFixture(c);
  await h.render().onAction('acceptRequest');
  assert.equal(c.getSnapshot().mutation.status, 'unavailable'); assert.equal(h.closes.length, 0);
  const html = visibleHtml(h.form);
  assert.match(html, /not available on this server/); assert.doesNotMatch(h.form.innerHTML, /now friends|sent, but/);
  h.dispose();
});

test('acknowledged write and failed refresh keeps dialog open and retries only the reader', async () => {
  let writes = 0, reads = 0, fail = true;
  const c = await setup({readFriends: () => {if (++reads === 1) return friends(); if (fail) throw new Error('Read failed'); return friends({requests: [], friends: [friend()]});},
    acceptRequest: () => {writes++; return {ok: true};}});
  const h = dialogFixture(c);
  await h.render().onAction('acceptRequest');
  assert.equal(c.getSnapshot().mutation.status, 'ready'); assert.equal(c.getSnapshot().friends.status, 'error');
  assert.equal(h.closes.length, 0); assert.match(h.render().message, /sent, but/);
  await h.render().onAction('acceptRequest'); assert.equal(writes, 1);
  fail = false; await h.render().onRefresh();
  assert.equal(writes, 1); assert.equal(reads, 3); assert.equal(h.closes.length, 1);
  h.dispose();
});

test('acknowledged unresolved request disables another write and makes no friendship claim', async () => {
  let writes = 0;
  const c = await setup({acceptRequest: () => {writes++; return {ok: true};}}), h = dialogFixture(c);
  await h.render().onAction('acceptRequest');
  assert.equal(h.closes.length, 0); assert.match(h.render().message, /not been confirmed/);
  const host = h.form;
  assert.equal(buttonNamed(host, 'Accept request').disabled, true);
  await h.render().onAction('acceptRequest'); assert.equal(writes, 1);
  h.dispose();
});

test('profile navigation waits for native parent close and rechecks source after close', async () => {
  const c = await setup(), h = dialogFixture(c), content = h.render();
  assert.equal(h.ownerProps.parentSurface, '#cover-lookup-drawer');
  assert.equal(h.ownerProps.pageId, undefined, 'request form stays content-sized on phones');
  content.onProfile(); assert.deepEqual(h.events, []);
  assert.equal(h.closes[0].restoreFocus, false); assert.equal(h.closes[0].returnToParent, false);
  h.nativeClosed(); assert.deepEqual(h.events, ['closed', 'member:one']); h.dispose();
  const other = await setup(), revoked = dialogFixture(other, {onClose: () => other.setScope('replacement')});
  revoked.render().onProfile(); revoked.nativeClosed(); assert.deepEqual(revoked.events, []); revoked.dispose();
  const stale = dialogFixture(await setup());
  stale.render().onProfile(); stale.nativeClosed({current: false}); assert.deepEqual(stale.events, ['closed']); stale.dispose();
  let synchronous;
  synchronous = dialogFixture(await setup(), {onClose: () => synchronous.dispose()});
  synchronous.render().onProfile(); synchronous.nativeClosed(); assert.deepEqual(synchronous.events, ['member:one']);
});

test('request profile callback cannot use an absent account or gain friendship by viewing', async () => {
  for (const account_ref of [undefined, null]) {
    const c = await setup({readFriends: () => friends({requests: [request({account_ref})]})}), h = dialogFixture(c);
    h.render().onProfile(); assert.equal(h.closes.length, 0); assert.equal(c.getSnapshot().selectedFriendRef, null); h.dispose();
  }
});

test('closing a pending request keeps its late write completion from closing another form', async () => {
  const write = deferred(); let payload = friends();
  const c = await setup({readFriends: () => payload, acceptRequest: () => write.promise}), h = dialogFixture(c);
  const content = h.render(), operation = content.onAction('acceptRequest');
  content.onClose(); h.nativeClosed();
  payload = friends({friends: [friend()], requests: []}); write.resolve({ok: true}); await operation; await settle();
  assert.equal(h.closes.length, 1); assert.deepEqual(h.events, ['closed']); h.dispose();
});

test('readable nonfriend profile shows supplied identity without activity or comparison', async () => {
  const c = await setup(); assert.equal(c.selectProfile('member:one'), true); await c.loadProfile();
  const env = nativeRuntime(), {html} = render(env, MemberProfile, {controller: c, accountRef: 'member:one', onActivity() {}, onCompare() {}});
  assert.match(html, /Taylor/); assert.match(html, /Listens together/); assert.match(html, /not shared with you/);
  assert.doesNotMatch(html, />Listening activity<|Compare with you|Unfriend|Edit profile/);
  assert.equal(c.getSnapshot().selectedFriendRef, null);
});

test('accepted label or profile grants alone cannot authorize private activity', async () => {
  const c = await setup({readFriends: () => friends({friends: [friend({allowed_actions: {can_view_profile: true}})], requests: []}),
    readProfile: () => ({...friend(), allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true}})});
  c.selectProfile('member:one'); await c.loadProfile();
  const env = nativeRuntime(), {html} = render(env, MemberProfile, {controller: c, accountRef: 'member:one', onActivity() {}, onCompare() {}});
  assert.match(html, />Friend</); assert.doesNotMatch(html, />Listening activity<|Compare with you/);
});

test('failed configured profile read does not leak a cached directory identity', async () => {
  for (const status of ['denied', 'error']) {
    const c = await setup({readProfile: () => {if (status === 'error') throw new Error('Unavailable'); return {status};}});
    c.selectProfile('member:one'); await c.loadProfile();
    const {html, raw} = render(nativeRuntime(), MemberProfile, {controller: c, accountRef: 'member:one'});
    assert.doesNotMatch(raw, /Taylor|Listens together|taylor.webp/);
    assert.doesNotMatch(html, /Taylor|Listens together|taylor.webp/);
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
  }
});

test('directory and discovered members use native rows and keep Unfriend in the directory', async () => {
  const c = await setup({readFriends: () => friends({friends: [friend()]})}), env = nativeRuntime();
  const {html, host} = render(env, FriendsDirectory, {controller: c, onProfile() {}, onRequest() {}});
  assert.equal(host.querySelectorAll('[data-navigation-tree-item]').length, 2);
  assert.ok(buttonNamed(host, 'Unfriend')); assert.doesNotMatch(html, />Block<|>Remove<|>Accept request</);
  const member = {...friend(), relationship: 'none', allowed_actions: {can_view_profile: true}};
  const rows = render(env, MemberResults, {controller: c, value: {status: 'ready', data: {members: [member]}}, onProfile() {}});
  assert.equal(rows.host.querySelector('[data-navigation-tree-item]').disabled, false);
});

test('only the most recently selected member can navigate after row feedback', async () => {
  const members = ['member:one', 'member:two'].map(account_ref => ({...friend({account_ref}), relationship: 'none'}));
  const c = await setup({readMembers: () => ({members, next_cursor: null})}); await c.loadMembers({query: 'Taylor'});
  const env = nativeRuntime(), opened = [];
  const owner = env.own(MemberResults(env.host, env.runtime, {controller: c, value: c.getSnapshot().members, onProfile: ref => opened.push(ref)}));
  const rows = members.map(person => env.host.querySelector(`[data-home-person-ref="${person.account_ref}"]`));
  env.click(rows[0]); env.click(rows[1]);
  env.drain();
  assert.deepEqual(opened, ['member:two']); owner.dispose();
});

test('directory never labels an acknowledged but unresolved cancellation complete', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({direction: 'outgoing', allowed_actions: {can_cancel: true}})]}),
    cancelRequest: () => ({ok: true})});
  await c.mutate('cancelRequest', 'request:one');
  const {html, raw, host} = render(nativeRuntime(), FriendsDirectory, {controller: c});
  assert.doesNotMatch(raw, /Friend request cancelled/); assert.match(html, /not been confirmed/);
  assert.equal(buttonNamed(host, 'Cancel request').disabled, true); assert.ok(buttonNamed(host, 'Refresh Friends'));
});

test('an authoritative empty envelope confirms cancellation without fabricated relationship rows', async () => {
  let cancelled = false;
  const c = await setup({readFriends: () => cancelled ? {status: 'empty', data: null}
    : friends({requests: [request({direction: 'outgoing', allowed_actions: {can_cancel: true}})]}),
    cancelRequest: () => {cancelled = true; return {ok: true};}});
  await c.mutate('cancelRequest', 'request:one');
  const {html, raw} = render(nativeRuntime(), FriendsDirectory, {controller: c});
  assert.match(html, /Friend request cancelled/); assert.doesNotMatch(raw, /not been confirmed|Taylor/);
});

test('Unfriend rechecks the exact current friendship after native confirmation', async () => {
  const confirmation = deferred(); let confirms = 0, writes = 0, payload = friends({friends: [friend()], requests: []});
  const c = await setup({readFriends: () => payload, removeFriend: () => {writes++; return {ok: true};}});
  const env = nativeRuntime();
  const runtime = {...env.runtime, confirm: (_message, options) => {confirms++; assert.equal(options.acceptLabel, 'Unfriend'); assert.equal(options.danger, true); return confirmation.promise;}};
  const owner = env.own(FriendsDirectory(env.host, runtime, {controller: c}));
  const button = buttonNamed(env.host, 'Unfriend');
  env.click(button); env.click(button); await settle(); assert.equal(confirms, 1);
  payload = friends({friends: [friend({allowed_actions: {can_remove: false}})], requests: []}); await c.loadFriends();
  confirmation.resolve(true); await settle();
  assert.equal(writes, 0); assert.match(visibleHtml(env.host), /Friends/);
  owner.dispose();
});

test('confirmed removal restores the connected directory when its opener disappears', async () => {
  let payload = friends({friends: [friend()], requests: []}), writes = 0;
  const env = nativeRuntime(); let trigger;
  const c = await setup({readFriends: () => payload, removeFriend: () => {
    writes++; trigger.remove(); payload = friends({friends: [], requests: []}); return {ok: true};
  }});
  const owner = env.own(FriendsDirectory(env.host, {...env.runtime, confirm: () => Promise.resolve(true)}, {controller: c}));
  const root = env.host.querySelector('[data-home-friends-directory]'); trigger = buttonNamed(root, 'Unfriend');
  trigger.focus(); env.click(trigger); await settle(); env.drain();
  assert.equal(writes, 1); assert.equal(env.document.activeElement, root); owner.dispose();
});

test('native person row preserves its button and rejects delayed activation after revocation', () => {
  const env = nativeRuntime(); let selected = 0, opens = 0;
  const props = {person: friend(), rowKey: 'friend:member:one', selected: false, disabled: false,
    onSelect: () => {selected++;}, onActivate: () => {opens++;}};
  const owner = env.own(PersonNavigation(env.host, env.runtime, props)), button = env.host.querySelector('[data-navigation-tree-item]');
  env.click(button); assert.equal(selected, 1); assert.equal(opens, 0);
  owner.update({...props, selected: true, disabled: true});
  assert.equal(env.host.querySelector('[data-navigation-tree-item]'), button); assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-current'), 'true');
  env.drain(); assert.equal(opens, 0); owner.dispose(); assert.equal(env.frames.size, 0);
});

test('profile activity callback rechecks accepted source grants after the button was rendered', async () => {
  let payload = friends({friends: [friend()], requests: []}), opens = 0;
  const c = await setup({readFriends: () => payload}); c.selectProfile('member:one'); await c.loadProfile();
  const env = nativeRuntime();
  const owner = env.own(MemberProfile(env.host, env.runtime, {controller: c, accountRef: 'member:one', onActivity: () => {opens++;}, showIdentity: false}));
  const button = buttonNamed(env.host, 'Listening activity'); assert.ok(button);
  assert.doesNotMatch(visibleHtml(env.host), /home-profile__identity/);
  payload = friends({friends: [friend({allowed_actions: {can_view_profile: true}})], requests: []}); await c.loadFriends();
  env.click(button); assert.equal(opens, 0); owner.dispose();
});
