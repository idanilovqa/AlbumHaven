'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');
const goal = '11111111-1111-4111-8111-111111111111', album = '22222222-2222-4222-8222-222222222222', cycle = '33333333-3333-4333-8333-333333333333';
function value(populated = false) {
  const periods = Object.fromEntries(['week','month','six-months','year'].map(period => [period, {
    top_ref: populated ? goal : null, period, cycle: populated ? {cycle_id: cycle, started_at: '2026-12-01T00:00:00Z',
      start_date: '2026-12-01', due_date: '2027-01-01', timezone_name: 'UTC'} : null,
    album_refs: populated ? [album] : [], manual_completed_at: populated ? {[album]: null} : {}, total: populated ? 1 : 0, completed: 0, percent: 0,
  }]));
  return {goal_ref: populated ? goal : null, revision: populated ? '2' : '1', periods, albums: populated ? [{catalog_ref: album,
    title: 'Remote Album', artist_display: 'Artist', first_release_date: null, primary_type: null}] : [],
    allowed_actions: {can_read: true, can_add: true, can_reset: true}};
}
function transport(initial) {
  let context = 'a'.repeat(64), data = initial, pending = null;
  const listeners = new Set(), requests = [];
  return {requests, listeners, context: () => context,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async request(path, options) {requests.push({path, options}); const result = pending ? await pending.promise : data;
      if (options.isCurrent && !options.isCurrent()) throw Object.assign(new Error('retired'), {name: 'AbortError'});
      return {status: 'ready', context_ref: context, data: result};},
    change() {context = 'b'.repeat(64); for (const fn of [...listeners]) fn();},
    defer(next) {pending = next;}, set(next) {data = next; pending = null;},
  };
}
async function mounted(t, data) {
  const h = fixture(t), {mountGoalsPanel} = await load('goals.mjs');
  const header = {actions: h.add('goals-actions'), content: h.add('goals-content')}, wire = transport(data);
  const owner = h.own(mountGoalsPanel(h.host, h.runtime, {transport: wire, header, isCurrent: () => true}));
  await settle(); h.drain(); return {...h, header, wire, owner};
}

test('Goals empty copy has no empty progress or misleading admission/play/share action', async t => {
  const h = await mounted(t, value());
  assert.match(h.host.textContent, /The goals were not set/);
  assert.equal(h.header.content.querySelector('.album-progress').hidden, true);
  assert.equal(h.header.content.querySelector('[role="progressbar"]'), null);
  for (const label of ['Start','Add','Play Top','Share','Reset']) assert.equal(h.named(label), undefined);
  assert.deepEqual(h.wire.requests.map(row => row.path), ['/account/goals']);
});

test('Goals reuses canonical progress and compact selected period Choice with This year', async t => {
  const h = await mounted(t, value(true));
  const track = h.header.content.querySelector('[role="progressbar"]');
  assert.equal(track.getAttribute('aria-valuemax'), '1'); assert.equal(track.getAttribute('aria-valuenow'), '0');
  assert.equal(h.header.content.querySelector('.album-progress').hidden, false);
  assert.match(h.host.textContent, /Remote Album/);
  const card = h.host.querySelector('.album-card');
  assert.equal(card.getAttribute('data-gallery-card-interaction'), 'none');
  assert.equal(card.querySelector('[data-album-artbox-state]').getAttribute('data-album-artbox-state'), 'missing');
  assert.equal(card.querySelector('button'), null); assert.equal(card.querySelector('img'), null);
  assert.ok(h.host.querySelector('.home-recent__body')); assert.ok(h.host.querySelector('.home-recent__rows'));
  assert.equal(h.header.actions.querySelectorAll('button')[0].getAttribute('aria-label'), 'Reset');
  assert.ok(h.named('Reset').querySelector('svg'));
  assert.equal(h.named('Period: 1 week').querySelectorAll('path').at(-1).getAttribute('d'), 'M8 12h8M8 15h8M8 18h8');
  h.click(h.named('Period: 1 week'));
  const options = h.document.querySelectorAll('[role="menuitemradio"]');
  assert.ok(options.some(option => option.getAttribute('aria-checked') === 'true' && /1 week/.test(option.textContent)));
  const year = options.find(option => /This year/.test(option.textContent)); assert.ok(year); h.click(year);
  assert.equal(h.named('Period: This year').querySelectorAll('path').at(-1).getAttribute('d'), 'm9 12 3 3 3-3m-3 3v4');
  assert.ok(h.named('Period: This year')); assert.equal(h.wire.requests.length, 1);
  assert.equal(h.host.querySelector('.album-card'), card, 'Unchanged canonical card is retained across periods');
});

