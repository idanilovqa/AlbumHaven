'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const repo = path.resolve(__dirname, '../../..');
const base = path.join(repo, 'music_app/static/js/home-friends');
const load = name => import(pathToFileURL(path.join(base, name)).href);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = async () => {for (let n = 0; n < 8; n++) await Promise.resolve();};
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const env = withDomPlatform(createNativeHomeRuntime()), {context: c, document} = env;
  const frames = new Map(), timers = new Map(), owners = []; let sequence = 0;
  document.defaultView = c; c.innerWidth = 1600; c.innerHeight = 1000;
  c.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  c.requestAnimationFrame = fn => {const id = ++sequence; frames.set(id, fn); return id;}; c.cancelAnimationFrame = id => frames.delete(id);
  c.setTimeout = fn => {const id = ++sequence; timers.set(id, fn); return id;}; c.clearTimeout = id => timers.delete(id);
  c.getComputedStyle = element => ({zIndex: element.style.zIndex || 'auto', backgroundColor: 'white', getPropertyValue: key => element.style.getPropertyValue(key)});
  c.Element.prototype.focus = function() {if (this.isConnected && !this.disabled && !this.closest('[hidden], [inert]')) document.activeElement = this;};
  c.Element.prototype.blur = function() {if (document.activeElement === this) document.activeElement = document.body;};
  c.Element.prototype.select = function() {this.selectionStart = 0; this.selectionEnd = String(this.value || '').length;};
  c.Element.prototype.getClientRects = function() {return this.isConnected && !this.closest('[hidden]') ? [{width: 100, height: 32}] : [];};
  c.addEventListener = document.addEventListener.bind(document); c.removeEventListener = document.removeEventListener.bind(document);
  const run = file => vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js', file), 'utf8'), c, {filename: file});
  for (const file of ['runtime/compact-data-table.js', 'runtime/in-page-tabs.js', 'runtime/trigger-anchor.js', 'runtime/library-settings.js', 'runtime/browser-dialog-helpers.js']) run(file);
  const add = (id, tag = 'div') => {const element = document.createElement(tag); element.id = id; document.body.append(element); return element;};
  const template = add('navigation-tree-item-template', 'script'); template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8'); run('navigation-tree.js');
  const shell = add('app-shell'); shell.dataset.nativeAccountId = '4'; shell.dataset.nativeLibraryId = '5';
  const form = add('app-form-modal'); form.hidden = true; form.className = 'confirm-modal';
  form.innerHTML = '<div class="confirm-modal-dialog" role="dialog" aria-modal="true"><h2 id="app-form-title"></h2><button id="app-form-close" hidden></button><div id="app-form-content"></div><p id="app-form-error"></p><div class="confirm-modal-actions"><button id="app-form-cancel"></button><button id="app-form-submit"></button></div></div>';
  const runtime = {
    buttonHtml: value => c.ButtonComponent.renderButton(value), actionHtml: value => c.ButtonComponent.renderActionButton(value), iconHtml: name => c.ButtonComponent.renderIconSvg(name),
    alertHtml: value => c.buildOnPageAlertHtml(value), artboxHtml: value => c.buildAlbumArtboxHtml(value), escapeHtml: c.escapeHtml,
    tableHtml: value => c.buildCompactDataTable(value), galleryCardHtml: value => c.buildGalleryCardHtml(value), ratingHtml: value => c.buildGalleryRatingHtml(value),
    navigationItemHtml: value => c.NavigationTree.renderItem(value), tabsHtml: value => c.buildInPageTabsHtml(value), mountTabs: element => c.mountInPageTabs(element),
    openChoice: (trigger, options) => c.openUtilityChoiceDropdown(trigger, options), openForm: options => c.openReactFormDialog(options, () => true),
    openAvatar() {},
  };
  function drain() {let turns = 0; while (frames.size || timers.size) {assert.ok(turns++ < 40, 'Native platform queue should settle'); const pending = [...frames.values(), ...timers.values()]; frames.clear(); timers.clear(); for (const fn of pending) fn(0);}}
  function own(owner) {owners.push(owner); return owner;}
  t.after(() => {for (const owner of owners.reverse()) owner.dispose(); drain();});
  const host = add('native-people-test');
  const named = (label, root = document) => root.querySelectorAll('button').find(node => !node.closest('[hidden], [inert]') && (node.getAttribute('aria-label') || node.textContent.trim()) === label);
  const input = (element, value) => {element.value = value; element.dispatchEvent(new c.Event('input', {bubbles: true}));};
  return {...env, c, document, host, form, runtime, add, own, named, input, drain, frames, timers};
}
function store(initial) {
  let state = initial; const listeners = new Set(), calls = [];
  return {calls, getSnapshot: () => state, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    set(next) {state = next; for (const listener of [...listeners]) listener();}, listenerCount: () => listeners.size,
    mutate(action, target, value) {calls.push({action, target, value}); return Promise.resolve({status: 'ready', action, target});},
    loadFriends() {calls.push({read: 'friends'}); return Promise.resolve();}, loadProfile() {calls.push({read: 'profile'}); return Promise.resolve();}, loadMembers(value) {calls.push({read: 'members', ...value}); return Promise.resolve();}};
}
const person = (account_ref, extra = {}) => ({account_ref, display_name: account_ref, handle: account_ref, bio: '', avatar_url: null, relationship: 'accepted', allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true, can_remove: true}, ...extra});
const request = (request_ref = 'request:one', extra = {}) => person('member:one', {request_ref, direction: 'incoming', relationship: 'incoming_pending', allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true, can_cancel: false}, ...extra});
function state(extra = {}) {return {scopeKey: 'scope:one', friends: {status: 'ready', data: {profile: person('self', {display_name: 'Me', handle: 'self', allowed_actions: {can_edit: true, can_upload_avatar: false}}), friends: [], requests: [], allowed_actions: {can_discover_members: true}}}, members: {status: 'idle', data: null}, memberQuery: '', profile: {status: 'idle', data: null}, selectedProfileRef: null, mutation: {status: 'idle'}, ...extra};}

