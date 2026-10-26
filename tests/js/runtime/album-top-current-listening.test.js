'use strict';
// Source-authored only. Run only in a separately admitted cumulative native
// package. These imports load complete product modules and existing fixtures;
// no implementation is extracted, rewritten, injected or replaced here.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');
const {actualChoiceEnvironment} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const {installPrivateContext, STAMP} = require('./private-context-harness.cjs');

const endpoint = '/playback/capture/position/top-metrics';
const settings = (target = 5, revision = '1') => ({completed_target: target,
  settings_revision: revision, preference_status: revision === '1' ? 'default' : 'saved'});
const detail = (count = 2) => F.detail({items: Array.from({length: count}, (_, i) => F.row(11 + i))});
const wireRow = (row, patch = {}) => ({item_ref: row.item_ref, album_ref: row.album_ref,
  local_album_ref: row.native_album.inventory_album_ref, membership_revision: 'b'.repeat(64),
  status: 'ready', manual_completed: false, automatic_completed: false, fresh_rating: true,
  fresh_play: true, baseline_status: 'ready',
  reported_evidence: {status: 'available', has_plays: null, incomplete: false,
    count_family: 'standard', provenance: 'own_account_foobar_reported_evidence'},
  predicates: {has_plays: true, listened: true, completed: false, rated: true},
  full_progress: {available: true, state_revision: '2', continuation: false,
    policy_version: 'local-edition-overlap-total-margin-v1', basis: 'healthy-local-inventory-version-v1',
    history_complete: false, full: 2, uninterrupted_full: 1, partial: null, status: 'complete_at_cutoff'},
  ...patch});
const payload = (source, refs = source.items.map(row => row.item_ref), patch = {}) => ({
  version: 'current-top-listening-v1', context_ref: STAMP, top_ref: source.top_ref,
  top_revision: source.revision, account_id: '1', library_id: '2',
  scope: 'requested-current-items', whole_top_complete: false, settings: settings(),
  items: refs.map(ref => wireRow(source.items.find(row => row.item_ref === ref))), ...patch});
const options = (source = detail(), patch = {}) => ({detail: source,
  itemRefs: source.items.map(row => row.item_ref), accountId: '1', libraryId: '2',
  scopeKey: 'current-top:account:session:library', isCurrent: () => true, ...patch});
function projected(source, refs, {revision = '2', continuation = false, baselineStatus = 'ready', full = 2} = {}) {
  return {settings: {status: 'default', value: 5, revision: '1'}, items: new Map(refs.map(ref => {
    const row = source.items.find(item => item.item_ref === ref);
    return [ref, {revision, continuation, baselineStatus, unavailable: false,
      presentation: {protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
        top_ref: source.top_ref, top_revision: source.revision, album_ref: row.album_ref,
        target: 5, target_preference_revision: '1', recorded_scope: 'retained-local-lower-bound',
        predicates: {has_plays: true, listened: full > 0, completed: false, rated: true},
        metrics: {full: {status: 'at_least_recorded', value: full},
          uninterrupted_full: {status: 'at_least_recorded', value: 1}}}}];
  }))};
}
async function providerFixture(source = detail(), reply = null) {
  const {createCurrentTopListeningProvider} = await N.load('album-tops/current-listening-provider.mjs');
  let context = STAMP, disposed = false, accepted = true;
  const calls = [];
  const transport = {context: () => context, async request(path, init) {
    calls.push({path, init}); return reply ? reply(path, init) : payload(source);
  }};
  const provider = createCurrentTopListeningProvider({transport,
    acceptsScope: scope => accepted && scope === options(source).scopeKey, isDisposed: () => disposed});
  return {source, provider, calls, transport,
    changeContext: value => {context = value;}, retire: () => {disposed = true;}, denyScope: () => {accepted = false;}};
}

test('bounded current-Top read uses the fixed path and projects lower bounds, never whole-Top totals', async () => {
  const source = detail(4), f = await providerFixture(source);
  const result = await f.provider.readTopListening(options(source));
  assert.equal(f.calls.length, 1);
  const call = f.calls[0], url = new URL(call.path, 'https://fixture.invalid');
  assert.equal(url.pathname, endpoint);
  assert.deepEqual([...url.searchParams.keys()], ['top_ref', 'top_revision', 'item_ref', 'item_ref', 'item_ref', 'item_ref']);
  assert.equal(url.searchParams.get('top_ref'), source.top_ref);
  assert.equal(url.searchParams.get('top_revision'), source.revision);
  assert.deepEqual(url.searchParams.getAll('item_ref'), options(source).itemRefs);
  assert.equal(call.init.expected, STAMP); assert.equal(call.init.method, undefined); assert.equal(call.init.body, undefined);
  assert.deepEqual([...result.items.keys()], options(source).itemRefs);
  const first = result.items.get(source.items[0].item_ref).presentation;
  assert.deepEqual(first.metrics.full, {status: 'at_least_recorded', value: 2});
  assert.equal(first.metrics.partial, undefined); assert.equal(first.metrics.tracks_at_target, undefined);
  assert.equal(first.recorded_scope, 'retained-local-lower-bound');
  assert.deepEqual(result.settings, {status: 'default', value: 5, revision: '1'});
  assert.equal(result.whole_top_complete, undefined);
});

test('advance is exactly one item with its revision and cannot follow response-supplied paths', async () => {
  const source = detail(1), f = await providerFixture(source, () => payload(source, undefined,
    {advance_path: 'https://untrusted.invalid/advance', next_cursor: '/untrusted'}));
  await f.provider.advanceTopListening(options(source), '2');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, endpoint + '/advance');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(f.calls[0].init.body, {top_ref: source.top_ref, top_revision: source.revision,
    item_ref: source.items[0].item_ref, state_revision: '2'});
  const two = await providerFixture();
  await assert.rejects(two.provider.advanceTopListening(options(two.source), '2'), {status: 502});
  for (const revision of ['-1', '01', 2, '9007199254740992']) {
    await assert.rejects(f.provider.advanceTopListening(options(source), revision), {status: 502});
  }
  assert.equal(two.calls.length, 0); assert.equal(f.calls.length, 1);
});