test('Real Reset dialog preserves explanatory retention copy and cancellation makes no write', async t => {
  const h = await mounted(t, value(true));
  h.click(h.named('Reset')); h.drain();
  assert.match(h.document.body.textContent, /Keep all albums and clear completion for this period/);
  assert.match(h.document.body.textContent, /Other periods and history stay unchanged/);
  h.click(h.named('Cancel')); h.drain();
  assert.deepEqual(h.wire.requests.map(row => row.path), ['/account/goals']);
});

test('Changed continuity clears private rows and saved Reset cannot submit', async t => {
  const h = await mounted(t, value(true)), reset = h.named('Reset');
  h.wire.change(); await settle();
  assert.equal(h.host.querySelector('[data-goal-album-ref]'), null);
  assert.equal(h.header.content.querySelector('[role="progressbar"]'), null);
  h.click(reset); assert.equal(h.wire.requests.filter(row => row.options.method === 'POST').length, 0);
});

test('Disposal during pending read prevents rows and releases canonical controls and transport subscription', async t => {
  const h = fixture(t), {mountGoalsPanel} = await load('goals.mjs'), wire = transport(value(true)), wait = deferred(); wire.defer(wait);
  const header = {actions: h.add('goals-actions'), content: h.add('goals-content')};
  const owner = h.own(mountGoalsPanel(h.host,h.runtime,{transport:wire,header,isCurrent:()=>true}));
  assert.equal(wire.listeners.size, 1); owner.dispose(); owner.dispose(); wait.resolve(value(true)); await settle();
  assert.equal(wire.listeners.size, 0); assert.equal(h.host.textContent, '');
  assert.equal(header.actions.childNodes.length, 0); assert.equal(header.content.childNodes.length, 0);
});

test('Provider rejects partial or inconsistent period totals and detaches authoritative nullable metadata', async () => {
  const {normalizeGoals} = await load('goals-provider.mjs'), dto = value(true), normalized = normalizeGoals(dto);
  assert.equal(normalized.albums[0].first_release_date, null); assert.ok(Object.isFrozen(normalized.periods.year));
  dto.albums[0].title = 'mutated'; assert.equal(normalized.albums[0].title, 'Remote Album');
  for (const mutate of [data => {delete data.periods.year;}, data => {data.periods.week.total = 2;},
    data => {data.periods.week.completed = 1;}, data => {data.periods.week.album_refs.push(album);},
    data => {data.periods.week.album_refs[0] = goal;}]) {const data=value(true); mutate(data); assert.throws(()=>normalizeGoals(data));}
});

