const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const model = import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/model.mjs')));
// Source-level provider and SSR fixtures only. No live account, transport,
// database, browser, endpoint, or successful external write is simulated.
const member = (account_ref = 'member:one', overrides = {}) => ({account_ref, display_name: 'Taylor <safe>',
  handle: 'taylor', avatar_url: '/avatars/taylor.webp', relationship: 'none', allowed_actions: {can_request: true}, ...overrides});
const members = (overrides = {}) => ({members: [member()], next_cursor: null, ...overrides});
const request = (overrides = {}) => ({request_ref: 'request:one', display_name: 'Taylor', handle: 'taylor', direction: 'outgoing',
  allowed_actions: {can_cancel: true}, ...overrides});
const friends = (overrides = {}) => ({friends: [], requests: [request()], profile: null,
  allowed_actions: {can_discover_members: true}, ...overrides});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function setup(providers = {}) {
  const {createHomeFriendsController} = await model;
  const controller = createHomeFriendsController({providers: {readFriends: () => friends(), readMembers: () => members(), ...providers}});
  await controller.loadFriends();
  return controller;
}

const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/friends-directory.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']});
const Module = require('node:module');
const loaded = new Module(path.join(__dirname, 'home-members-fixture.cjs'), module);
loaded.filename = loaded.id; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {FriendsDirectory, MemberSearch, MemberResults} = loaded.exports;
const native = createNativeHomeRuntime();
vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime/in-page-tabs.js'), 'utf8'), native.context);
const navTemplate = native.document.createElement('script');
navTemplate.setAttribute('id', 'navigation-tree-item-template');
navTemplate.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
native.document.body.appendChild(navTemplate);
vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), native.context);
const runtime = {
  buttonHtml: config => native.context.ButtonComponent.renderButton(config),
  actionHtml: config => native.context.ButtonComponent.renderActionButton(config),
  alertHtml: config => native.context.buildOnPageAlertHtml(config),
  tabsHtml: config => native.context.buildInPageTabsHtml(config),
  escapeHtml: native.context.escapeHtml,
  artboxHtml: config => native.context.buildAlbumArtboxHtml(config),
  navigationItemHtml: config => native.context.window.NavigationTree.renderItem(config),
};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));

test('member discovery never runs on construction, friends load, selection, or SSR', async () => {
  let reads = 0;
  const c = await setup({readMembers: () => {reads++; return members();}});
  c.selectFriend(null);
  assert.equal(c.getSnapshot().members.status, 'unavailable'); assert.equal(c.getSnapshot().memberQuery, null);
  render(FriendsDirectory, {controller: c});
  const html = render(MemberSearch, {controller: c, state: c.getSnapshot()});
  assert.equal(reads, 0); assert.match(html, /Search by name or handle/); assert.match(html, /maxlength="100"/i);
  assert.match(html, />Search</); assert.match(html, /then choose Search/);
  await c.loadMembers({query: 'Taylor'}); assert.equal(reads, 1);
});

test('missing member provider is unavailable with no fabricated rows', async () => {
  const c = await setup({readMembers: undefined});
  const pending = c.loadMembers({query: 'Taylor'});
  assert.deepEqual(c.getSnapshot().members, {status: 'unavailable', data: null});
  assert.equal(c.getSnapshot().memberQuery, 'Taylor'); await pending;
});

test('member reads require the exact current top-level discovery grant', async () => {
  for (const allowed_actions of [{}, {can_request: true}, {can_discover_members: false}, {can_discover_members: 'true'},
    {can_discover_members: 1}, Object.create({can_discover_members: true})]) {
    const c = await setup({readFriends: () => friends({allowed_actions}), readMembers: () => assert.fail('Discovery is not granted')});
    assert.equal((await c.loadMembers({query: 'Taylor'})).status, 'denied');
    assert.equal(c.getSnapshot().members.data, null);
  }
});