// These mount the new native owners against real markup, tabs, Choice and form
// implementations. Only external-store data and browser primitives are fixtures.
test('native profile retains focused draft inputs and rejects a save completing in another scope', async t => {
  const h = fixture(t), {mountProfileEditor} = await load('profile.mjs'), initial = state(), controller = store(initial), saved = deferred(), calls = [], closed = [];
  controller.mutate = (...args) => {calls.push(args); return saved.promise;};
  const owner = h.own(mountProfileEditor(h.host, h.runtime, {profile: initial.friends.data.profile, controller, onClose: value => closed.push(value)}));
  const handle = h.host.querySelectorAll('input').find(node => node.pattern === '[A-Za-z0-9_]{3,30}'), bio = h.host.querySelector('textarea');
  handle.focus(); h.input(handle, 'new_handle'); h.input(bio, 'A retained draft');
  controller.set({...initial, members: {status: 'loading', data: null}});
  assert.equal(h.host.querySelectorAll('input').find(node => node.pattern === handle.pattern), handle); assert.equal(h.document.activeElement, handle); assert.equal(bio.value, 'A retained draft');
  h.host.querySelector('form').dispatchEvent(new h.c.Event('submit')); assert.equal(calls.length, 1); assert.equal(calls[0][2].handle, 'new_handle');
  controller.set({...initial, scopeKey: 'scope:two'}); saved.resolve({status: 'ready'}); await settle();
  assert.deepEqual(closed, []); assert.equal(h.named('Save profile', h.host).disabled, true);
  owner.dispose(); assert.equal(controller.listenerCount(), 0); assert.equal(h.host.childNodes.length, 0);
});

