'use strict';
// Existing behavioral assertions at the actual connected fetch/read boundaries.
// The additive adapter composes real owners without replacing admission or apply.
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fixture, browsePayload, outcome,
} = require('./search-native-fixtures/existing-admission-adapter.cjs');

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const forms = [':loved', 'love:loved', ':obsessed', 'love:obsessed'];
const url = q => `/view-data?surface=albums&q=${encodeURIComponent(q)}`;
const plain = value => JSON.parse(JSON.stringify(value));
function packet(query = ':loved', overrides = {}) {
  return {
    status: 'ready', private_search: true, contract_version: 'own-love-v1',
    context_ref: A, query,
    criteria: {subject: 'self', predicate_domain: 'tracks',
      love: {include: [query.includes('obsessed') ? 'obsessed' : 'loved'], exclude: []},
      name_scopes: ['artists', 'albums', 'tracks']},
    presentation: 'albums', selected_artist: 'Witness Artist', selection_state: 'selected',
    artist_groups: [{artist: 'Witness Artist', artist_display: 'Witness Artist', albums: [{
      album_ref: 'inventory-album:9:101', name: 'Qualified album', year: 2020, edition: '',
      allowed_actions: {can_read: true, can_view_details: true}, matches_search: true,
    }]}],
    tracks: [], page: {limit: 50, returned_count: 1, has_more: false, next_cursor: null},
    sidebar: {artists: [{artist: 'Witness Artist', artist_display: 'Witness Artist'}],
      returned_count: 1, has_more: false, next_cursor: null},
    ...overrides,
  };
}
function setup(t) {
  const h = fixture(t);
  h.context.state.view = browsePayload();
  h.location.assign = value => {h.events.push(`location:${value}`);};
  // Simulate a transport whose response can race cancellation. This changes only
  // the network seam; production request IDs/controllers/admission remain real.
  h.context.fetch = (requestUrl, options = {}) => new Promise((resolve, reject) => {
    h.requests.push({url: requestUrl, options, settled: false,
      resolve(value) {this.settled = true; resolve(value);},
      reject(error) {this.settled = true; reject(error);}});
  });
  return h;
}
function switchContext(h, kind) {
  if (kind === 'account') h.shell.dataset.nativeAccountId = '8';
  if (kind === 'library') h.shell.dataset.nativeLibraryId = '10';
  h.shell.dataset.privateUiContext = kind === 'logout' ? '' : B;
  h.context.AlbumHavenPrivateUITransport.generation();
}

for (const query of forms) {
  test(`global ${query} dispatch captures the authenticated context`, async t => {
    const h = setup(t), pending = h.read(url(query));
    assert.equal(h.requests.length, 1, 'existing foreground request must dispatch');
    const request = h.requests[0];
    h.respond(0, packet(query));
    await pending;
    assert.equal(new URL(request.url, 'https://fixture.invalid').searchParams.get('q'), query);
    assert.equal(request.options.headers['X-AlbumHaven-Context'], A,
      'personal global Search must send the context captured before fetch');
  });
}

for (const query of [':loved :obsessed', 'love:loved love:obsessed', '-:loved', '-love:obsessed']) {
  test(`global submit preserves token expression ${query} for the server owner`, async t => {
    const h = setup(t), pending = h.read(url(query));
    h.respond(0, packet(query));
    await pending;
    assert.equal(new URL(h.requests[0].url, 'https://fixture.invalid').searchParams.get('q'), query);
    assert.equal(h.requests.length, 1, 'no broad ordinary fallback or rewritten second query');
  });
}

for (const [name, contextRef] of [['missing', undefined], ['mismatching', B]]) {
  test(`server-marked personal payload with ${name} context cannot reach apply`, async t => {
    const h = setup(t), pending = h.read(url(':loved'));
    const data = packet();
    if (contextRef === undefined) delete data.context_ref; else data.context_ref = contextRef;
    h.respond(0, data);
    await pending;
    assert.equal(h.applied.length, 0, 'unadmitted personal rows cannot reach any state write');
    assert.equal(h.events.includes('paint'), false, 'unadmitted rows cannot paint');
  });
}

test('server personal discriminator requires captured admission even on ordinary-looking URL', async t => {
  const h = setup(t), pending = h.read(url('ordinary text'));
  h.respond(0, packet(':loved', {context_ref: B}));
  await pending;
  assert.equal(h.applied.length, 0, 'request text must not bypass server-marked private admission');
});

