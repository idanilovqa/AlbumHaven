'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load} = require('./home-friends-native-app-fixture.cjs');

function store(initial) {
  let state = initial, releases = 0;
  const listeners = new Set(), calls = [];
  return {calls, getSnapshot: () => state, listenerCount: () => listeners.size, releaseCount: () => releases,
    subscribe(listener) {listeners.add(listener); return () => {releases++; listeners.delete(listener);};},
    set(next) {state = next; for (const listener of [...listeners]) listener();},
    loadMembers(value) {calls.push({read: 'members', ...value}); return Promise.resolve();},
    loadFriends() {calls.push({read: 'friends'}); return Promise.resolve();},
    mutate(action, target) {calls.push({action, target}); return Promise.resolve({status: 'ready', action, target});}};
}
const person = (ref, extra = {}) => ({account_ref: ref, display_name: ref, handle: 'member', bio: '', avatar_url: null, relationship: 'accepted',
  allowed_actions: {can_view_profile: true, can_view_activity: true, can_remove: true}, ...extra});
const incoming = () => person('member:one', {request_ref: 'request:one', direction: 'incoming', relationship: 'incoming_pending',
  allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}});
const candidate = () => person('member:two', {relationship: 'none', allowed_actions: {can_request: true, can_view_profile: true}});
function state(extra = {}) {
  return {scopeKey: 'scope:one', friends: {status: 'ready', data: {profile: person('self', {display_name: 'Me', handle: 'self'}), friends: [], requests: [], allowed_actions: {can_discover_members: true}}},
    mutation: {status: 'idle'}, members: {status: 'idle', data: null}, memberQuery: '', profile: {status: 'idle', data: null}, ...extra};
}
const visible = element => element.isConnected && !element.closest('[hidden], [inert]');
const statuses = root => root.querySelectorAll('.home-friends__status');
const visibleAlerts = root => root.querySelectorAll('[role="status"], [role="alert"]').filter(visible);
function homeListeners(h, root) {
  // The existing native tablist helper owns its anonymous inner listeners and
  // has no release API. Inspect the Home owners' exact listener registrations,
  // including those on detached controls, rather than relying on DOM removal.
  return h.listeners().filter(entry => root.contains(entry.target) && !entry.target.matches('.in-page-tabs'));
}
function assertReleased(h, acquired) {
  const remaining = h.listeners();
  for (const entry of acquired) assert.equal(remaining.includes(entry), false, `${entry.type} listener was released from its retained control`);
}

test('actual request content hides idle and unrelated mutation Status while retaining loading, errors and Retry', async t => {
  const h = fixture(t), {mountFriendRequestContent} = await load('friend-request.mjs'), initial = state();
  initial.friends.data.requests = [incoming()];
  let refreshed = 0;
  const props = value => ({state: value, requestRef: 'request:one', onRefresh: () => refreshed++});
  const owner = h.own(mountFriendRequestContent(h.host, h.runtime, props(initial)));
  const [requests, mutation, denied] = statuses(h.host);
  assert.ok(requests && mutation && denied);
  assert.equal(visible(requests), false); assert.equal(visible(mutation), false); assert.equal(visible(denied), false);
  assert.equal(visibleAlerts(h.host).length, 0);
  owner.update(props({...initial, mutation: {status: 'error', target: 'request:other'}}));
  assert.equal(visible(mutation), false, 'another request must not display mutation status here');
  owner.update(props({...initial, mutation: {status: 'loading', target: 'request:one'}}));
  assert.equal(visible(mutation), true); assert.equal(mutation.getAttribute('aria-busy'), 'true');
  assert.match(mutation.querySelector('[role="status"]').textContent, /Loading Friend request changes/);
  owner.update(props({...initial, mutation: {status: 'error', target: 'request:one'}}));
  assert.equal(visible(mutation), true); assert.ok(visible(mutation.querySelector('[role="alert"]')));
  const empty = {...initial, friends: {status: 'empty', data: {...initial.friends.data, requests: []}}};
  owner.update(props(empty));
  assert.equal(visible(requests), false); assert.equal(visible(mutation), false);
  assert.deepEqual(visibleAlerts(h.host).map(node => node.textContent), ['This friend request is no longer available.']);
  owner.update(props({...initial, friends: {status: 'loading', data: null}}));
  assert.equal(visible(requests), true); assert.equal(requests.getAttribute('aria-busy'), 'true');
  owner.update(props({...initial, friends: {status: 'error', data: null}}));
  assert.equal(visible(requests), true); assert.ok(visible(requests.querySelector('[role="alert"]')));
  h.click(h.named('Retry', requests)); assert.equal(refreshed, 1);
});