test('native profile name editor preserves Escape semantics and restores its exact native trigger', async t => {
  const h = fixture(t), {mountProfileEditor} = await load('profile.mjs'), initial = state(), controller = store(initial);
  h.own(mountProfileEditor(h.host, h.runtime, {profile: initial.friends.data.profile, controller, onClose() {}}));
  const trigger = h.named('Edit name: Me'); h.click(trigger); const input = h.host.querySelector('input');
  assert.equal(h.document.activeElement, input); h.input(input, 'Changed'); input.dispatchEvent(new h.c.Event('keydown', {key: 'Escape'}));
  assert.equal(h.document.activeElement, trigger); assert.equal(trigger.getAttribute('aria-label'), 'Edit name: Me'); assert.equal(input.value, 'Me');
});

test('avatar drafts reject malformed headers, abort stale readers and revoke every owned URL', async () => {
  const {createAvatarDraft} = await load('profile.mjs'), changes = [], readers = [], created = [], revoked = [];
  const file = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {type: 'image/png'}); Object.defineProperty(file, 'name', {value: 'avatar.png'});
  const owner = createAvatarDraft(value => changes.push(value), {createReader() {const reader = {readyState: 0, readAsArrayBuffer() {this.readyState = 1;}, abort() {this.readyState = 2; this.onabort?.();}}; readers.push(reader); return reader;},
    createObjectURL(value) {created.push(value); return `blob:owned-${created.length}`;}, revokeObjectURL: url => revoked.push(url)});
  owner.select(file); const first = readers[0]; owner.select(file); assert.equal(first.readyState, 2);
  first.result = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer; first.onload(); assert.equal(created.length, 0);
  readers[1].result = new Uint8Array([0, 1, 2]).buffer; readers[1].onload(); assert.equal(changes.at(-1).status, 'error');
  owner.select(file); readers[2].result = first.result; readers[2].onload(); assert.equal(changes.at(-1).url, 'blob:owned-1');
  owner.rejectPreview('blob:other', 'wrong owner'); assert.equal(revoked.length, 0); owner.clear(); assert.deepEqual(revoked, ['blob:owned-1']);
  owner.select(file); readers[3].result = first.result; readers[3].onload(); owner.dispose(); assert.deepEqual(revoked, ['blob:owned-1', 'blob:owned-2']);
  const count = changes.length; owner.select(file); owner.clear(); assert.equal(changes.length, count);
});

test('profile identities escape names, reset viewer errors and preserve comparison wording', async t => {
  const h = fixture(t), {mountProfileIdentity, mountComparisonIdentity} = await load('profile.mjs');
  const runtime = {...h.runtime, openAvatar() {throw new Error('viewer unavailable');}};
  const owner = h.own(mountProfileIdentity(h.host, runtime, {profile: person('one', {display_name: '<One>', avatar_url: '/avatar/one.png'}), own: false}));
  h.click(h.named("View <One>'s avatar")); assert.match(h.host.textContent, /viewer is not available/); assert.equal(h.host.querySelector('One'), null);
  owner.update({profile: person('two', {display_name: 'Two', avatar_url: '/avatar/two.png'})}); assert.doesNotMatch(h.host.textContent, /viewer is not available/);
  const comparisonHost = h.add('identities'); h.own(mountComparisonIdentity(comparisonHost, h.runtime, {profile: person('Me'), friend: person('Them')}));
  assert.equal(comparisonHost.querySelector('h1').textContent, 'You & Them'); assert.equal(comparisonHost.querySelector('[role="group"]').getAttribute('aria-label'), 'Me and Them');
});

test('member profile never upgrades a profile-only grant into activity or comparison access', async t => {
  const h = fixture(t), {mountMemberProfile} = await load('member-profile.mjs'), member = person('member:one', {relationship: 'none'}), initial = state({selectedProfileRef: member.account_ref, profile: {status: 'ready', data: member}, members: {status: 'ready', data: {members: [member]}}}), controller = store(initial), opened = [];
  h.own(mountMemberProfile(h.host, h.runtime, {controller, accountRef: member.account_ref, onActivity: ref => opened.push(ref), onCompare: ref => opened.push(ref)}));
  assert.equal(h.named('Listening activity'), undefined); assert.match(h.host.textContent, /Listening activity is not shared/);
  const accepted = person(member.account_ref); controller.set({...initial, friends: {...initial.friends, data: {...initial.friends.data, friends: [accepted]}}});
  const activity = h.named('Listening activity'); assert.ok(activity); controller.set({...initial, friends: {status: 'loading', data: null}}); h.click(activity); assert.deepEqual(opened, []);
});