test('Actual Home mounts Goals only for own section and restores Recent and Queue headers', async t => {
  const h = fixture(t), {createHomeFriendsController} = await load('model.mjs'), {mountHomeFriendsView} = await load('app.mjs');
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const {requireOwner} = require('./native-home-harness.cjs');
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/home-recent.js'), 'utf8'), h.context);
  const recentOwner = requireOwner(h, 'HomeRecent');
  h.runtime.mountRecent = (host, options) => recentOwner.mount(host, options);
  const controller = createHomeFriendsController({readRecent: async () => ({recent_local_albums: [], recent_not_local_albums: []}),
    providers: {readFriends: async () => ({profile: {display_name: 'Me', handle: 'me', bio: '', allowed_actions: {}},
      friends: [], requests: [], allowed_actions: {}})}});
  controller.setScope('home:one'); await controller.loadFriends(); await controller.loadRecent();
  const wire = transport(value(true));
  Object.assign(h.runtime, {snapshot: () => ({scopeKey: 'home:one'}), savePresentation() {}, navigate() {}});
  let props = {runtime: h.runtime, controller, state: controller.getSnapshot(), goalsTransport: wire,
    shell: {section: 'recent', friendRef: '', profileRef: '', accountName: 'Me', presentation: {homeSection: 'goals'}}}, owner;
  const unsubscribe = controller.subscribe(() => {props = {...props, state: controller.getSnapshot()}; owner?.update(props);});
  t.after(() => {unsubscribe(); controller.dispose();});
  owner = h.own(mountHomeFriendsView(h.host, props)); await settle(); h.drain();
  assert.match(h.host.textContent, /Remote Album/); assert.ok(h.named('Period: 1 week'));
  assert.equal(wire.listeners.size, 1);
  const page = h.host.querySelector('.home-friends__page-header'), recent = h.host.querySelector('.home-friends__recent-header');
  assert.ok(page.querySelector('.home-header__identity').textContent.includes('Me'));
  assert.ok(page.querySelector('.home-header__primary-actions').contains(h.named('Reset')));
  assert.ok(page.querySelector('.home-header__primary-actions').contains(h.named('Period: 1 week')));
  assert.equal(page.querySelector('.home-header__primary-actions').querySelectorAll('button')[0], h.named('Reset'));
  assert.equal(recent.contains(h.named('Period: 1 week')), false);
  assert.ok(recent.querySelector('[role="progressbar"]'));
  assert.ok(h.host.querySelector('[aria-label="Goals"]'));
  h.click(h.named('Recent')); await settle(); h.drain();
  assert.equal(wire.listeners.size, 0); assert.equal(h.host.querySelector('[data-goal-album-ref]'), null);
  assert.ok(h.named('Period: Last week')); assert.equal(h.named('Reset'), undefined);
  h.click(h.named('Queue')); await settle(); h.drain();
  assert.equal(h.named('Period: 1 week'), undefined); assert.equal(h.named('Reset'), undefined);
  props = {...props, shell: {...props.shell, section: 'friends'}}; owner.update(props); await settle(); h.drain();
  assert.equal(h.named('Goals'), undefined); assert.equal(wire.listeners.size, 0);
});

test('Actual private transport rejects stale and foreign-marker Goals responses before projection', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const {createGoalsProvider} = await load('goals-provider.mjs');
  const shell = {dataset: {privateUiContext: 'a'.repeat(64)}}, replies = [], requests = [];
  const c = vm.createContext({document: {getElementById: () => shell}, URLSearchParams,
    fetch: async (target, options) => {requests.push({target, options}); return replies.shift().promise;}});
  c.window = c;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/private-ui-transport.js'), 'utf8'), c);
  const provider = createGoalsProvider(c.AlbumHavenPrivateUITransport);
  try {
    let wait = deferred(); replies.push(wait); const stale = provider.read();
    shell.dataset.privateUiContext = 'b'.repeat(64);
    wait.resolve({ok: true, json: async () => ({status: 'ready', context_ref: 'a'.repeat(64), data: value(true)})});
    await assert.rejects(stale, error => error.name === 'AbortError');
    assert.equal(requests[0].options.headers['X-AlbumHaven-Context'], 'a'.repeat(64));
    assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.credentials, 'same-origin');
    wait = deferred(); replies.push(wait); const foreign = provider.read();
    wait.resolve({ok: true, json: async () => ({status: 'ready', context_ref: 'c'.repeat(64), data: value(true)})});
    await assert.rejects(foreign, error => error.code === 'stale_context');
    assert.throws(() => c.AlbumHavenPrivateUITransport.context(), error => error.code === 'stale_context');
  } finally {provider.dispose();}
});