test('member queries are bounded, nonblank and control-free before any read', async () => {
  const {validMemberQuery} = await model;
  for (const query of [null, undefined, 17, '', '  ', 'a'.repeat(101), ' '.repeat(101) + 'a', 'line\nname', '\tname', 'null\0name', 'del\x7fname', 'c1\x85name']) {
    assert.equal(validMemberQuery(query), false);
    const c = await setup({readMembers: () => assert.fail('Invalid search cannot reach provider')});
    assert.equal((await c.loadMembers({query})).status, 'error');
    assert.equal(c.getSnapshot().memberQuery, null);
  }
  for (const query of ['Taylor', '@taylor', '李 明', 'é', 'a'.repeat(100), '  Taylor  ']) assert.equal(validMemberQuery(query), true);
  const c = await setup({readMembers: () => assert.fail('Invalid options cannot reach provider')});
  for (const options of [null, {}, {query: 'Taylor', cursor: ''}, {query: 'Taylor', cursor: 1}]) {
    assert.equal((await c.loadMembers(options)).status, 'error');
  }
});

test('search forwards only the trimmed query, explicit page, scope and abort signal', async () => {
  let input;
  const c = await setup({readMembers: args => {input = args; return members({next_cursor: 'cursor:two'});}});
  c.setScope('self/library'); await c.loadFriends();
  await c.loadMembers({query: '  Taylor  ', cursor: 'cursor:one', account_ref: 'ignore'});
  const {signal, ...args} = input;
  assert.deepEqual(args, {scopeKey: 'self/library', query: 'Taylor', cursor: 'cursor:one'}); assert.ok(signal instanceof AbortSignal);
  assert.equal(c.getSnapshot().memberQuery, 'Taylor'); assert.equal(c.getSnapshot().members.data.next_cursor, 'cursor:two');
});

test('members normalize text, safe avatars and exact grants without retaining extra fields', async () => {
  const raw = member('member:one', {display_name: {html: '<bad>'}, handle: 12, avatar_url: 'javascript:alert(1)',
    allowed_actions: {can_request: 'true', can_view_activity: true}, private_path: '/private/file'});
  const c = await setup({readMembers: () => members({members: [raw]})}); await c.loadMembers({query: 'one'});
  const person = c.getSnapshot().members.data.members[0];
  assert.equal(person.display_name, ''); assert.equal(person.handle, ''); assert.equal(person.avatar_url, null);
  assert.deepEqual(person.allowed_actions, {can_view_profile: false, can_request: false}); assert.equal(Object.hasOwn(person, 'private_path'), false);
  raw.allowed_actions.can_request = true;
  assert.equal(person.allowed_actions.can_request, false); assert.equal(Object.isFrozen(person), true);
  assert.equal(Object.isFrozen(person.allowed_actions), true); assert.equal(Object.isFrozen(c.getSnapshot().members.data.members), true);
});

for (const [label, data] of [
  ['null data', null], ['missing array', {}], ['sparse rows', members({members: Array(1)})],
  ['nonobject row', members({members: [null]})], ['empty identity', members({members: [member(' ')]})],
  ['duplicate identity', members({members: [member(), member()]})], ['unknown relationship', members({members: [member('one', {relationship: 'pending'})]})],
  ['missing relationship', members({members: [member('one', {relationship: undefined})]})], ['invalid cursor', members({next_cursor: false})],
  ['too many rows', members({members: Array.from({length: 101}, (_, i) => member(`member:${i}`))})],
  ['nonempty empty envelope', {status: 'empty', data: members()}],
]) test(`invalid member page fails closed: ${label}`, async () => {
  const c = await setup({readMembers: () => data});
  assert.equal((await c.loadMembers({query: 'Taylor'})).status, 'error'); assert.equal(c.getSnapshot().members.data, null);
});

test('member empty, denied and unavailable envelopes do not expose supplied private records', async () => {
  for (const [result, status] of [[members({members: []}), 'empty'], [{status: 'empty', data: null}, 'empty'],
    [{status: 'denied', data: members()}, 'denied'], [{status: 'unavailable', data: members()}, 'unavailable']]) {
    const c = await setup({readMembers: () => result}); await c.loadMembers({query: 'Taylor'});
    assert.equal(c.getSnapshot().members.status, status);
    if (status !== 'empty') assert.equal(c.getSnapshot().members.data, null);
  }
});