test('friend directory keeps search input and result labels separate and retires delayed row activation', async t => {
  const h = fixture(t), {mountFriendsDirectory} = await load('friends-directory.mjs'), initial = state(), accepted = person('friend:one'), controller = store({...initial, friends: {...initial.friends, data: {...initial.friends.data, friends: [accepted]}}}), opened = [];
  h.own(mountFriendsDirectory(h.host, h.runtime, {controller, onProfile: ref => opened.push(ref)}));
  const row = h.host.querySelector('[data-home-person-row="friend:friend:one"]'); h.click(row); assert.equal(h.frames.size, 1);
  controller.set({...controller.getSnapshot(), scopeKey: 'scope:two'}); h.drain(); assert.deepEqual(opened, []);
  h.click(h.host.querySelector('[data-in-page-tab="people"]')); const input = h.host.querySelector('input'); input.focus(); h.input(input, 'Ada');
  assert.equal(controller.calls.length, 0); assert.doesNotMatch(h.host.textContent, /Results for/);
  const current = controller.getSnapshot(); controller.set({...current, mutation: {status: 'idle', target: 'unrelated'}});
  assert.equal(h.host.querySelector('input'), input); assert.equal(h.document.activeElement, input); assert.equal(input.value, 'Ada');
  h.host.querySelector('form').dispatchEvent(new h.c.Event('submit')); assert.deepEqual(plain(controller.calls), [{read: 'members', query: 'Ada'}]);
});

test('friend-request actions reject revoked grants and close only after the accepted relationship is confirmed', async t => {
  const h = fixture(t), {mountFriendRequestDialog} = await load('friend-request.mjs'), incoming = request(), initial = state(), controller = store({...initial, friends: {...initial.friends, data: {...initial.friends.data, requests: [incoming]}}}), closed = [], pending = deferred();
  const calls = []; controller.mutate = (action, target) => {calls.push({action, target}); return pending.promise;};
  h.own(mountFriendRequestDialog(h.host, h.runtime, {controller, requestRef: incoming.request_ref, onClose: options => closed.push(options)}));
  const accept = h.named('Accept request'); const current = controller.getSnapshot(); controller.set({...current, friends: {...current.friends, data: {...current.friends.data, requests: [{...incoming, allowed_actions: {...incoming.allowed_actions, can_accept: false}}]}}});
  h.click(accept); assert.equal(calls.length, 0); controller.set(current); h.click(h.named('Accept request')); assert.equal(calls.length, 1);
  pending.resolve({status: 'ready', action: 'acceptRequest', target: incoming.request_ref}); await settle(); assert.equal(closed.length, 0); assert.match(h.form.textContent, /relationship has not been confirmed/);
  controller.loadFriends = async () => controller.set({...current, friends: {...current.friends, data: {...current.friends.data, requests: [], friends: [person(incoming.account_ref)]}}});
  h.click(h.named('Refresh')); await settle(); assert.equal(closed.length, 1); assert.equal(h.form.hidden, true);
});

test('friend-request profile navigation follows native form retirement and rechecks authority after onClose', async t => {
  const h = fixture(t), {mountFriendRequestDialog} = await load('friend-request.mjs'), incoming = request(), initial = state(), controller = store({...initial, friends: {...initial.friends, data: {...initial.friends.data, requests: [incoming]}}}), events = [];
  let owner; owner = h.own(mountFriendRequestDialog(h.host, h.runtime, {controller, requestRef: incoming.request_ref, onClose() {events.push('close'); owner.dispose();}, onProfile(ref) {assert.equal(h.form.hidden, true); assert.equal(h.form.querySelector('.home-friend-request'), null); events.push(ref);}}));
  h.click(h.named('View profile')); assert.deepEqual(events, ['close', incoming.account_ref]);
  events.length = 0; h.own(mountFriendRequestDialog(h.host, h.runtime, {controller, requestRef: incoming.request_ref, onClose() {controller.set({...controller.getSnapshot(), scopeKey: 'different'});}, onProfile: ref => events.push(ref)}));
  h.click(h.named('View profile')); assert.deepEqual(events, []);
});