test('invalid batch bounds, duplicate or alien items and invalid scope IDs fail before transport', async () => {
  const source = detail(5), f = await providerFixture(source);
  const first = source.items[0].item_ref;
  for (const patch of [{itemRefs: []}, {itemRefs: [first, first]}, {itemRefs: ['alien']},
    {itemRefs: source.items.map(row => row.item_ref)}, {itemRefs: [first], accountId: '0'},
    {itemRefs: [first], libraryId: '02'}]) {
    await assert.rejects(f.provider.readTopListening(options(source, patch)), {status: 502});
  }
  assert.equal(f.calls.length, 0);
});

for (const [label, patch] of [
  ['protocol', {version: 'candidate'}], ['context', {context_ref: 'c'.repeat(64)}],
  ['Top identity', {top_ref: F.OTHER}], ['Top revision', {top_revision: '8'}],
  ['account', {account_id: '9'}], ['library', {library_id: '9'}],
  ['scope', {scope: 'whole-top'}], ['whole-Top assertion', {whole_top_complete: true}],
  ['empty membership', {items: []}],
  ['bad default revision', {settings: {...settings(5, '2'), preference_status: 'default'}}],
]) test(`provider rejects mismatched ${label}`, async () => {
  const source = detail(1);
  const f = await providerFixture(source, () => payload(source, undefined, patch));
  await assert.rejects(f.provider.readTopListening(options(source)), {status: 502});
});

for (const [label, patch] of [
  ['item', {item_ref: F.IB}], ['album', {album_ref: F.B}], ['local edition', {local_album_ref: 'other'}],
  ['membership', {membership_revision: 'unknown'}], ['truthy manual', {manual_completed: 'true'}],
  ['missing predicate', {predicates: {listened: true}}], ['invented automatic completion', {automatic_completed: true}],
  ['unsupported baseline', {baseline_status: 'imported'}],
]) test(`provider rejects invalid ${label} row`, async () => {
  const source = detail(1), f = await providerFixture(source, () => payload(source, undefined,
    {items: [wireRow(source.items[0], patch)]}));
  await assert.rejects(f.provider.readTopListening(options(source)), {status: 502});
});

test('provider rejects duplicate items and invalid count policy while preserving explicit unavailable', async () => {
  const source = detail(), duplicate = await providerFixture(source, () => payload(source, undefined,
    {items: [wireRow(source.items[0]), wireRow(source.items[0])]}));
  await assert.rejects(duplicate.provider.readTopListening(options(source)), {status: 502});
  for (const patch of [{history_complete: true}, {full: -1}, {full: 1.5}, {full: '2'},
    {uninterrupted_full: 3}, {partial: 0}, {policy_version: 'aggregate'}, {basis: 'imported'}]) {
    const f = await providerFixture(source, () => payload(source, undefined, {items: source.items.map(row => {
      const value = wireRow(row); value.full_progress = {...value.full_progress, ...patch}; return value;
    })}));
    await assert.rejects(f.provider.readTopListening(options(source)), {status: 502});
  }
  const unavailable = await providerFixture(source, () => payload(source, undefined, {items: source.items.map(row =>
    ({item_ref: row.item_ref, album_ref: row.album_ref, status: 'unavailable', manual_completed: false}))}));
  const result = await unavailable.provider.readTopListening(options(source));
  for (const value of result.items.values()) {
    assert.equal(value.unavailable,true);assert.equal(value.revision,null);
    assert.equal(value.presentation.predicates.completed,null);assert.deepEqual(value.presentation.metrics,{});
  }
});

for (const loss of ['current Top', 'context', 'scope', 'disposed', 'signal']) test(`late ${loss} retirement rejects the response`, async () => {
  const source = detail(1), late = N.deferred(), f = await providerFixture(source, () => late.promise);
  let current = true; const controller = new AbortController();
  const reading = f.provider.readTopListening(options(source, {isCurrent: () => current, signal: controller.signal}));
  const rejected = assert.rejects(reading, {name: 'AbortError'});
  if (loss === 'current Top') current = false;
  if (loss === 'context') f.changeContext('c'.repeat(64));
  if (loss === 'scope') f.denyScope();
  if (loss === 'disposed') f.retire();
  if (loss === 'signal') controller.abort();
  late.resolve(payload(source)); await rejected;
});

test('real backend composition and real private transport preserve fixed GET/POST scope and HTTP errors', async t => {
  const env = N.nativeEnvironment(), source = detail(1), calls = [];
  let status = 200, responseContext = STAMP;
  env.context.fetch = async (url, init) => {calls.push({url, init}); return {ok: status === 200, status,
    json: async () => status === 200 ? payload(source, undefined, {context_ref: responseContext}) : {error: 'forbidden'}};};
  // Existing fixture loads the complete genuine private transport. Its response
  // stamping preserves explicit context_ref, including the deliberately bad one.
  installPrivateContext(env.context);
  const transport = env.context.AlbumHavenPrivateUITransport;
  const {createAlbumTopBackendProviders} = await N.load('album-tops/backend-providers.mjs');
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => scope === options(source).scopeKey});
  t.after(() => {providers.dispose(); transport.dispose(); env.assertClean();});
  await providers.readTopListening(options(source)); await providers.advanceTopListening(options(source), '2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].url, endpoint + '/advance'); assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), {top_ref: source.top_ref, top_revision: source.revision,
    item_ref: source.items[0].item_ref, state_revision: '2'});
  for (const {init} of calls) {
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['X-AlbumHaven-Context'], STAMP);
    assert.equal(init.headers['X-AlbumHaven-Account-Context'], undefined);
  }
  status = 403; await assert.rejects(providers.readTopListening(options(source)), {status: 403});
  status = 200; responseContext = null;
  await assert.rejects(providers.readTopListening(options(source)), {status: 409});
});