test('member read errors distinguish authorization denial and erase previous results', async () => {
  for (const status of [401, 403, 500]) {
    let fail = false;
    const c = await setup({readMembers: () => {if (fail) throw Object.assign(new Error('Private error detail'), {status}); return members();}});
    await c.loadMembers({query: 'Taylor'}); fail = true; await c.loadMembers({query: 'Taylor'});
    assert.deepEqual(c.getSnapshot().members, {status: status === 500 ? 'error' : 'denied', data: null});
    assert.equal(JSON.stringify(c.getSnapshot()).includes('Private error detail'), false);
  }
});

for (const lateError of [false, true]) test(`new member search aborts and ignores older ${lateError ? 'error' : 'data'}`, async () => {
  const pending = deferred(); let oldSignal;
  const c = await setup({readMembers: ({query, signal}) => {if (query === 'old') {oldSignal = signal; return pending.promise;} return members();}});
  const old = c.loadMembers({query: 'old'}); await c.loadMembers({query: 'new'}); const newest = c.getSnapshot();
  assert.equal(oldSignal.aborted, true); assert.equal(newest.memberQuery, 'new');
  if (lateError) pending.reject(Object.assign(new Error('Late denial'), {status: 403})); else pending.resolve(members({members: [member('stale')]}));
  await old; assert.equal(c.getSnapshot(), newest);
});

test('member cursor pages replace rows rather than merging identities or queries', async () => {
  const c = await setup({readMembers: ({cursor}) => members({members: [member(cursor || 'first')], next_cursor: cursor ? null : 'second'})});
  await c.loadMembers({query: 'Taylor'}); await c.loadMembers({query: 'Taylor', cursor: 'second'});
  assert.deepEqual(c.getSnapshot().members.data.members.map(row => row.account_ref), ['second']);
  assert.equal(c.getSnapshot().members.data.next_cursor, null);
});

test('scope, provider replacement and disposal abort member reads and erase old results', async () => {
  for (const reset of [c => c.setScope('new'), c => c.configure({}), c => c.dispose()]) {
    const pending = deferred(); let signal;
    const c = await setup({readMembers: args => {signal = args.signal; return pending.promise;}});
    const old = c.loadMembers({query: 'Taylor'}); reset(c); const newest = c.getSnapshot();
    assert.equal(signal.aborted, true); assert.equal(newest.members.data, null); assert.equal(newest.memberQuery, null);
    pending.resolve(members()); await old; assert.equal(c.getSnapshot(), newest);
  }
});

test('friends refresh clears member rows immediately and cannot restore a revoked search', async () => {
  const pending = deferred(), refresh = deferred(); let reads = 0, signal;
  const c = await setup({readFriends: () => ++reads === 1 ? friends() : refresh.promise,
    readMembers: args => {signal = args.signal; return pending.promise;}});
  const old = c.loadMembers({query: 'Taylor'}), updated = c.loadFriends();
  assert.equal(signal.aborted, true); assert.equal(c.getSnapshot().memberQuery, null);
  refresh.resolve(friends({allowed_actions: {can_discover_members: false}})); await updated;
  assert.equal(c.getSnapshot().members.status, 'denied'); const newest = c.getSnapshot();
  pending.resolve(members()); await old; assert.equal(c.getSnapshot(), newest);
});

test('member requests require a current discovered none relationship and exact row grant', async () => {
  for (const relationship of ['self', 'blocked', 'accepted', 'incoming_pending', 'outgoing_pending']) {
    const c = await setup({readMembers: () => members({members: [member('member:one', {relationship})]}),
      requestMember: () => assert.fail('This relationship cannot request')});
    await c.loadMembers({query: 'Taylor'}); assert.equal((await c.mutate('requestMember', 'member:one')).status, 'denied');
  }
  for (const allowed_actions of [{}, {can_request: false}, {can_request: 1}, {can_request: 'true'}, Object.create({can_request: true})]) {
    const c = await setup({readMembers: () => members({members: [member('member:one', {allowed_actions})]}),
      requestMember: () => assert.fail('Row is not granted')});
    await c.loadMembers({query: 'Taylor'}); assert.equal((await c.mutate('requestMember', 'member:one')).status, 'denied');
  }
  const c = await setup({requestMember: () => assert.fail('Unknown identity cannot request')});
  assert.equal((await c.mutate('requestMember', 'member:one')).status, 'denied');
  await c.loadMembers({query: 'Taylor'}); assert.equal((await c.mutate('requestMember', 'other')).status, 'denied');
});

