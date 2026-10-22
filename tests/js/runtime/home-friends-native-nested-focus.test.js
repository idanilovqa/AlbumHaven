'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, settle} = require('./home-friends-native-app-fixture.cjs');

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
const person = ref => ({account_ref: ref, display_name: ref, handle: 'member', bio: '', avatar_url: null, relationship: 'accepted',
  allowed_actions: {can_view_profile: true, can_view_activity: true, can_remove: true}});
function directoryState() {
  return {scopeKey: 'scope:one', friends: {status: 'ready', data: {profile: person('self'), friends: [person('friend:one')], requests: [], allowed_actions: {can_discover_members: true}}},
    mutation: {status: 'idle'}, members: {status: 'ready', data: {members: [{...person('member:one'), relationship: 'none', allowed_actions: {can_request: true, can_view_profile: true}}]}}, memberQuery: 'Ada'};
}
function homeListeners(h, root) {
  // The native tablist owns anonymous inner listeners without a release API.
  // Inspect the consumer registrations, including detached retained controls.
  return h.listeners().filter(entry => root.contains(entry.target) && !entry.target.matches('.in-page-tabs'));
}
function assertReleased(h, entries) {
  const remaining = h.listeners();
  for (const entry of entries) assert.equal(remaining.includes(entry), false, `retired ${entry.type} registration was removed`);
}
function nativeFocusForm(h, attribute) {
  // Keep the production form helper's initial-focus and focus-event path.
  // Only its content/data boundary is supplied by this fixture.
  return h.runtime.openForm({title: 'Native focus boundary', onMount(host) {
    host.innerHTML = h.runtime.buttonHtml({label: 'Native focus target', attributes: {[attribute]: ''}});
  }});
}

for (const [kind, eventType] of [['album', 'focusin'], ['artist', 'focus']]) test(`Activity local ${kind} detail stops before its provider when native form ${eventType} retires Activity`, async t => {
  const h = fixture(t), {mountActivityPanel} = await load('activity.mjs'), reads = [], leases = [], preferences = new Set(), playback = new Set();
  const selection = {kind, ref: `${kind}:one`, allowed_actions: {can_view_details: true}};
  const row = {id: `${kind}-row`, kind, title: `Selected ${kind}`, artist: 'Artist', source_readable: true, listen_count: 1, detail_ref: selection.ref,
    allowed_actions: selection.allowed_actions, [`${kind}_target`]: selection};
  const props = {scopeKey: 'scope:one', kind: `${kind}s`, view: 'rows', value: {status: 'ready', data: {rows: [row]}},
    readDetail(request) {reads.push(request); return Promise.resolve({status: 'empty'});}};
  Object.assign(h.runtime, {
    subscribeTrackPreferences(listener) {preferences.add(listener); return () => preferences.delete(listener);},
    subscribeTrackPlayback(listener) {playback.add(listener); return () => playback.delete(listener);},
    mountResourceSelection(_host, options) {
      const lease = {options, disposals: 0}; leases.push(lease);
      const native = nativeFocusForm(h, 'data-nested-resource-focus');
      return {dispose() {lease.disposals++; native.close(null, {force: true, restoreFocus: false});}};
    },
  });
  const owner = h.own(mountActivityPanel(h.host, h.runtime, props));
  const trigger = h.host.querySelector(kind === 'artist' ? '[data-home-artist-select]' : '[data-home-activity-select]');
  assert.ok(trigger); const acquired = homeListeners(h, h.host); let events = 0;
  const focus = event => {if (event.target.hasAttribute('data-nested-resource-focus')) {events++; owner.dispose();}};
  const capture = eventType === 'focus';
  h.document.addEventListener(eventType, focus, capture); t.after(() => h.document.removeEventListener(eventType, focus, capture));
  h.click(trigger); await settle();
  assert.equal(events, 1, 'the actual native form helper synchronously delivered focus');
  assert.equal(reads.length, 0, 'a late-returning local detail cannot load after its Activity parent retires');
  assert.equal(leases.length, 1); assert.equal(leases[0].disposals, 1); assertReleased(h, acquired);
  assert.equal(preferences.size, 0); assert.equal(playback.size, 0); assert.equal(h.form.hidden, true); assert.equal(h.host.childNodes.length, 0);
  assert.ok(h.observers.every(observer => !observer.connected), 'the returned form lease also releases its late observer');
  leases[0].options.onState('ready'); leases[0].options.onError(new Error('late resource failure'));
  h.click(trigger); owner.update(props); owner.dispose(); h.drain(); await settle();
  assert.equal(reads.length, 0); assert.equal(leases[0].disposals, 1); assert.equal(h.host.childNodes.length, 0); assert.equal(h.form.hidden, true);
});