for (const boundary of ['artboxHtml', 'galleryCardHtml']) test(`Actual Goals renderer cannot revive private data after reentrant ${boundary} authority change`, async t => {
  const h = fixture(t), {mountGoalsPanel} = await load('goals.mjs'), wire = transport(value(true));
  const header = {actions: h.add('goals-actions'), content: h.add('goals-content')};
  const render = h.runtime[boundary]; let invalidations = 0;
  h.runtime[boundary] = options => {if (invalidations++ === 0) wire.change(); return render(options);};
  const owner = h.own(mountGoalsPanel(h.host, h.runtime, {transport: wire, header, isCurrent: () => true}));
  await settle(); h.drain();
  assert.equal(invalidations, 1); assert.equal(h.host.querySelector('[data-goal-album-ref]'), null);
  assert.doesNotMatch(h.host.textContent, /Remote Album/);
  assert.equal(header.content.querySelector('[role="progressbar"]'), null);
  assert.equal(h.named('Reset'), undefined);
  owner.update(); assert.doesNotMatch(h.host.textContent, /Remote Album/);
  assert.equal(wire.requests.length, 1, 'Authority loss does not silently read a new account');
});

test('Actual Reset confirmation submits the captured selected period once through the real controller', async t => {
  const h = await mounted(t, value(true)), wait = deferred();
  h.click(h.named('Period: 1 week'));
  h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(option => /This year/.test(option.textContent)));
  h.click(h.named('Reset')); h.drain();
  const submit = h.named('Reset', h.form); assert.ok(submit);
  h.wire.defer(wait); h.click(submit); h.click(submit); await settle();
  const writes = h.wire.requests.filter(row => row.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/account/goals/reset');
  assert.equal(writes[0].options.body.period, 'year'); assert.equal(writes[0].options.body.revision, '2');
  assert.equal(writes[0].options.body.expected_cycle_id, cycle);
  assert.match(writes[0].options.body.request_key, /^[0-9a-f-]{36}$/);
  assert.ok(writes[0].options.body.timezone_name); assert.equal(h.form.hidden, true);
  h.owner.dispose(); wait.resolve(value(true)); await settle();
  assert.equal(h.wire.requests.filter(row => row.options.method === 'POST').length, 1);
});

for (const reason of ['period', 'context']) test(`Open Reset dialog retires and retained submit cannot write after ${reason} change`, async t => {
  const h = await mounted(t, value(true)), periodControl = h.named('Period: 1 week');
  h.click(h.named('Reset')); h.drain();
  const submit = h.named('Reset', h.form); assert.ok(submit);
  if (reason === 'context') h.wire.change();
  else {
    h.click(periodControl);
    h.click(h.document.querySelectorAll('[role="menuitemradio"]').find(option => /This year/.test(option.textContent)));
  }
  await settle(); h.drain(); assert.equal(h.form.hidden, true);
  h.click(submit); await settle();
  assert.equal(h.wire.requests.filter(row => row.options.method === 'POST').length, 0);
});

test('Actual dialog opening failure renders a dismissible fallback without writing', async t => {
  const h = await mounted(t, value(true));
  h.runtime.openForm = () => {throw new Error('synthetic opener failure');};
  h.click(h.named('Reset')); h.drain();
  assert.match(h.host.textContent, /This dialog is not available right now/);
  assert.doesNotMatch(h.host.textContent, /synthetic opener failure/);
  h.click(h.named('Close')); h.drain();
  assert.doesNotMatch(h.host.textContent, /This dialog is not available right now/);
  assert.equal(h.wire.requests.filter(row => row.options.method === 'POST').length, 0);
});
