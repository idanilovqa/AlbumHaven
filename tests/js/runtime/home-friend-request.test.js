const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, buttonNamed: nativeButtonNamed} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const model = import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
const sources = Object.fromEntries(['friend-request', 'member-profile', 'friends-directory'].map(name => [name,
  buildSync({entryPoints: [path.join(repo, `music_app/static/js/home-friends/${name}.jsx`)], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text]));
function load(name, hooks = React) {
  const module = {exports: {}};
  vm.runInNewContext(sources[name], {module, exports: module.exports,
    require: id => id === 'react' ? hooks : require(id), console, URL});
  return module.exports;
}
const {FriendRequestContent} = load('friend-request');
const {MemberProfile} = load('member-profile');
const {FriendsDirectory, MemberResults} = load('friends-directory');
const buttonNamed = (root, label, required = true) => nativeButtonNamed(root, new RegExp(`^${label}$`), required);

// Bounded component/provider fixtures. No live transport, browser, database,
// app boot, or external writer runs in these tests.
function nativeRuntime() {
  const env = createNativeHomeRuntime();
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime/in-page-tabs.js'), 'utf8'), env.context);
  const template = env.document.createElement('script'); template.setAttribute('id', 'navigation-tree-item-template');
  template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  env.document.body.appendChild(template);
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), env.context);
  return {...env, runtime: {
    buttonHtml: value => env.context.ButtonComponent.renderButton(value),
    actionHtml: value => env.context.ButtonComponent.renderActionButton(value),
    alertHtml: value => env.context.buildOnPageAlertHtml(value),
    artboxHtml: value => env.context.buildAlbumArtboxHtml(value),
    tabsHtml: value => env.context.buildInPageTabsHtml(value),
    navigationItemHtml: value => env.context.window.NavigationTree.renderItem(value),
    escapeHtml: env.context.escapeHtml,
  }};
}
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
function render(env, Component, props) {
  const html = renderToStaticMarkup(React.createElement(Component, {runtime: env.runtime, ...props}));
  const host = env.document.createElement('section'); host.innerHTML = html;
  return {html, host};
}

// Executes only the wrapper's hooks and callbacks. Native form teardown itself
// is covered by the native owner tests; this fixture controls its completion.
function lifecycle(source, component) {
  const slots = []; let cursor = 0, effects = [], tree;
  const hooks = {...React,
    useRef(initial) {const index = cursor++; return slots[index] ||= {current: initial};},
    useState(initial) {
      const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {slots[index] = typeof value === 'function' ? value(slots[index]) : value;}];
    },
    useId() {return `fixture-${cursor++}`;},
    useSyncExternalStore(_subscribe, snapshot) {return snapshot();},
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects.push(() => {
        previous?.cleanup?.(); slots[index] = {deps, cleanup: effect()};
      });
    },
    useLayoutEffect(effect, deps) {return hooks.useEffect(effect, deps);},
  };
  const Component = load(source, hooks)[component];
  return {render(props, host) {
    cursor = 0; effects = []; tree = Component(props);
    if (host && tree.props.ref) tree.props.ref.current = host;
    for (const effect of effects) effect(); return tree;
  }, dispose() {for (const slot of slots) slot?.cleanup?.();}};
}
function dialogFixture(controller, options = {}) {
  const env = nativeRuntime(), fixture = lifecycle('friend-request', 'FriendRequestDialog'), closes = [], events = [];
  const props = {runtime: env.runtime, controller, requestRef: 'request:one', parentSurface: '#cover-lookup-drawer',
    returnFocus: () => null, onClose: () => events.push('closed'), onProfile: ref => events.push(ref), ...options};
  const close = options => {closes.push(options); return true;};
  let tree;
  return {...env, closes, events, render() {tree = fixture.render(props); return tree.props.children(close).props;},
    nativeClosed(options = {}) {tree.props.onClose({restoreFocus: false, ...options});}, get ownerProps() {return tree.props;}, dispose: fixture.dispose};
}
function findElement(tree, predicate) {
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree?.props?.children)) {
    const found = findElement(child, predicate); if (found) return found;
  }
  return null;
}
const actionElement = (tree, label) => findElement(tree, node => node?.type?.name === 'Button' && node.props.children === label);