// Only browser scheduling and visibility are controlled. Product methods and
// callbacks remain untouched; each positive-delay callback is advanced explicitly.
function clockPlatform(env) {
  const timers = new Map(); let serial = 0, now = 0;
  env.context.setTimeout = (callback, delay = 0) => {
    const id = ++serial; timers.set(id, {callback, due: now + Number(delay), delay: Number(delay)}); return id;
  };
  env.context.clearTimeout = id => timers.delete(id);
  env.document.visibilityState = 'visible';
  return {timers,
    async advance(milliseconds) {
      now += milliseconds;
      const ready = [...timers].filter(([, value]) => value.due <= now);
      for (const [id, value] of ready) if (timers.delete(id)) value.callback();
      await N.drain();
    },
    visibility(value) {env.document.visibilityState = value;
      env.document.dispatchEvent(new env.context.Event('visibilitychange'));},
  };
}
async function viewFixture(t, {source = detail(6), handler = null} = {}) {
  const env = N.nativeEnvironment(), clock = clockPlatform(env), calls = [];
  let current = true, changed = 0;
  const provider = kind => async (args, revision) => {
    calls.push({kind, args, revision});
    return handler ? handler(kind, args, revision) : projected(source, args.itemRefs);
  };
  const providers = {readTopListening: provider('read'), advanceTopListening: provider('advance')};
  const {createCurrentTopListeningView} = await N.load('album-tops/current-listening-view.mjs');
  const owner = createCurrentTopListeningView({document: env.document, isCurrent: () => current, onChange: () => changed++});
  let value = {...options(source), providers, enabled: true, targetRevision: '1'};
  owner.update(value);
  t.after(() => {owner.dispose(); assert.equal(clock.timers.size, 0); env.assertClean();});
  return {...env, ...clock, source, owner, calls, changes: () => changed,
    update(patch) {value = {...value, ...patch}; owner.update(value);},
    retire() {current = false;}, args: () => value};
}

test('view reads at most four visible items, waits 1500 ms between batches, and never advances on its own', async t => {
  const f = await viewFixture(t);
  await f.advance(1499); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.deepEqual(f.calls[0].args.itemRefs, options(f.source).itemRefs.slice(0, 4));
  await f.advance(1499); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.deepEqual(f.calls[1].args.itemRefs, options(f.source).itemRefs.slice(4));
  assert.equal(f.calls.some(call => call.kind === 'advance'), false);
  assert.equal(f.timers.size, 0); assert.equal(Object.keys(f.owner.presentation()).length, 6);
});

test('view keeps one in-flight owner despite repeated start, timer advance and same-scope updates', async t => {
  const pending = N.deferred(), f = await viewFixture(t, {handler: () => pending.promise});
  await f.advance(1500); assert.equal(f.calls.length, 1);
  f.owner.start(); f.owner.start(); f.update({}); await f.advance(100000);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.signal.aborted, false);
  pending.resolve(projected(f.source, f.calls[0].args.itemRefs)); await N.drain();
  assert.equal(f.timers.size, 1);
});

test('explicit update rereads before paced one-item advance and stops when progress settles', async t => {
  const source = detail(1); let revision = '2';
  const f = await viewFixture(t, {source, handler: (kind, args) => projected(source, args.itemRefs,
    kind === 'read' ? {revision, continuation: true} : {revision: revision = '3', continuation: false, full: 3})});
  await f.advance(1500); assert.equal(f.timers.size, 0);
  f.owner.start(); await f.advance(0);
  assert.deepEqual(f.calls.map(call => call.kind), ['read', 'read']);
  await f.advance(1499); assert.equal(f.calls.length, 2);
  await f.advance(1); assert.equal(f.calls[2].kind, 'advance'); assert.equal(f.calls[2].revision, '2');
  assert.deepEqual(f.calls[2].args.itemRefs, [source.items[0].item_ref]);
  assert.equal(f.owner.status().processing, false); assert.equal(f.timers.size, 0);
  assert.equal(f.owner.presentation()[source.items[0].album_ref].metrics.full.value, 3);
});

test('needs-explicit-start baseline advances only after Update even without a continuation bit', async t => {
  const source = detail(1), f = await viewFixture(t, {source, handler: (kind, args) => projected(source, args.itemRefs,
    kind === 'read' ? {baselineStatus: 'needs_explicit_start'} : {revision: '3'})});
  await f.advance(1500); await f.advance(10000); assert.equal(f.calls.length, 1);
  f.owner.start(); await f.advance(0); await f.advance(1500);
  assert.deepEqual(f.calls.map(call => call.kind), ['read', 'read', 'advance']);
  assert.equal(f.timers.size, 0);
});

for (const reason of ['no progress', 'error']) test(`view stops on ${reason} until a fresh explicit Update`, async t => {
  const source = detail(1); let fail = reason === 'error';
  const f = await viewFixture(t, {source, handler: (kind, args) => {
    if (kind === 'advance' && fail) throw new TypeError('fixture unavailable');
    return projected(source, args.itemRefs, {continuation: true});
  }});
  await f.advance(1500); f.owner.start(); await f.advance(0); await f.advance(1500);
  assert.equal(f.owner.status().processing, false);
  assert.match(f.owner.status().message, reason === 'error' ? /unavailable.*retry explicitly/ : /paused.*Update again/);
  assert.equal(f.timers.size, 0); const count = f.calls.length;
  f.update({}); await f.advance(100000); assert.equal(f.calls.length, count);
  fail = false; f.owner.start(); await f.advance(0); assert.equal(f.calls.length, count + 1);
});

for (const retirement of ['visible refs', 'hidden', 'disabled', 'closed', 'detail', 'scope', 'providers', 'target'])
test(`view aborts or rejects obsolete ${retirement} work and never installs its late presentation`, async t => {
  const source = detail(2), late = N.deferred(), f = await viewFixture(t, {source, handler: () => late.promise});
  await f.advance(1500); const captured = f.calls[0].args;
  if (retirement === 'visible refs') f.update({itemRefs: []});
  if (retirement === 'hidden') f.visibility('hidden');
  if (retirement === 'disabled') f.update({enabled: false});
  if (retirement === 'closed') f.owner.dispose();
  if (retirement === 'detail') f.update({detail: {...source, revision: '8'}});
  if (retirement === 'scope') f.update({scopeKey: 'replacement-account'});
  if (retirement === 'providers') f.update({providers: {...f.args().providers}});
  if (retirement === 'target') f.update({targetRevision: '2'});
  if (retirement !== 'target') assert.equal(captured.signal.aborted, true);
  assert.equal(captured.isCurrent(), false);
  late.resolve(projected(source, captured.itemRefs)); await N.drain();
  assert.deepEqual(f.owner.presentation(), {});
  if (['visible refs', 'hidden', 'disabled', 'closed'].includes(retirement)) assert.equal(f.timers.size, 0);
});