test('outgoing cancellation requires its current exact grant and cannot cancel incoming requests', async () => {
  for (const row of [request({direction: 'incoming'}), request({allowed_actions: {can_cancel: false}}),
    request({allowed_actions: {can_cancel: 'true'}}), request({allowed_actions: Object.create({can_cancel: true})})]) {
    const c = await setup({readFriends: () => friends({requests: [row]}), cancelRequest: () => assert.fail('Cancellation is not granted')});
    assert.equal((await c.mutate('cancelRequest', 'request:one')).status, 'denied');
  }
  const c = await setup({cancelRequest: () => assert.fail('Unknown request cannot cancel')});
  assert.equal((await c.mutate('cancelRequest', 'request:other')).status, 'denied');
});

test('member and cancel writes pass only opaque targets then reset members and refresh friends', async () => {
  for (const [action, target, payload] of [['requestMember', 'member:one', {account_ref: 'member:one'}], ['cancelRequest', 'request:one', {request_ref: 'request:one'}]]) {
    let input, reads = 0;
    const c = await setup({readFriends: () => {reads++; return friends();}, [action]: args => {input = args; return {ok: true, members: [member('fake')]};}});
    await c.loadMembers({query: 'Taylor'});
    assert.equal((await c.mutate(action, target, {handle: 'ignored'})).status, 'ready');
    const {scopeKey, signal, ...args} = input; assert.deepEqual(args, payload); assert.ok(signal instanceof AbortSignal);
    assert.equal(reads, 2); assert.equal(c.getSnapshot().members.data, null); assert.equal(c.getSnapshot().memberQuery, null);
  }
});

test('missing or unacknowledged member writers never report success', async () => {
  for (const action of ['requestMember', 'cancelRequest']) {
    for (const [provider, expected] of [[undefined, 'unavailable'], [() => undefined, 'error'], [() => ({ok: false}), 'error']]) {
      let reads = 0;
      const c = await setup({readFriends: () => {reads++; return friends();}, [action]: provider});
      await c.loadMembers({query: 'Taylor'});
      assert.equal((await c.mutate(action, action === 'requestMember' ? 'member:one' : 'request:one')).status, expected);
      assert.equal(reads, 1);
    }
  }
});

for (const action of ['requestMember', 'cancelRequest']) test(`duplicate ${action} writes remain blocked through authoritative friends refresh`, async () => {
  const write = deferred(), refresh = deferred(); let writes = 0, reads = 0;
  const target = action === 'requestMember' ? 'member:one' : 'request:one';
  const c = await setup({readFriends: () => ++reads === 1 ? friends() : refresh.promise, [action]: () => {writes++; return write.promise;}});
  await c.loadMembers({query: 'Taylor'});
  const first = c.mutate(action, target); await c.mutate(action, target);
  assert.equal(writes, 1); assert.equal(c.getSnapshot().members.data.members[0].relationship, 'none');
  write.resolve({ok: true}); await Promise.resolve();
  assert.equal(c.getSnapshot().mutation.status, 'loading'); assert.equal(c.getSnapshot().members.data, null);
  await c.mutate(action, target); assert.equal(writes, 1);
  refresh.resolve(friends()); await first; assert.equal(c.getSnapshot().mutation.status, 'ready');
});

test('a denied relationship write aborts discovery and prevents stale private results', async () => {
  const read = deferred(), write = deferred(); let count = 0, signal;
  const c = await setup({readMembers: args => {if (++count === 1) return members(); signal = args.signal; return read.promise;},
    requestMember: () => write.promise});
  await c.loadMembers({query: 'Taylor'});
  const mutation = c.mutate('requestMember', 'member:one'), pending = c.loadMembers({query: 'New'});
  write.resolve({status: 'denied'}); await mutation; const denied = c.getSnapshot();
  assert.equal(signal.aborted, true); assert.equal(denied.members.status, 'denied'); assert.equal(denied.memberQuery, null);
  read.resolve(members()); await pending; assert.equal(c.getSnapshot(), denied);
});