test('incoming request uses shared identity and exact current action grants', async () => {
  const c = await setup(), env = nativeRuntime();
  const {html, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one', onProfile() {}});
  assert.match(html, /Taylor &lt;safe&gt;/); assert.match(html, /home-profile__identity/);
  assert.equal(buttonNamed(host, 'Accept request').disabled, false);
  assert.equal(buttonNamed(host, 'Decline').disabled, false);
  assert.equal(buttonNamed(host, 'View profile').disabled, false);
  assert.equal(buttonNamed(host, 'Cancel request', false), null);
  assert.doesNotMatch(html, /Edit profile|<safe>|localStorage/);
});

test('outgoing request cannot expose incoming actions and unsafe artwork stays empty', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({direction: 'outgoing', avatar_url: 'javascript:alert(1)',
    allowed_actions: {can_cancel: true, can_accept: true, can_decline: true, can_view_profile: false}})]})});
  const env = nativeRuntime(), {html, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one', onProfile() {}});
  assert.match(html, /album-artbox--empty/); assert.doesNotMatch(html, /javascript:|Accept request|>Decline</);
  assert.equal(buttonNamed(host, 'Cancel request').disabled, false);
  assert.equal(buttonNamed(host, 'View profile').disabled, true);
});

test('request without current change grants explains denial through the native status owner', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({allowed_actions: {can_accept: 'true', can_decline: false}})]})});
  const env = nativeRuntime(), {html, host} = render(env, FriendRequestContent, {state: c.getSnapshot(), requestRef: 'request:one'});
  assert.equal(buttonNamed(host, 'Accept request').disabled, true); assert.equal(buttonNamed(host, 'Decline').disabled, true);
  assert.match(host.textContent, /don't have access to Friend request changes/); assert.match(html, /role="status"/);
});

test('fabricated, stale, revoked and loading requests never retain old person facts', async () => {
  const c = await setup(), env = nativeRuntime(), initial = c.getSnapshot();
  for (const status of ['loading', 'error', 'denied', 'unavailable']) {
    const state = {...initial, friends: {status, data: initial.friends.data}};
    const {html} = render(env, FriendRequestContent, {state, requestRef: 'request:one'});
    assert.doesNotMatch(html, /Taylor|taylor.webp|Accept request|View profile/);
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
  }
  const {html} = render(env, FriendRequestContent, {state: initial, requestRef: 'request:invented'});
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
  payload = friends({friends: [friend()], requests: []}); write.resolve(); await first;
  assert.equal(h.closes.length, 1); assert.equal(h.closes[0].reason, 'request-resolved');
  h.dispose();
});

test('missing writer remains open and does not announce success', async () => {
  const c = await setup(), h = dialogFixture(c);
  await h.render().onAction('acceptRequest');
  assert.equal(c.getSnapshot().mutation.status, 'unavailable'); assert.equal(h.closes.length, 0);
  const {html} = render(h, FriendRequestContent, h.render());
  assert.match(html, /not available on this server/); assert.doesNotMatch(html, /now friends|sent, but/);
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
  const {host} = render(h, FriendRequestContent, h.render());
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
  payload = friends({friends: [friend()], requests: []}); write.resolve({ok: true}); await operation;
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
    const {html} = render(nativeRuntime(), MemberProfile, {controller: c, accountRef: 'member:one'});
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
  const rows = render(env, MemberResults, {controller: c, value: {data: {members: [member]}}, onProfile() {}});
  assert.equal(rows.host.querySelector('[data-navigation-tree-item]').disabled, false);
});

test('only the most recently selected member can navigate after row feedback', async () => {
  const members = ['member:one', 'member:two'].map(account_ref => ({...friend({account_ref}), relationship: 'none'}));
  const c = await setup({readMembers: () => ({members, next_cursor: null})}); await c.loadMembers({query: 'Taylor'});
  const env = nativeRuntime(), fixture = lifecycle('friends-directory', 'MemberResults'), opened = [];
  const tree = fixture.render({runtime: env.runtime, controller: c, value: c.getSnapshot().members, onProfile: ref => opened.push(ref)});
  const rows = members.map(person => findElement(tree, node => node?.type?.name === 'PersonNavigation' && node.props.person.account_ref === person.account_ref));
  rows[0].props.onSelect(); rows[1].props.onSelect();
  rows[0].props.onActivate(null); rows[1].props.onActivate(null);
  assert.deepEqual(opened, ['member:two']); fixture.dispose();
});

test('directory never labels an acknowledged but unresolved cancellation complete', async () => {
  const c = await setup({readFriends: () => friends({requests: [request({direction: 'outgoing', allowed_actions: {can_cancel: true}})]}),
    cancelRequest: () => ({ok: true})});
  await c.mutate('cancelRequest', 'request:one');
  const {html, host} = render(nativeRuntime(), FriendsDirectory, {controller: c});
  assert.doesNotMatch(html, /Friend request cancelled/); assert.match(html, /not been confirmed/);
  assert.equal(buttonNamed(host, 'Cancel request').disabled, true); assert.ok(buttonNamed(host, 'Refresh Friends'));
});