test('hidden view resumes read-only visibility work; unavailable items are not zero and are not advanced', async t => {
  const source = detail(1), f = await viewFixture(t, {source, handler: () => ({items: new Map([
    [source.items[0].item_ref, {unavailable: true}],
  ]), settings: {status: 'default', value: 5, revision: '1'}})});
  f.visibility('hidden'); await f.advance(10000); assert.equal(f.calls.length, 0);
  f.visibility('visible'); await f.advance(1499); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, 1); assert.deepEqual(f.owner.presentation(), {});
  f.owner.start(); await f.advance(0); await f.advance(10000);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.kind === 'read'));
  assert.equal(f.owner.status().processing, false);
});

test('presentation marks Full as a lower bound and target changes retire Completed only', async () => {
  const {albumTopStatusPresentation: present, topStatusCoverage} = await N.load('album-tops/status-presentation.mjs');
  const source = detail(), row = source.items[0], entry = projected(source, [row.item_ref]).items.get(row.item_ref).presentation;
  entry.predicates.completed = true;
  const data = {...source, top_viewer_overlay: {...source.top_viewer_overlay,
    completed_target_preference: {status: 'default', value: 5, revision: '1'},
    item_listening_presentation: {[row.album_ref]: entry}}};
  const before = present(data, row);
  assert.equal(before.summary, '≥2 full · ? partial · ? tracks at target');
  assert.match(before.explanation, /At least 2 qualifying full listens/);
  assert.match(before.explanation, /Manual completion is separate/);
  assert.equal(before.flags.completed, true); assert.equal(before.flags.listened, true);
  assert.equal(before.counts.partial, null); assert.equal(before.counts.tracks, null);
  assert.deepEqual(topStatusCoverage(data, 'completed'), {known: 1, unknown: 1});
  data.top_viewer_overlay.completed_target_preference = {status: 'saved', value: 5, revision: '2'};
  const after = present(data, row);
  assert.equal(after.flags.completed, null); assert.equal(after.flags.listened, true);
  assert.equal(after.counts.full, 2); assert.equal(after.counts.uninterrupted, 1);
  assert.deepEqual(topStatusCoverage(data, 'completed'), {known: 0, unknown: 2});
  assert.equal(present(data, source.items[1]).summary, '');
  assert.equal(present(data, source.items[1]).flags.listened, null);
});

test('real read projection retains unknown status rows without overriding text, manual or sort filters', async () => {
  const {projectTopReadView: project} = await N.load('album-tops/read-view.mjs');
  const {topStatusCoverage} = await N.load('album-tops/status-presentation.mjs');
  const source = detail(), first = source.items[0];
  assert.deepEqual(project(source, {status: 'listened'}), source.items);
  assert.deepEqual(topStatusCoverage(source, 'listened'), {known: 0, unknown: 2});
  assert.deepEqual(project(source, {status: 'listened', query: 'Album 12', completion: 'complete'}), [source.items[1]]);
  assert.deepEqual(project(source, {status: 'listened', sort: 'album', direction: 'desc'}), [...source.items].reverse());
  const evidence = projected(source, [first.item_ref]).items.get(first.item_ref).presentation;
  evidence.predicates.listened = false;
  source.top_viewer_overlay.item_listening_presentation = {[first.album_ref]: evidence};
  assert.deepEqual(project(source, {status: 'listened'}), [source.items[1]]);
  assert.deepEqual(topStatusCoverage(source, 'listened'), {known: 1, unknown: 1});
  assert.deepEqual(project(source, {status: 'all'}), source.items);
});

function intersectionPlatform(env) {
  const observers = [];
  env.context.IntersectionObserver = class {
    constructor(callback) {this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this);}
    observe(target) {this.targets.add(target);}
    unobserve(target) {this.targets.delete(target);}
    disconnect() {this.targets.clear(); this.disconnected = true;}
    emit(target, visible) {assert.ok(this.targets.has(target)); this.callback([{target, isIntersecting: visible}]);}
  };
  return observers;
}
async function galleryFixture(t, {source = detail(), handler = null, serviceOverrides = {}, presentation = true, recording = true} = {}) {
  const env = actualChoiceEnvironment(), clock = clockPlatform(env), intersections = intersectionPlatform(env);
  env.context.AbortController = AbortController;
  env.context.innerWidth = 1200;
  env.context.getComputedStyle = () => ({display: 'block', columnGap: '8', overflowY: 'visible', getPropertyValue: () => ''});
  const shell = env.document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {topListeningPresentationEnabled: String(presentation), positionCaptureEnabled: String(recording), nativeAccountId: '1', nativeLibraryId: '2'});
  env.document.body.append(shell);
  const calls = [], service = N.service(serviceOverrides); service.data.detail = source;
  const {createCurrentTopListeningProvider} = await N.load('album-tops/current-listening-provider.mjs');
  const provider = createCurrentTopListeningProvider({acceptsScope: value => value === N.SCOPE, isDisposed: () => false,
    transport: {context: () => STAMP, async request(path, init) {
      const url = new URL(path, 'https://fixture.invalid'), refs = init.method === 'POST' ? [init.body.item_ref] : url.searchParams.getAll('item_ref');
      calls.push({path, init, refs}); return handler ? handler(refs, init) : payload(source, refs);
    }}});
  Object.assign(service.providers, provider);
  const controller = await N.preparedController(service), mounted = await N.connectedView(env, service, controller);
  const cards = () => env.host.querySelectorAll('.album-card');
  const observer = () => {assert.equal(intersections.length, 1); return intersections[0];};
  const chooseStatus = value => {
    let trigger = env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith('Status:'));
    if (!trigger) {env.click(env.button(env.host, 'Filter'));
      trigger = env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith('Status:'));}
    assert.ok(trigger); env.click(trigger);
    const option = env.document.querySelector(`[role="menu"][aria-label="Status"] [data-foobar-format="${value}"]`);
    assert.ok(option); assert.notEqual(option.getAttribute('aria-disabled'), 'true'); env.click(option);
  };
  t.after(async () => {mounted.dispose(); assert.equal(clock.timers.size, 0);
    assert.ok(intersections.every(value => value.disconnected));
    // The genuine modal pointer-origin click owner schedules a zero-delay browser
    // task. Promise microtasks cannot run it; positive-delay leaks stay failures.
    assert.ok([...env.timers.values()].every(timer => timer.task !== null && timer.task !== undefined),
      'only already-scheduled zero-delay native browser tasks may remain');
    await N.nextTask(); await N.drain(); env.assertClean();});
  return {...env, ...clock, nativeTimers: env.timers, source, service, controller, mounted, calls, cards, observer, chooseStatus};
}