test('hostless notifications retain one dialog by key and handle synchronous open failure retirement', async t => {
  const h = fixture(t), {mountFriendNotifications} = await load('friend-notifications-ui.mjs'), incoming = request(), initial = state(), controller = store({...initial, friends: {...initial.friends, data: {...initial.friends.data, requests: [incoming]}}}), producer = store({dialog: null});
  let opens = 0; const runtime = {...h.runtime, openForm(options) {opens++; return h.runtime.openForm(options);}};
  const owner = h.own(mountFriendNotifications({producer})), dialog = {key: 1, runtime, controller, requestRef: incoming.request_ref, onClose() {}};
  producer.set({dialog}); producer.set({dialog: {...dialog}}); assert.equal(opens, 1); assert.equal(h.document.querySelectorAll('.home-friend-request').length, 1);
  producer.set({dialog: {...dialog, key: 2}}); assert.equal(opens, 2); assert.equal(h.document.querySelectorAll('.home-friend-request').length, 1);
  producer.set({dialog: null}); assert.equal(controller.listenerCount(), 0); assert.equal(h.document.querySelectorAll('.home-friend-request').length, 0);
  const count = h.document.body.childNodes.length;
  producer.set({dialog: {...dialog, key: 3, runtime: {...runtime, openForm() {producer.set({dialog: null}); throw new Error('retired source');}}}});
  assert.equal(controller.listenerCount(), 0); assert.equal(h.document.body.childNodes.length, count); owner.dispose(); assert.equal(producer.listenerCount(), 0);
});

test('native comparison keeps joined row selection, clears denied details and returns borrowed header controls intact', async t => {
  const h = fixture(t), {mountComparisonPanel} = await load('comparison.mjs'), controls = h.document.createElement('div'), borrowed = h.document.createElement('button'); borrowed.textContent = 'Borrowed control'; controls.append(borrowed);
  const rows = [{id: 'one', kind: 'track', title: 'One', artist: 'Artist', yours: {listen_count: 2, play_count: 1, rating: 3}, friend: {listen_count: 5, play_count: 2, rating: 4}}, {id: 'two', kind: 'track', title: 'Two', yours: {listen_count: 0, play_count: 0, rating: null}, friend: {listen_count: 1, play_count: 1, rating: 2}}];
  const value = {status: 'ready', data: {rows}}, selections = [], presentations = [], settings = {value, friendRef: 'friend:one', friendName: 'Friend', kind: 'tracks', period: 'week', headerControls: controls, onSelection: selection => selections.push(selection), onPresentationChange: presentation => presentations.push(presentation)};
  const owner = h.own(mountComparisonPanel(h.host, h.runtime, settings));
  assert.equal(h.host.querySelectorAll('[data-comparison-id]').length, 1); h.click(h.host.querySelector('[data-home-comparison-select="one"]'));
  assert.match(h.host.querySelector('.home-comparison__details').textContent, /One/); assert.equal(selections.at(-1).id, 'one');
  const toggle = h.host.querySelector('input'); toggle.checked = false; toggle.dispatchEvent(new h.c.Event('change')); assert.equal(h.host.querySelectorAll('[data-comparison-id]').length, 2);
  owner.update({...settings, value: {status: 'denied', data: null}}); assert.equal(selections.at(-1), null); assert.equal(h.host.querySelectorAll('[data-home-comparison-select]').length, 0); assert.equal(presentations.at(-1).selection, null);
  owner.dispose(); assert.equal(controls.firstElementChild, borrowed); assert.equal(controls.parentNode, null); assert.equal(h.host.childNodes.length, 0);
});