for (const kind of ['account', 'library', 'logout']) {
  for (const startupRefresh of [false, true]) {
    test(`${kind} retires late ${startupRefresh ? 'bootstrap hydration' : 'foreground'} personal response`, async t => {
      const h = setup(t), pending = h.read(url(':loved'), {startupRefresh, startupHydrationTier: 'full'});
      switchContext(h, kind);
      h.respond(0, packet());
      await pending;
      assert.equal(h.applied.length, 0, 'captured private generation must still own the final write');
      assert.equal(h.events.includes('paint'), false);
    });
  }
}

test('switch during response JSON parsing cannot admit personal rows', async t => {
  const h = setup(t), pending = h.read(url(':loved'));
  h.requests[0].resolve({ok: true, status: 200, json: async () => {
    switchContext(h, 'library'); return packet();
  }});
  await pending;
  assert.equal(h.applied.length, 0, 'context must be rechecked after async parse');
});

test('synchronous application subscriber switching context prevents final personal write', async t => {
  const h = setup(t);
  const pending = h.read(url(':loved'), {shouldApplyResponse() {
    switchContext(h, 'account'); return true;
  }});
  h.respond(0, packet());
  await pending;
  assert.equal(h.applied.length, 0, 'check captured generation after reentrant callbacks');
});

for (const status of [401, 403]) {
  test(`stale ${status} response cannot revoke a newer source`, async t => {
    const h = setup(t);
    let revocations = 0;
    const result = await outcome(h.context.readGalleryResponse({ok: false, status,
      json: async () => ({ok: false, error_code: 'private_search_forbidden', error: 'Search unavailable.'})},
    () => false, {revoke() {revocations++;}}));
    assert.ok(result.error, 'denial must not become ready data');
    assert.equal(revocations, 0, 'obsolete denial cannot retire currently owned private state');
  });
}

test('superseded error/finally leaves newer loading state owned by newer request', async t => {
  const h = setup(t), old = h.read(url(':loved'));
  const next = h.read(url(':obsessed'));
  h.respond(0, {ok: false, error_code: 'private_search_forbidden', error: 'Search unavailable.'}, 403);
  await old;
  assert.equal(h.context.state.busy, true, 'late finally must not unset newer busy');
  assert.equal(h.context.state.ui.activeViewRequestUrl, url(':obsessed'));
  assert.equal(h.applied.length, 0);
  h.respond(1, packet(':obsessed'));
  await next;
});

test('ordinary nonpersonal response retains existing public admission without context', async t => {
  const h = setup(t), data = browsePayload([], {query: 'ordinary text'});
  delete data.context_ref;
  const pending = h.read(url('ordinary text'));
  h.respond(0, data);
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].payload.private_search, undefined);
  assert.equal(h.applied[0].payload.context_ref, undefined);
});

test('bounded empty personal page keeps its pending witness continuation', async t => {
  const h = setup(t), data = packet(':loved', {selected_artist: null, selection_state: 'pending_page',
    artist_groups: [], page: {limit: 50, returned_count: 0, has_more: true, next_cursor: 'opaque-result'},
    sidebar: {artists: [], returned_count: 0, has_more: true, next_cursor: 'opaque-sidebar'}});
  await h.mount();
  const pending = h.read(url(':loved'));
  h.respond(0, data); await pending;
  assert.equal(h.applied.length, 1);
  const navigation = h.applied[0].payload;
  for (const key of ['page', 'next_cursor', 'search_cursor', 'search_sidebar_cursor',
    'sidebar', 'context_ref', 'receipt', 'snapshot_ref', 'selection_state']) {
    assert.equal(Object.hasOwn(navigation, key), false, `${key} must stay outside applied navigation`);
  }
  for (const secret of [A, 'opaque-result', 'opaque-sidebar']) {
    assert.equal(JSON.stringify(navigation).includes(secret), false, 'private continuation data cannot enter navigation');
  }
  const snapshot = h.runtime().snapshot();
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.actionable, false);
  assert.equal(snapshot.sourceIdentity, null);
  assert.equal(snapshot.result.selectionState, 'pending_page');
  assert.deepEqual(plain(snapshot.result.page), {limit: 50, returnedCount: 0, hasMore: true});
  assert.deepEqual(plain(snapshot.result.albums), []);
  assert.deepEqual(plain(snapshot.result.tracks), []);
  assert.equal(h.runtime().createPlaytableSource({rows: [],
    context: {scopeKey: snapshot.scopeKey, resultId: snapshot.resultId},
    instance: snapshot.sourceIdentity, revision: snapshot.sourceIdentity, isCurrent: () => true}), null,
  'pending progress cannot grant a native action source');
  await h.flush();
  assert.equal(h.requests.length, 1, 'acceptance must not hide an unbounded autofill loop');
  h.click(h.button(/^Continue$/));
  assert.equal(h.requests.length, 2, 'only explicit Continue resumes one bounded witness read');
  const continuation = new URL(h.requests[1].url, h.location);
  assert.equal(continuation.searchParams.get('q'), ':loved');
  assert.equal(continuation.searchParams.get('search_sidebar_cursor'), 'opaque-sidebar');
  assert.equal(continuation.searchParams.get('search_cursor'), null, 'first-witness Sidebar proof has priority');
  assert.equal(continuation.searchParams.get('search_sidebar_only'), null, 'progress resumes the foreground result');
  assert.equal(h.requests[1].options.headers['X-AlbumHaven-Context'], A);
  h.respond(1, packet()); await h.invocations.at(-1).outcome;
  assert.equal(h.runtime().snapshot().status, 'ready');
  assert.equal(h.runtime().continueResults(snapshot), false, 'retired progress cannot replay its cursor');
  assert.equal(h.requests.length, 2, 'completion cannot start another automatic scan');
});