test('Friends directory native tab restoration focus stops before creating People after disposal', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), state = directoryState(), controller = store(state), opened = [];
  const owner = h.own(mountFriendsDirectory(h.host, h.runtime, {controller, onProfile: ref => opened.push(ref)}));
  const root = h.host.firstElementChild, friends = root.querySelector('[data-in-page-tab="friends"]'), people = root.querySelector('[data-in-page-tab="people"]');
  friends.focus(); const acquired = homeListeners(h, root), retained = root.querySelectorAll('button');
  let events = 0, searches = 0; const render = h.runtime.buttonHtml;
  h.runtime.buttonHtml = value => {if (value.label === 'Search') searches++; return render(value);};
  const focus = event => {
    if (event.target !== friends && event.target.dataset.inPageTab === 'friends') {events++; owner.dispose();}
  };
  h.document.addEventListener('focusin', focus); t.after(() => h.document.removeEventListener('focusin', focus));
  h.click(people);
  assert.equal(events, 1, 'actual mountTabs restored the focused tab while replacing its markup');
  assert.equal(searches, 0, 'retired directory does not enter the People factory');
  assert.equal(controller.listenerCount(), 0); assert.equal(controller.releaseCount(), 1); assertReleased(h, acquired);
  assert.equal(root.querySelector('section[aria-label="People"]'), null); assert.equal(h.host.childNodes.length, 0);
  for (const button of retained) h.click(button);
  controller.set(directoryState()); owner.update({controller}); owner.dispose(); h.drain(); await settle();
  assert.equal(controller.releaseCount(), 1); assert.equal(searches, 0); assert.deepEqual(controller.calls, []); assert.deepEqual(opened, []);
});

test('Friends directory disposes a People panel returned after native form focus retires its parent', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), controller = store(directoryState()), opened = [];
  const owner = h.own(mountFriendsDirectory(h.host, h.runtime, {controller, onProfile: ref => opened.push(ref)}));
  const root = h.host.firstElementChild, oldListeners = homeListeners(h, root), oldButtons = root.querySelectorAll('button');
  let events = 0, searchRenders = 0, native, panel, form, input, retained = [], acquired = [];
  const render = h.runtime.buttonHtml;
  h.runtime.buttonHtml = value => {
    if (value.label === 'Search' && ++searchRenders === 2) {
      panel = root.querySelector('section[aria-label="People"]'); form = panel.querySelector('form'); input = panel.querySelector('input');
      retained = panel.querySelectorAll('button'); acquired = homeListeners(h, panel);
      assert.ok(acquired.some(entry => entry.target === form && entry.type === 'submit'));
      assert.ok(acquired.some(entry => entry.target === input && entry.type === 'input'));
      assert.ok(acquired.some(entry => entry.target.matches('.home-friends__person-navigation') && entry.type === 'click'));
      native = nativeFocusForm(h, 'data-nested-people-focus');
    }
    return render(value);
  };
  const focus = event => {if (event.target.hasAttribute('data-nested-people-focus')) {events++; owner.dispose();}};
  h.document.addEventListener('focus', focus, true);
  t.after(() => {h.document.removeEventListener('focus', focus, true); native?.close(null, {force: true, restoreFocus: false});});
  h.click(root.querySelector('[data-in-page-tab="people"]'));
  assert.equal(events, 1, 'the native form helper focused while the People factory was still returning');
  assert.equal(controller.listenerCount(), 0); assert.equal(controller.releaseCount(), 1);
  assertReleased(h, oldListeners); assertReleased(h, acquired);
  assert.equal(root.querySelector('section[aria-label="People"]'), null, 'late returned panel was disposed rather than stored on a retired directory');
  assert.equal(panel.parentNode, null); assert.equal(h.host.childNodes.length, 0);
  native.close(null, {force: true, restoreFocus: false});
  for (const button of [...oldButtons, ...retained]) h.click(button);
  form.dispatchEvent(new h.c.Event('submit')); h.input(input, 'Late query'); controller.set(directoryState()); owner.update({controller}); owner.dispose();
  h.drain(); await settle();
  assert.equal(controller.releaseCount(), 1); assert.equal(h.frames.size, 0); assert.equal(h.host.childNodes.length, 0);
  assert.deepEqual(controller.calls, []); assert.deepEqual(opened, []);
});