test('actual native filter-before-load keeps pending offscreen rows visible and fetches only intersecting refs', async t => {
  const f = await galleryFixture(t);
  f.chooseStatus('listened');
  assert.deepEqual(f.cards().map(card => card.getAttribute('data-gallery-card-key')), [F.IA, F.IB]);
  assert.match(f.host.textContent, /Unassessed|pending|not confirmed/i);
  await f.advance(10000); assert.equal(f.calls.length, 0);
  const first = f.cards()[0], second = f.cards()[1];
  f.observer().emit(first, true); await f.advance(1500);
  assert.deepEqual(f.calls[0].refs, [F.IA]);
  assert.equal(first.querySelector('.album-top-listening-status').textContent, '≥2 full · ? partial · ? tracks at target');
  assert.equal(second.querySelector('.album-top-listening-status'), null);
  assert.ok(f.cards().includes(second), 'unassessed offscreen item remains pending, not a known match or false');
  f.observer().emit(first, false); f.observer().emit(second, true); await f.advance(1500);
  assert.deepEqual(f.calls[1].refs, [F.IB]);
  assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('actual status filter removes a known false row, but does not starve unknown rows awaiting assessment', async t => {
  const source = detail(), f = await galleryFixture(t, {source, handler: refs => payload(source, refs, {
    items: refs.map(ref => wireRow(source.items.find(row => row.item_ref === ref),
      {predicates: {has_plays: true, listened: false, completed: false, rated: true}})),
  })});
  f.chooseStatus('listened'); const first = f.cards()[0], second = f.cards()[1];
  f.observer().emit(first, true); await f.advance(1500);
  assert.deepEqual(f.cards().map(card => card.getAttribute('data-gallery-card-key')), [F.IB]);
  assert.equal(f.cards()[0], second); assert.equal(second.querySelector('.album-top-listening-status'), null);
  f.chooseStatus('all'); assert.equal(f.cards().length, 2);
  assert.equal(f.service.count('execute'), 0);
});

for (const action of ['open', 'complete']) test(`metric-only native updates preserve artwork and focused ${action} nodes`, async t => {
  const source = detail(1); let full = 2;
  const f = await galleryFixture(t, {source, handler: refs => payload(source, refs, {items: refs.map(ref => {
    const row = wireRow(source.items.find(item => item.item_ref === ref)); row.full_progress.full = full; return row;
  })})});
  const card = f.cards()[0], artwork = card.querySelector('img'), focused = F.intent(card, action);
  assert.ok(artwork); assert.ok(focused); focused.focus();
  f.observer().emit(card, true); await f.advance(1500);
  assert.equal(f.cards()[0], card); assert.equal(card.querySelector('img'), artwork);
  assert.equal(F.intent(card, action), focused); assert.equal(f.document.activeElement, focused);
  const status = card.querySelector('.album-top-listening-status'); assert.ok(status);
  full = 3; f.click(f.button(f.host, 'Update listening')); await f.advance(0);
  assert.equal(f.cards()[0], card); assert.equal(card.querySelector('img'), artwork);
  assert.equal(card.querySelector('.album-top-listening-status'), status);
  assert.equal(F.intent(card, action), focused); assert.equal(f.document.activeElement, focused);
  assert.equal(status.textContent, '≥3 full · ? partial · ? tracks at target');
});

for (const loss of ['hidden', 'disconnected', 'closed']) test(`actual gallery ${loss} rejects late visible metrics and performs no advance`, async t => {
  const source = detail(1), late = N.deferred(), f = await galleryFixture(t, {source, handler: () => late.promise});
  f.observer().emit(f.cards()[0], true); await f.advance(1500);
  const request = f.calls[0];
  if (loss === 'hidden') f.visibility('hidden');
  if (loss === 'disconnected') {f.host.remove(); f.mounted.update({});}
  if (loss === 'closed') f.mounted.dispose();
  assert.equal(request.init.signal.aborted, true);
  late.resolve(payload(source)); await N.drain(); await f.advance(100000);
  assert.equal(f.host.querySelector('.album-top-listening-status'), null);
  assert.equal(f.calls.length, 1);
});

test('browse-only no-capture DTO keeps rated and manual predicates without a membership digest', async () => {
  const source=detail(1);
  const response=payload(source,undefined,{items:[wireRow(source.items[0],{
    membership_revision:null,manual_completed:true,automatic_completed:false,
    fresh_rating:null,fresh_play:null,baseline_status:'needs_explicit_start',baseline_changed:false,
    predicates:{has_plays:null,listened:null,completed:true,rated:true},
    full_progress:{available:true,state_revision:'0',status:'not_started',continuation:false,reason:'measured_evidence_unavailable'},
  })]});
  const f=await providerFixture(source,()=>response);
  const result=await f.provider.readTopListening(options(source));
  const row=result.items.get(source.items[0].item_ref);
  assert.equal(row.revision,'0');assert.equal(row.baselineStatus,'needs_explicit_start');
  assert.equal(row.unavailable,false);assert.deepEqual(row.presentation.metrics,{});
  assert.equal(row.presentation.predicates.rated,true);assert.equal(row.presentation.predicates.completed,true);
});

test('unmapped manually completed item has a manual-only current presentation, not invented Full', async () => {
  const source=detail(1);
  const response=payload(source,undefined,{items:[{
    item_ref:source.items[0].item_ref,album_ref:source.items[0].album_ref,status:'unavailable',manual_completed:true,
  }]});
  source.items[0].native_album=null;
  const f=await providerFixture(source,()=>response);
  const row=(await f.provider.readTopListening(options(source))).items.get(source.items[0].item_ref);
  assert.equal(row.unavailable,true);assert.equal(row.presentation.predicates.completed,true);
  assert.equal(row.presentation.predicates.listened,null);assert.deepEqual(row.presentation.metrics,{});
  assert.equal(row.presentation.recorded_scope,'manual-only-current-membership');
});

test('supported Full cannot use a null membership even when manual completion is known', async () => {
  const source=detail(1),f=await providerFixture(source,()=>payload(source,undefined,{items:[wireRow(source.items[0],{membership_revision:null,manual_completed:true})]}));
  await assert.rejects(f.provider.readTopListening(options(source)),{status:502});
});

test('only a true server baseline acknowledgment asks the owner to refresh detail', async () => {
  const source=detail(1);
  for (const changed of [false,true]) {
    const f=await providerFixture(source,()=>payload(source,undefined,{items:[wireRow(source.items[0],{baseline_changed:changed})]}));
    assert.equal((await f.provider.advanceTopListening(options(source),'2')).baselineChanged,changed);
  }
});


test('assessed unknown filter rows remain labeled, stop fetching and are never confirmed matches', async t => {
  const source=detail(1),f=await galleryFixture(t,{source,handler:refs=>payload(source,refs,{items:refs.map(ref=>wireRow(
    source.items.find(row=>row.item_ref===ref),{membership_revision:null,fresh_rating:null,fresh_play:null,
      predicates:{has_plays:null,listened:null,completed:null,rated:null},
      full_progress:{available:true,state_revision:'0',status:'not_started',continuation:false}}))})});
  f.chooseStatus('listened');const card=f.cards()[0];
  assert.equal(card.getAttribute('data-listening-filter-state'),'pending');
  f.observer().emit(card,true);await f.advance(1500);
  assert.equal(f.cards()[0],card);assert.equal(card.getAttribute('data-listening-filter-state'),'unknown');
  assert.match(card.textContent,/Status unavailable from current evidence.*Not a confirmed filter match/);
  const calls=f.calls.length;await f.advance(60000);assert.equal(f.calls.length,calls);
  assert.equal(f.timers.size,0);
});

test('real baseline acknowledgment refreshes native detail before a manual CAS uses its new revision', async t => {
  const source=detail(1),album=source.items[0].album_ref;
  source.top_viewer_overlay.item_progress[album]={progress_revision:'0',manual_completed_at:null};
  let f,started=false;
  f=await galleryFixture(t,{source,handler:(refs,init)=>{
    if(init.method==='POST') {
      started=true;
      f.service.data.detail={...source,top_viewer_overlay:{...source.top_viewer_overlay,
        item_progress:{[album]:{progress_revision:'1',manual_completed_at:null}}}};
    }
    return payload(source,refs,{items:refs.map(ref=>wireRow(source.items.find(row=>row.item_ref===ref),{
      membership_revision:null,fresh_rating:null,fresh_play:null,baseline_changed:init.method==='POST',
      baseline_status:started?'ready':'needs_explicit_start',
      predicates:{has_plays:null,listened:null,completed:null,rated:false},
      full_progress:{available:true,state_revision:'0',status:'not_started',continuation:false}}))});
  },serviceOverrides:{execute:async(action,command)=>({action,request_key:command.request_key,top_ref:command.top_ref,
    album_ref:album,progress_revision:'2',manual_completed_at:'2026-10-23T12:00:00Z',changed:true})}});
  f.observer().emit(f.cards()[0],true);await f.advance(1500);
  const reads=f.service.count('read');
  f.click(f.button(f.host,'Update listening'));await f.advance(0);await f.advance(1500);await N.drain();
  assert.equal(started,true);assert.ok(f.service.count('read')>reads);
  assert.equal(f.controller.getSnapshot().detail.data.top_viewer_overlay.item_progress[album].progress_revision,'1');
  f.click(F.intent(f.cards()[0],'complete'));await N.drain();
  assert.equal(f.service.count('execute'),0);
  f.click(f.document.getElementById('app-confirm-accept'));await N.drain();
  const mutation=f.service.calls.find(call=>call.method==='execute');
  assert.equal(mutation.args[0],'set_manual_completion');assert.equal(mutation.args[1].progress_revision,'1');
});

test('genuine provider and view retain last-read import positive through sparse advance then refresh once', async t => {
  const source=detail(1); let posts=0, importsPresent=true;
  const p=await providerFixture(source,(path)=>{
    const advancing=path.endsWith('/advance'); if(advancing) posts++;
    const row=wireRow(source.items[0],{predicates:{has_plays:null,listened:null,completed:null,rated:true},
      reported_evidence:{status:advancing?'not_requested':'available',has_plays:!advancing&&importsPresent?true:null,
        incomplete:false,count_family:'standard',provenance:'own_account_foobar_reported_evidence'},
      full_progress:{available:true,state_revision:String(2+posts),continuation:posts<2,status:'not_started'}});
    if(!advancing&&importsPresent) row.predicates.has_plays=true;
    return payload(source,undefined,{items:[row]});
  });
  const f=await viewFixture(t,{source,handler:(kind,args,revision)=>kind==='read'
    ?p.provider.readTopListening(args):p.provider.advanceTopListening(args,revision)});
  await f.advance(1500); f.owner.start(); await f.advance(0); await f.advance(1500);
  let shown=f.owner.presentation()[source.items[0].album_ref];
  assert.equal(posts,1); assert.equal(shown.predicates.has_plays,true);
  assert.equal(shown.reported_evidence.freshness,'last-read-not-refreshed-by-advance');
  assert.equal(shown.predicates.listened,null); assert.equal(shown.predicates.completed,null);
  importsPresent=false; await f.advance(1500); assert.equal(posts,2);
  await f.advance(1500); shown=f.owner.presentation()[source.items[0].album_ref];
  assert.equal(shown.predicates.has_plays,null); assert.equal(shown.reported_evidence.status,'available');
  assert.equal(f.timers.size,0); assert.equal(f.calls.filter(x=>x.kind==='read').length,3);
});

test('provider import receipts are exact-context bound and reject malformed reported evidence', async () => {
  const source=detail(1), p=await providerFixture(source);
  const first=(await p.provider.readTopListening(options(source))).items.get(source.items[0].item_ref);
  p.changeContext('c'.repeat(64));
  const q=await providerFixture(source,()=>payload(source,undefined,{context_ref:'c'.repeat(64)}));
  q.changeContext('c'.repeat(64));
  const second=(await q.provider.readTopListening(options(source))).items.get(source.items[0].item_ref);
  assert.notEqual(first.reportedEvidence.binding,second.reportedEvidence.binding);
  for(const patch of [{status:'not_requested',has_plays:true},{count_family:'combined'},
    {provenance:'lastfm_cached'},{has_plays:2},{incomplete:'false'}]) {
    const bad=await providerFixture(source,()=>{
      const row=wireRow(source.items[0]);row.reported_evidence={...row.reported_evidence,...patch};
      return payload(source,undefined,{items:[row]});
    });
    await assert.rejects(bad.provider.readTopListening(options(source)),{status:502});
  }
});

test('a failed terminal import refresh stops and later explicit unknown read cannot resurrect a retained positive', async t => {
  const source=detail(1);let reads=0,posts=0,fail=true;
  const p=await providerFixture(source,path=>{
    const post=path.endsWith('/advance');if(post) posts++;else reads++;
    if(!post&&reads===3&&fail) throw new TypeError('import refresh unavailable');
    const row=wireRow(source.items[0],{predicates:{has_plays:!post&&reads<3?true:null,listened:null,completed:null,rated:true},
      reported_evidence:{status:post?'not_requested':'available',has_plays:!post&&reads<3?true:null,
        incomplete:false,count_family:'standard',provenance:'own_account_foobar_reported_evidence'},
      full_progress:{available:true,state_revision:String(2+posts),continuation:posts===0,status:'not_started'}});
    return payload(source,undefined,{items:[row]});
  });
  const f=await viewFixture(t,{source,handler:(kind,args,revision)=>kind==='read'?p.provider.readTopListening(args):p.provider.advanceTopListening(args,revision)});
  await f.advance(1500);f.owner.start();await f.advance(0);await f.advance(1500);await f.advance(1500);
  assert.equal(posts,1);assert.equal(reads,3);assert.equal(f.timers.size,0);
  assert.match(f.owner.status().message,/unavailable/);
  const old=f.owner.presentation()[source.items[0].album_ref];
  assert.equal(old.reported_evidence.freshness,'last-read-not-refreshed-by-advance');
  await f.advance(100000);assert.equal(reads,3);
  fail=false;f.owner.start();await f.advance(0);
  assert.equal(f.owner.presentation()[source.items[0].album_ref].predicates.has_plays,null);
  assert.equal(f.timers.size,0);assert.equal(posts,1);
});

for(const recording of [false,true]) test(`disabled presentation makes no optional gallery requests with recording ${recording}`,async t=>{
  const f=await galleryFixture(t,{presentation:false,recording});
  for(const card of f.cards()) f.observer().emit(card,true);
  await f.advance(100000);assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
});

test('actual gallery retains permitted rated manual and reported predicates with recording disabled',async t=>{
  const source=detail(1),f=await galleryFixture(t,{source,presentation:true,recording:false,
    handler:refs=>payload(source,refs,{items:refs.map(ref=>wireRow(source.items.find(x=>x.item_ref===ref),{
      membership_revision:null,manual_completed:true,fresh_play:null,fresh_rating:null,
      predicates:{has_plays:true,listened:null,completed:true,rated:true},
      reported_evidence:{status:'available',has_plays:true,incomplete:false,count_family:'standard',provenance:'own_account_foobar_reported_evidence'},
      full_progress:{available:true,state_revision:'0',status:'not_started',continuation:false},
    }))})});
  f.observer().emit(f.cards()[0],true);await f.advance(1500);assert.equal(f.calls.length,1);
  for(const filter of ['rated','completed','has_plays']) {
    f.chooseStatus(filter);await N.drain();assert.equal(f.cards().length,1);
    assert.equal(f.cards()[0].getAttribute('data-listening-filter-state'),'matching');
  }
  const status=f.cards()[0].querySelector('.album-top-listening-status');
  assert.match(status.getAttribute('aria-label'),/Foobar reported plays.*last import-evidence read/);
  assert.match(status.textContent,/\? full/);assert.equal(f.timers.size,0);
});

test('explicit update replaces a pending discovery timer without creating duplicate work', async t => {
  const late=N.deferred(), f=await viewFixture(t,{source:detail(1),handler:()=>late.promise});
  assert.equal(f.timers.size,1);
  f.owner.start();await f.advance(0);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'read');
  f.owner.start();await f.advance(1500);
  assert.equal(f.calls.length,1,'an active request remains the sole owner');
  late.resolve(projected(f.source,f.args().itemRefs));await N.drain();
});

test('admitted manual completion remains independent of unknown or changed target receipts',async()=>{
  const source=detail(1),row=source.items[0];
  const f=await providerFixture(source,()=>payload(source,undefined,{items:[wireRow(row,{
    manual_completed:true,automatic_completed:false,membership_revision:null,
    predicates:{has_plays:null,listened:null,completed:true,rated:false},
    full_progress:{available:false},
  })]}));
  const result=await f.provider.readTopListening(options(source));
  const {albumTopStatusPresentation:present}=await N.load('album-tops/status-presentation.mjs');
  for(const preference of [{status:'uncertain'},{status:'saved',value:7,revision:'2'},null]) {
    const data={...source,top_viewer_overlay:{...source.top_viewer_overlay,
      completed_target_preference:preference,item_listening_presentation:{[row.album_ref]:result.items.get(row.item_ref).presentation}}};
    const value=present(data,row);
    assert.equal(value.targetBound,false);assert.equal(value.flags.completed,true);
    assert.equal(value.flags.listened,null);assert.equal(value.counts.full,null);
  }
});

test('automatic completion still requires the current target receipt after manual independence correction',async()=>{
  const source=detail(1),row=source.items[0];
  const f=await providerFixture(source,()=>payload(source,undefined,{items:[wireRow(row,{
    manual_completed:false,automatic_completed:true,
    predicates:{has_plays:true,listened:true,completed:true,rated:true},
    full_progress:{...wireRow(row).full_progress,full:5},
  })]}));
  const result=await f.provider.readTopListening(options(source));
  const {albumTopStatusPresentation:present}=await N.load('album-tops/status-presentation.mjs');
  const data={...source,top_viewer_overlay:{...source.top_viewer_overlay,
    completed_target_preference:{status:'saved',value:7,revision:'2'},
    item_listening_presentation:{[row.album_ref]:result.items.get(row.item_ref).presentation}}};
  assert.equal(present(data,row).flags.completed,null);
  assert.equal(present(data,row).flags.listened,true);
});

for (const completed of [false,true]) test(`native manual confirmation ${completed ? 'clears' : 'marks'} independently of unavailable listening`,async t=>{
  const source=detail(1),album=source.items[0].album_ref;
  source.top_viewer_overlay.item_progress[album]={progress_revision:'1',manual_completed_at:completed?'2026-10-01T00:00:00Z':null};
  const f=await galleryFixture(t,{source,presentation:false,recording:false,
    serviceOverrides:{execute:async(action,command)=>({action,request_key:command.request_key,top_ref:command.top_ref,
      album_ref:album,progress_revision:'2',manual_completed_at:completed?null:'2026-10-23T12:00:00Z',changed:true})}});
  const button=F.intent(f.cards()[0],'complete');f.click(button);await N.drain();
  assert.equal(f.document.getElementById('app-confirm-modal').hidden,false);
  assert.equal(f.service.count('execute'),0);assert.equal(F.intent(f.cards()[0],'complete').disabled,true);
  f.click(button);await N.drain();assert.equal(f.service.count('execute'),0);
  assert.match(f.document.getElementById('app-confirm-text').textContent,/does not (change|remove) listening history or ratings/);
  if(!completed)assert.match(f.document.getElementById('app-confirm-text').textContent,/Measured listening is unavailable/);
  f.click(f.document.getElementById('app-confirm-accept'));await N.drain();
  const calls=f.service.calls.filter(call=>call.method==='execute');assert.equal(calls.length,1);
  assert.equal(calls[0].args[0],'set_manual_completion');assert.equal(calls[0].args[1].completed,!completed);
  assert.equal(calls[0].args[1].progress_revision,'1');assert.equal(f.calls.length,0);
});

test('native manual confirmation cancellation leaves progress untouched and usable',async t=>{
  const f=await galleryFixture(t,{source:detail(1),presentation:false});
  f.click(F.intent(f.cards()[0],'complete'));await N.drain();
  f.click(f.document.getElementById('app-confirm-cancel'));await N.drain();
  assert.equal(f.service.count('execute'),0);assert.equal(F.intent(f.cards()[0],'complete').disabled,false);
});

for(const change of ['manual revision','Top owner']) test(`native manual confirmation rejects a changed ${change} after await`,async t=>{
  const source=detail(1),album=source.items[0].album_ref,f=await galleryFixture(t,{source,presentation:false});
  f.click(F.intent(f.cards()[0],'complete'));await N.drain();
  if(change==='manual revision'){
    f.service.data.detail={...source,top_viewer_overlay:{...source.top_viewer_overlay,
      item_progress:{[album]:{progress_revision:'9',manual_completed_at:null}}}};
    await f.controller.open(source.top_ref);
  }else await f.controller.open(N.OTHER);
  f.click(f.document.getElementById('app-confirm-accept'));await N.drain();
  assert.equal(f.service.count('execute'),0);
});

test('native manual confirmation rechecks permission on the same retained owner',async t=>{
  const f=await galleryFixture(t,{source:detail(1),presentation:false});
  const retained=f.controller.getSnapshot().detail.data;
  f.click(F.intent(f.cards()[0],'complete'));await N.drain();
  // Explicit policy-fixture withdrawal in place isolates the final permission
  // check; the two preceding cases separately cover normal owner replacement.
  retained.allowed_actions.can_manage_own_progress=false;
  assert.equal(f.controller.getSnapshot().detail.data,retained);
  f.click(f.document.getElementById('app-confirm-accept'));await N.drain();
  assert.equal(f.service.count('execute'),0);
});


test('actual manual modal pointer-origin reset finishes on its browser task before clean teardown',async t=>{
  const f=await galleryFixture(t,{source:detail(1),presentation:false,recording:false});
  f.click(F.intent(f.cards()[0],'complete'));await N.drain();
  const modal=f.document.getElementById('app-confirm-modal');
  modal.dispatchEvent(new f.context.Event('pointerdown',{bubbles:true}));
  assert.equal(modal.dataset.pointerDownStartedOnOverlay,'1');
  f.click(f.document.getElementById('app-confirm-cancel'));await N.drain();
  assert.equal(modal.hidden,true);assert.equal(f.service.count('execute'),0);
  assert.equal(modal.dataset.pointerDownStartedOnOverlay,'1');
  assert.equal(f.nativeTimers.size,1);
  const [key,timer]=[...f.nativeTimers][0];
  assert.equal(typeof timer.callback,'function');assert.notEqual(timer.task,null);
  await N.nextTask();await N.drain();
  assert.equal(f.nativeTimers.has(key),false);assert.equal(f.nativeTimers.size,0);
  assert.equal(modal.dataset.pointerDownStartedOnOverlay,'0');
});