test('an authoritative empty envelope confirms cancellation without fabricated relationship rows', async () => {
  let cancelled = false;
  const c = await setup({readFriends: () => cancelled ? {status: 'empty', data: null}
    : friends({requests: [request({direction: 'outgoing', allowed_actions: {can_cancel: true}})]}),
    cancelRequest: () => {cancelled = true; return {ok: true};}});
  await c.mutate('cancelRequest', 'request:one');
  const {html} = render(nativeRuntime(), FriendsDirectory, {controller: c});
  assert.match(html, /Friend request cancelled/); assert.doesNotMatch(html, /not been confirmed|Taylor/);
});

test('Unfriend rechecks the exact current friendship after native confirmation', async () => {
  const confirmation = deferred(); let confirms = 0, writes = 0, payload = friends({friends: [friend()], requests: []});
  const c = await setup({readFriends: () => payload, removeFriend: () => {writes++; return {ok: true};}});
  const env = nativeRuntime(), fixture = lifecycle('friends-directory', 'FriendsDirectory');
  const root = env.document.createElement('section'), trigger = env.document.createElement('button'); root.append(trigger); env.document.body.append(root);
  const runtime = {...env.runtime, confirm: (_message, options) => {confirms++; assert.equal(options.acceptLabel, 'Unfriend'); assert.equal(options.danger, true); return confirmation.promise;}};
  const props = {runtime, controller: c};
  const button = actionElement(fixture.render(props, root), 'Unfriend');
  const first = button.props.onClick(env.event('click', trigger));
  await button.props.onClick(env.event('click', trigger)); assert.equal(confirms, 1);
  payload = friends({friends: [friend({allowed_actions: {can_remove: false}})], requests: []}); await c.loadFriends();
  confirmation.resolve(true); await first;
  assert.equal(writes, 0); assert.match(render(env, FriendsDirectory, {controller: c}).html, /Friends/);
  fixture.dispose();
});

test('confirmed removal restores the connected directory when its opener disappears', async () => {
  let payload = friends({friends: [friend()], requests: []}), writes = 0;
  const env = nativeRuntime(), root = env.document.createElement('section'), trigger = env.document.createElement('button'), focused = [];
  root.append(trigger); env.document.body.append(root); root.focus = () => focused.push(root);
  const c = await setup({readFriends: () => payload, removeFriend: () => {
    writes++; trigger.remove(); payload = friends({friends: [], requests: []}); return {ok: true};
  }});
  const fixture = lifecycle('friends-directory', 'FriendsDirectory');
  const tree = fixture.render({runtime: {...env.runtime, confirm: () => Promise.resolve(true)}, controller: c}, root);
  await actionElement(tree, 'Unfriend').props.onClick(env.event('click', trigger));
  assert.equal(writes, 1); assert.deepEqual(focused, [root]); fixture.dispose();
});

test('native person row preserves its button and rejects delayed activation after revocation', () => {
  const env = nativeRuntime(), pending = new Map(); let sequence = 0, selected = 0, opens = 0;
  env.document.defaultView = {requestAnimationFrame: callback => {pending.set(++sequence, callback); return sequence;},
    cancelAnimationFrame: id => pending.delete(id)};
  const root = env.document.createElement('section'); env.document.body.append(root);
  const fixture = lifecycle('friends-directory', 'PersonNavigation');
  const props = {runtime: env.runtime, person: friend(), rowKey: 'friend:member:one', selected: false, disabled: false,
    onSelect: () => {selected++;}, onActivate: () => {opens++;}};
  const tree = fixture.render(props, root), button = root.querySelector('[data-navigation-tree-item]');
  tree.props.onClick(env.event('click', button)); assert.equal(selected, 1); assert.equal(opens, 0);
  fixture.render({...props, selected: true, disabled: true}, root);
  assert.equal(root.querySelector('[data-navigation-tree-item]'), button); assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-current'), 'true');
  while (pending.size) {const next = pending.entries().next().value; pending.delete(next[0]); next[1]();}
  assert.equal(opens, 0); fixture.dispose(); assert.equal(pending.size, 0);
});

test('profile activity callback rechecks accepted source grants after the button was rendered', async () => {
  let payload = friends({friends: [friend()], requests: []}), opens = 0;
  const c = await setup({readFriends: () => payload}); c.selectProfile('member:one'); await c.loadProfile();
  const env = nativeRuntime(), fixture = lifecycle('member-profile', 'MemberProfile');
  const tree = fixture.render({runtime: env.runtime, controller: c, accountRef: 'member:one', onActivity: () => {opens++;}, showIdentity: false});
  const button = actionElement(tree, 'Listening activity'); assert.ok(button);
  assert.equal(findElement(tree, node => node?.type?.name === 'ProfileIdentity'), null);
  payload = friends({friends: [friend({allowed_actions: {can_view_profile: true}})], requests: []}); await c.loadFriends();
  button.props.onClick(); assert.equal(opens, 0); fixture.dispose();
});