test('unsupported mixed text is surfaced without a broader fallback request', async t => {
  const h = setup(t), pending = h.read(url('Bach :loved'));
  h.respond(0, {ok: false, error_code: 'unsupported_private_search_combination',
    error: 'Unsupported search combination.', location: {start: 0, end: 4}}, 400);
  const result = await pending;
  assert.ok(result.error, 'unsupported criteria is a visible failure, not ready empty');
  assert.equal(h.applied.length, 0);
  assert.equal(h.requests.length, 1);
});

for (const status of [401, 403, 409]) {
  test(`current ${status} removes previously admitted personal visuals`, async t => {
    const h = setup(t), first = h.read(url(':loved'));
    h.respond(0, packet()); await first;
    assert.equal(h.applied.length, 1, 'fixture must first reach the real successful apply seam');
    const next = h.read(url(':obsessed'));
    h.respond(1, {ok: false, error_code: status === 409 ? 'stale_context' : 'private_search_forbidden',
      error: 'Search unavailable.'}, status);
    await next;
    assert.equal((h.context.state.view?.artist_groups || []).length, 0,
      'current authentication/context failure must remove personal visual snapshot');
  });
}

test('account switch discards late bounded personal result continuation', async t => {
  const h = setup(t), first = h.read(url(':loved'));
  h.respond(0, packet(':loved', {page: {limit: 50, returned_count: 1, has_more: true, next_cursor: 'opaque-next'}}));
  await first;
  assert.equal(h.applied.length, 1);
  const pending = h.read(`${url(':loved')}&search_cursor=opaque-next&omit_sidebar=1`);
  switchContext(h, 'account');
  h.respond(1, packet(':loved', {sidebar: null}));
  await pending;
  assert.equal(h.applied.length, 1, 'late page may not replace or append to a retired result');
});

test('context switch discards late Search-bound detail response before decoration', async t => {
  const h = setup(t);
  const pending = h.read(`${url(':loved')}&search_detail_album_ref=inventory-album%3A9%3A101&search_page_size=50`);
  switchContext(h, 'library');
  const detail = packet(':loved', {presentation: 'album_detail', album_ref: 'inventory-album:9:101',
    tracks: [{inventory_track_ref: 'inventory-track:9:201', canonical_track_ref: null,
      title: 'Detail witness', artist: 'Witness Artist', album: 'Qualified album', duration_seconds: 90,
      disc_number: 1, track_number: 1, parent_album: {album_ref: 'inventory-album:9:101',
        name: 'Qualified album', year: 2020, allowed_actions: {can_read: true, can_view_details: true}},
      allowed_actions: {can_read: true, can_select: true}, matches_search: true, match_state: 'known'}]});
  delete detail.artist_groups; delete detail.sidebar;
  delete detail.selected_artist; delete detail.selection_state;
  h.respond(0, detail); await pending;
  assert.equal(h.applied.length, 0, 'retired detail witness must never reach decoration/state');
});