test('actual idle Friends directory hides mutation Status and preserves resource Retry and mutation errors', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), initial = state(), controller = store(initial);
  h.own(mountFriendsDirectory(h.host, h.runtime, {controller}));
  const mutation = statuses(h.host).find(node => node.textContent.includes('Friend changes'));
  assert.ok(mutation); assert.equal(visible(mutation), false); assert.equal(visibleAlerts(h.host).length, 0);
  for (const status of ['loading', 'error', 'denied', 'unavailable']) {
    controller.set({...initial, mutation: {status}});
    assert.equal(visible(mutation), true, `${status} mutation remains visible`);
    assert.equal(mutation.getAttribute('aria-busy'), String(status === 'loading'));
    assert.equal(visibleAlerts(mutation).length, 1);
  }
  controller.set({...initial, friends: {status: 'error', data: null}});
  assert.equal(visible(mutation), false);
  const friends = h.host.querySelector('section[aria-label="Friends"]');
  assert.equal(visibleAlerts(friends).length, 1); h.click(h.named('Retry', friends));
  assert.deepEqual(controller.calls, [{read: 'friends'}]);
});

test('actual People tab has no premature or duplicate Status and keeps error, loading and retry visible', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), initial = state(), controller = store(initial);
  h.own(mountFriendsDirectory(h.host, h.runtime, {controller}));
  h.click(h.host.querySelector('[data-in-page-tab="people"]'));
  const people = h.host.querySelector('section[aria-label="People"]'), status = statuses(people)[0];
  assert.ok(status); assert.equal(visible(status), false); assert.equal(visibleAlerts(people).length, 0);
  const searched = {...initial, memberQuery: 'Ada', members: {status: 'empty', data: {members: [], next_cursor: null}}};
  controller.set(searched);
  assert.equal(statuses(people)[0], status); assert.equal(visible(status), false);
  assert.deepEqual(visibleAlerts(people).map(node => node.textContent), ['No people match this search.']);
  controller.set({...searched, members: {status: 'ready', data: {members: [candidate()], next_cursor: null}}});
  assert.equal(visible(status), false); assert.equal(visibleAlerts(people).length, 0);
  controller.set({...searched, members: {status: 'error', data: null}});
  assert.equal(visible(status), true); assert.ok(visible(status.querySelector('[role="alert"]')));
  const retry = h.named('Retry', people); assert.ok(retry); h.click(retry);
  assert.deepEqual(controller.calls, [{read: 'members', query: 'Ada'}]);
  controller.set({...searched, members: {status: 'loading', data: null}});
  assert.equal(visible(status), true); assert.equal(status.getAttribute('aria-busy'), 'true');
  assert.ok(visible(status.querySelector('[role="status"]'))); assert.equal(h.named('Retry', people), undefined);
  h.click(retry); assert.equal(controller.calls.length, 1, 'retired Retry cannot send a second read');
  controller.set(initial); assert.equal(visible(status), false); assert.equal(visibleAlerts(people).length, 0);
});

test('unreturned member results retire a real navigation acquired before a Send request renderer failure', async t => {
  const h = fixture(t), {mountMemberResults} = await load('friends-directory.mjs'), initial = state({memberQuery: 'Ada', members: {status: 'ready', data: {members: [candidate()]}}});
  const controller = store(initial), failure = new Error('Send request renderer failed'), baseline = h.listeners().length;
  let retained, acquired = [], removed = 0;
  const render = h.runtime.buttonHtml;
  h.runtime.buttonHtml = value => {
    if (value.label !== 'Send request') return render(value);
    retained = h.host.querySelector('[data-home-person-row="member:member:two"]');
    assert.ok(retained, 'real row navigation exists before the later Button throws');
    acquired = homeListeners(h, h.host);
    const navigation = retained.closest('.home-friends__person-navigation'), remove = navigation.removeEventListener;
    assert.ok(acquired.some(entry => entry.target === navigation && entry.type === 'click'));
    navigation.removeEventListener = function(...args) {removed++; remove.apply(this, args); throw new Error('secondary navigation cleanup failed');};
    throw failure;
  };
  assert.throws(() => mountMemberResults(h.host, h.runtime, {controller, value: initial.members, onProfile() {controller.calls.push('profile');}}), error => error === failure);
  assert.equal(removed, 1); assertReleased(h, acquired); assert.equal(h.listeners().length, baseline);
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.frames.size, 0);
  h.click(retained); h.drain(); assert.deepEqual(controller.calls, []);
});

test('unreturned member search unwinds earlier controls when its Next page factory throws', async t => {
  const h = fixture(t), {mountMemberSearch} = await load('friends-directory.mjs'), initial = state(), controller = store(initial);
  const failure = new Error('Next page renderer failed'), baseline = h.listeners().length, render = h.runtime.buttonHtml;
  let acquired = [], retained;
  h.runtime.buttonHtml = value => {
    if (value.label !== 'Next page') return render(value);
    retained = h.named('Search', h.host); acquired = homeListeners(h, h.host);
    assert.ok(retained); assert.ok(acquired.some(entry => entry.type === 'click'));
    throw failure;
  };
  assert.throws(() => mountMemberSearch(h.host, h.runtime, {controller, state: initial}), error => error === failure);
  assertReleased(h, acquired); assert.equal(h.listeners().length, baseline); assert.equal(h.host.childNodes.length, 0);
  h.click(retained); assert.deepEqual(controller.calls, []);
});