test('scope changes cancel outgoing writes with no late cross-account refresh', async () => {
  for (const action of ['requestMember', 'cancelRequest']) {
    const write = deferred(); let signal, reads = 0;
    const c = await setup({readFriends: () => {reads++; return friends();}, [action]: args => {signal = args.signal; return write.promise;}});
    await c.loadMembers({query: 'Taylor'});
    const pending = c.mutate(action, action === 'requestMember' ? 'member:one' : 'request:one'); c.setScope('new');
    const newest = c.getSnapshot(); assert.equal(signal.aborted, true);
    write.resolve({ok: true}); await pending; assert.equal(c.getSnapshot(), newest); assert.equal(reads, 1);
  }
});

test('member rows escape identities, use native artwork and only expose permitted requests', async () => {
  const c = await setup(); await c.loadMembers({query: 'Taylor'});
  const html = render(MemberResults, {controller: c, value: c.getSnapshot().members, busy: false});
  assert.match(html, /Taylor &lt;safe&gt;/); assert.match(html, /album-artbox--ready/); assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /Send request/); assert.match(html, /ui-button/); assert.doesNotMatch(html, /<safe>/);
  for (const person of [member('one', {relationship: 'accepted'}), member('one', {allowed_actions: {can_request: false}})]) {
    assert.doesNotMatch(render(MemberResults, {controller: c, value: {data: {members: [person]}}}), /Send request/);
  }
});

test('member result statuses remain separate from the editable query and render native alerts', async () => {
  const c = await setup();
  for (const status of ['loading', 'empty', 'denied', 'unavailable', 'error']) {
    const state = {...c.getSnapshot(), memberQuery: 'Taylor <safe>', members: {status, data: null}};
    const html = render(MemberSearch, {controller: c, state});
    assert.match(html, /Results for “Taylor &lt;safe&gt;”/);
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
    assert.equal(html.includes('>Retry<'), status === 'error');
    if (status === 'empty') assert.match(html, /No people match this search/);
  }
});

test('directory uses native Friends/People tabs and only exact outgoing cancellation grants', async () => {
  for (const allowed_actions of [{can_cancel: true}, {can_cancel: false}, {can_cancel: 'true'}]) {
    const c = await setup({readFriends: () => friends({requests: [request({allowed_actions})]})});
    const html = render(FriendsDirectory, {controller: c});
    assert.match(html, /data-in-page-tab="friends"/); assert.match(html, /data-in-page-tab="people"/); assert.match(html, /Pending<\/span>/);
    assert.equal(html.includes('Cancel request'), allowed_actions.can_cancel === true);
    assert.doesNotMatch(html, /Find by handle|>Accept<|>Decline</);
  }
});

test('directory retains mutation errors inside its desktop dialog content', async () => {
  const c = await setup(); await c.mutate('cancelRequest', 'request:one');
  const html = render(FriendsDirectory, {controller: c});
  assert.match(html, /Friend changes are not available/);
  assert.doesNotMatch(html, /Friend request sent|Friend request cancelled/);
});

test('directory acknowledges requests and resolved cancellations only after an explicit provider success', async () => {
  for (const [action, target, message] of [['requestMember', 'member:one', 'Friend request sent'], ['cancelRequest', 'request:one', 'Friend request cancelled']]) {
    let changed = false;
    const c = await setup({readFriends: () => friends(changed && action === 'cancelRequest' ? {requests: []} : {}),
      [action]: () => {changed = true; return {ok: true};}}); await c.loadMembers({query: 'Taylor'});
    assert.doesNotMatch(render(FriendsDirectory, {controller: c}), /Friend request sent|Friend request cancelled/);
    await c.mutate(action, target);
    assert.ok(render(FriendsDirectory, {controller: c}).includes(message));
    c.setScope('new'); assert.doesNotMatch(render(FriendsDirectory, {controller: c}), /Friend request sent|Friend request cancelled/);
  }
});