// R8: exercise live queued updates, not just parent disposal. The selection
// transport is controlled, but focus is delivered by the real native form helper.
for (const [kind, eventType] of [['album', 'focusin'], ['artist', 'focus']]) {
  for (const replacement of ['provider', 'source', 'unchanged', 'newer-direct', 'return-to-original']) {
    test(`Activity local ${kind} native ${eventType} queues ${replacement} ownership and converges`, async t => {
      const h = fixture(t), {mountActivityPanel} = await load('activity.mjs');
      const reads = [], leases = [], preferences = new Set(), playback = new Set();
      const makeRow = ref => {
        const target = {kind, ref, allowed_actions: {can_view_details: true}};
        return {id: `${kind}-row`, kind, title: `Selected ${ref}`, artist: 'Artist', source_readable: true,
          listen_count: 1, detail_ref: ref, allowed_actions: target.allowed_actions, [`${kind}_target`]: target};
      };
      const initialRow = makeRow(`${kind}:one`), replacementRow = makeRow(`${kind}:two`);
      const providerA = request => {reads.push({provider: 'A', request}); return Promise.resolve({status: 'empty'});};
      const providerB = request => {reads.push({provider: 'B', request}); return Promise.resolve({status: 'empty'});};
      const providerC = request => {reads.push({provider: 'C', request}); return Promise.resolve({status: 'empty'});};
      const props = {scopeKey: 'scope:one', kind: `${kind}s`, view: 'rows',
        value: {status: 'ready', data: {rows: [initialRow]}}, readDetail: providerA};
      let next = ['provider', 'newer-direct'].includes(replacement) ? {...props, readDetail: providerB}
        : replacement === 'source' ? {...props, value: {status: 'ready', data: {rows: [replacementRow]}}}
          : {...props};
      Object.assign(h.runtime, {
        subscribeTrackPreferences(listener) {preferences.add(listener); return () => preferences.delete(listener);},
        subscribeTrackPlayback(listener) {playback.add(listener); return () => playback.delete(listener);},
        mountResourceSelection(_host, options) {
          assert.ok(leases.length < 3, 'same-input focus publication must not create an unbounded remount loop');
          const lease = {options, disposals: 0}; leases.push(lease);
          const native = nativeFocusForm(h, 'data-live-activity-focus');
          return {dispose() {lease.disposals++; native.close(null, {force: true, restoreFocus: false});}};
        },
      });
      const owner = h.own(mountActivityPanel(h.host, h.runtime, props));
      let events = 0;
      const focus = event => {
        if (!event.target.hasAttribute('data-live-activity-focus')) return;
        events++;
        // Repeat the same next inputs even during the replacement's own focus.
        // A scheduling counter used as ownership would keep rejecting this lease.
        if (replacement === 'return-to-original' && events === 1) owner.update({...props, readDetail: providerB});
        owner.update({...next});
      };
      const capture = eventType === 'focus';
      h.document.addEventListener(eventType, focus, capture);
      t.after(() => h.document.removeEventListener(eventType, focus, capture));
      const selector = kind === 'artist' ? '[data-home-artist-select]' : '[data-home-activity-select]';
      const trigger = h.host.querySelector(selector); assert.ok(trigger); h.click(trigger);
      assert.equal(events, 1, 'the real form helper focused synchronously inside resource acquisition');
      const changed = replacement !== 'unchanged';
      assert.equal(reads.length, changed ? 0 : 1, 'superseded ownership must stop before the old provider starts');
      assert.equal(leases.length, 1); assert.equal(leases[0].disposals, changed ? 1 : 0);
      if (replacement === 'newer-direct') {
        // The pending B application has not run. A direct newer C update must
        // cancel it, including any queued render continuation from the old frame.
        next = {...props, readDetail: providerC}; owner.update(next);
      }
      await settle(); h.drain(); await settle();
      assert.equal(events, changed ? 2 : 1); assert.equal(leases.length, changed ? 2 : 1);
      assert.equal(reads.length, 1, 'exactly the intended current detail is loaded');
      assert.equal(reads[0].provider, replacement === 'provider' ? 'B' : replacement === 'newer-direct' ? 'C' : 'A');
      assert.equal(reads[0].request.ref, replacement === 'source' ? `${kind}:two` : `${kind}:one`);
      assert.equal(reads[0].request.kind, kind); assert.equal(reads[0].request.signal.aborted, false);
      const active = leases.at(-1);
      assert.equal(active.disposals, 0); assert.equal(h.form.hidden, false);
      assert.ok(h.host.querySelector('.home-activity__selection h3').textContent.includes(replacement === 'source' ? `${kind}:two` : `${kind}:one`));
      if (changed) {
        leases[0].options.onState('ready'); leases[0].options.onError(new Error('obsolete detail failure'));
        assert.equal(h.host.querySelector('[data-native-ready="true"]'), null, 'retired callbacks cannot mark the current selection ready');
        assert.equal(leases[0].disposals, 1);
      }
      active.options.onState('ready');
      assert.ok(h.host.querySelector('[data-native-ready="true"]'), 'the replacement selection remains usable');
      owner.update({...next}); await settle(); h.drain(); await settle();
      assert.equal(leases.length, changed ? 2 : 1, 'unchanged updates preserve the current native lease');
      assert.equal(reads.length, 1); assert.equal(active.disposals, 0);
      owner.dispose(); owner.dispose(); h.drain(); await settle();
      assert.ok(leases.every(lease => lease.disposals === 1), 'every acquired lease is released exactly once');
      assert.equal(preferences.size, 0); assert.equal(playback.size, 0);
      assert.equal(h.form.hidden, true); assert.equal(h.host.childNodes.length, 0);
      assert.ok(h.observers.every(observer => !observer.connected));
      for (const lease of leases) {lease.options.onState('ready'); lease.options.onError(new Error('late detail failure'));}
      owner.update(next); h.click(trigger); await settle();
      assert.equal(reads.length, 1); assert.equal(h.host.childNodes.length, 0);
      assert.ok(leases.every(lease => lease.disposals === 1));
    });
  }
}