for (const phase of ['row-button', 'first-search-render']) test(`actual first People tab ${phase} failure retires nested owners, old controls and subscription once`, async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), initial = state({memberQuery: 'Ada', members: {status: 'ready', data: {members: [candidate()]}}});
  initial.friends.data.friends = [person('friend:old')];
  const controller = store(initial), failure = new Error(`${phase} late renderer failed`), opened = [];
  const subscribe = controller.subscribe;
  controller.subscribe = listener => {
    const release = subscribe(listener);
    return () => {release(); throw new Error('secondary unsubscribe failure');};
  };
  const owner = h.own(mountFriendsDirectory(h.host, h.runtime, {controller, onProfile: ref => opened.push(ref)}));
  const oldRow = h.host.querySelector('[data-home-person-row="friend:friend:old"]'), oldButtons = h.host.querySelectorAll('button');
  const oldListeners = homeListeners(h, h.host);
  h.click(oldRow); assert.equal(h.frames.size, 1, 'old native navigation has a delayed activation to cancel');
  let acquired = [], retained = [], form, input, removed = 0, searchRenders = 0;
  const render = h.runtime.buttonHtml;
  h.runtime.buttonHtml = value => {
    if (value.label === 'Search') searchRenders++;
    if (!(phase === 'row-button' && value.label === 'Send request' || phase === 'first-search-render' && value.label === 'Search' && searchRenders === 2)) return render(value);
    const navigation = h.host.querySelector('.home-friends__person-navigation');
    assert.ok(navigation, 'the fault follows successful actual row navigation acquisition');
    acquired = homeListeners(h, h.host); retained = h.host.querySelectorAll('button');
    form = h.host.querySelector('form'); input = h.host.querySelector('input');
    assert.ok(acquired.some(entry => entry.target === navigation && entry.type === 'click'));
    if (phase === 'first-search-render') {
      assert.ok(acquired.some(entry => entry.target === form && entry.type === 'submit'));
      assert.ok(acquired.some(entry => entry.target === input && entry.type === 'input'));
      assert.ok(retained.some(button => button.textContent.trim() === 'Send request'));
    }
    const remove = navigation.removeEventListener;
    navigation.removeEventListener = function(...args) {removed++; remove.apply(this, args); throw new Error('secondary nested navigation cleanup failed');};
    throw failure;
  };
  const peopleTab = h.host.querySelector('[data-in-page-tab="people"]');
  assert.throws(() => h.click(peopleTab), error => error === failure);
  assert.equal(removed, 1); assert.equal(controller.listenerCount(), 0); assert.equal(controller.releaseCount(), 1);
  assertReleased(h, oldListeners); assertReleased(h, acquired);
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.frames.size, 0, 'retirement cancels old row activation');
  for (const button of [...oldButtons, ...retained]) h.click(button);
  form.dispatchEvent(new h.c.Event('submit')); h.input(input, 'Late search');
  controller.set({...initial, memberQuery: 'Late search'}); owner.update({controller}); owner.dispose(); owner.dispose(); h.drain();
  assert.equal(controller.releaseCount(), 1); assert.equal(h.host.childNodes.length, 0);
  assert.deepEqual(controller.calls, []); assert.deepEqual(opened, []);
});

test('successful People disposal releases every Home listener and ignores retained search controls and notifications', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), initial = state({memberQuery: 'Ada', members: {status: 'ready', data: {members: [candidate()], next_cursor: 'next:one'}}});
  const controller = store(initial), opened = [], owner = h.own(mountFriendsDirectory(h.host, h.runtime, {controller, onProfile: ref => opened.push(ref)}));
  h.click(h.host.querySelector('[data-in-page-tab="people"]'));
  const controls = h.host.querySelectorAll('button'), form = h.host.querySelector('form'), input = h.host.querySelector('input'), acquired = homeListeners(h, h.host);
  const row = h.host.querySelector('[data-home-person-row="member:member:two"]');
  h.click(row); assert.equal(h.frames.size, 1);
  owner.dispose(); owner.dispose();
  assert.equal(controller.releaseCount(), 1); assert.equal(controller.listenerCount(), 0); assert.equal(h.frames.size, 0); assertReleased(h, acquired);
  for (const control of controls) h.click(control);
  form.dispatchEvent(new h.c.Event('submit')); h.input(input, 'Late query'); controller.set(state()); h.drain();
  assert.equal(h.host.childNodes.length, 0); assert.deepEqual(controller.calls, []); assert.deepEqual(opened, []);
});
