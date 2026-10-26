// This checks ordinary-unit composition with whole current runtime owners and
// the original synthetic transport/paint fixtures. It does not establish private
// Search authority, real authentication, server, persistence or browser behavior.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {ordinaryNativeState, loadNativeResponseState} = require('./ordinary-native-state-fixture.cjs');
const vm = require('node:vm');
const {URL, URLSearchParams} = require('node:url');
const companion = require('./shared-request-unit-fixture.cjs');
const originalAuthority = require('./loose-authority-harness.cjs');
const {runtimeRoot, browsePayload} = originalAuthority;

test('the complete current classifier owner provides its real expression and URL behavior', () => {
  const context = vm.createContext({});
  assert.equal(companion.installRequestClassification(context, runtimeRoot), context);
  assert.equal(context.URL, URL);
  assert.equal(context.URLSearchParams, URLSearchParams);
  for (const query of ['love:me', '@me', '--@me', 'plain love:me', 'unsupported:anything']) {
    assert.equal(context.isPrivateSearchExpression(query), true, query);
  }
  for (const query of ['', 'ordinary words', 'Love', null, undefined, 7]) {
    assert.equal(context.isPrivateSearchExpression(query), false, String(query));
  }
  for (const url of [
    '/view-data?surface=albums&q=love%3Ame',
    '/view-data?q=plain&q=%40me',
    '/view-data?q=plain&search_presentation=tracks',
    '/view-data?search_unsupported=',
  ]) assert.equal(context.isPrivateSearchRequestUrl(url), true, url);
  for (const url of [
    '/view-data?surface=albums&q=ordinary+words',
    '/view-data?surface=albums&artist=Fixture&gallery_page_size=50',
    '/view-data?surface=PLAYLISTS&q=love%3Ame&search_presentation=tracks',
    '/view-data?surface=%20ALBUM_TOPS%20&q=%40me&search_unknown=1',
  ]) assert.equal(context.isPrivateSearchRequestUrl(url), false, url);
});

test('the actual URL classifier retains its owner closure without replacing unrelated unit seams', () => {
  const seams = {
    buildApiUrl() {}, buildUrl() {}, parseUrlStateFromUrl() {}, parseBrowserUrlState() {},
    pushBrowserViewState() {}, renderView() {}, renderArtistGroups() {}, applyViewPayload() {},
  };
  const context = vm.createContext({...seams, URL, URLSearchParams});
  companion.installRequestClassification(context, runtimeRoot);
  for (const [name, value] of Object.entries(seams)) assert.equal(context[name], value, name);
  const classify = context.isPrivateSearchRequestUrl;
  context.isPrivateSearchExpression = () => {throw new Error('Target expression seam must not be consulted');};
  context.URL = () => {throw new Error('Target URL seam must not be consulted by the isolated owner');};
  assert.equal(classify('/view-data?q=love%3Ame'), true);
  assert.equal(classify('/view-data?q=ordinary'), false);
  assert.equal(vm.runInContext('isPrivateSearchRequestUrl("/view-data?q=%40me")', context), true);
  assert.equal(context.URLSearchParams, URLSearchParams);
});

test('a missing actual classifier owner throws without installing a substitute', () => {
  const context = vm.createContext({});
  assert.throws(() => companion.installRequestClassification(context,
    path.join(runtimeRoot, '__missing_shared_request_owner__')), error => error.code === 'ENOENT');
  assert.equal(context.isPrivateSearchRequestUrl, undefined);
  assert.equal(context.isPrivateSearchExpression, undefined);
});

const families = [
  ['looseAuthority', './loose-authority-harness.cjs', 'createLooseAuthorityFixture'],
  ['looseHistory', './loose-history-privacy-harness.cjs', 'createHistoryFixture'],
  ['looseRevocation', './loose-revocation-regression-harness.cjs', 'fixture'],
  ['topRequest', './album-tops-membership-fixtures/actual-request-fixture.cjs', 'fixture'],
];

for (const [family, modulePath, factoryName] of families) {
  test(`${family} wraps only its returned default sink and preserves the original module exports`, t => {
    const original = require(modulePath), originalFactory = original[factoryName];
    const adapted = companion[family]();
    assert.equal(companion[family](), adapted, 'the lazy module wrapper is stable');
    assert.notEqual(adapted, original);
    assert.notEqual(adapted[factoryName], originalFactory);
    assert.deepEqual(Object.keys(adapted).sort(), Object.keys(original).sort());
    for (const key of Object.keys(original)) {
      if (key !== factoryName) assert.equal(adapted[key], original[key], key);
    }
    const f = family === 'topRequest' ? adapted[factoryName](t) : adapted[factoryName]();
    assert.equal(f.requests.length, 0, 'the original factory has not started a read before composition');
    assert.equal(f.applied.length, 0);
    assert.equal(f.context.URL, URL);
    assert.equal(f.context.URLSearchParams, URLSearchParams);
    assert.equal(f.context.isPrivateSearchRequestUrl('/view-data?q=love%3Ame'), true);
    const payload = browsePayload([]), options = {unitMarker: family};
    assert.equal(f.context.applyViewPayload(payload, options), payload);
    assert.equal(f.context.state.view, payload);
    assert.equal(f.applied.length, 1, 'composition calls the existing sink exactly once');
    assert.equal(f.applied[0].payload, payload);
    assert.equal(f.applied[0].options, options);
    assert.equal(original[factoryName], originalFactory, 'the protected module export is unchanged');
  });
}

test('direct original fixture consumers retain the original void sink', () => {
  const f = originalAuthority.createLooseAuthorityFixture(), payload = browsePayload([]);
  assert.equal(f.context.applyViewPayload(payload, {}), undefined);
  assert.equal(f.state.view, payload);
  assert.equal(f.applied.length, 1);
});

test('the known sink preserves a thrown error and performs no fabricated assignment', () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture();
  const retained = f.state.view, failure = new Error('Existing sink observer failed');
  f.applied.push = () => {throw failure;};
  assert.throws(() => f.context.applyViewPayload(browsePayload([]), {}), error => error === failure);
  assert.equal(f.state.view, retained);
});

test('the bootstrapped real response-state owner and explicit sink restoration retain the assigned result', () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture();
  const sink = f.context.applyViewPayload;
  const actual = f.responseStateOwner;
  assert.equal(actual.captureScope, f.context.captureRuntimeAlbumPreferenceScope);
  f.context.applyViewPayload = actual.applyViewPayload;
  assert.notEqual(f.context.applyViewPayload, sink, 'the real owner can replace the seam normally');
  f.context.applyViewPayload = sink;
  const payload = browsePayload([]);
  assert.equal(f.context.applyViewPayload(payload, {}), payload);
  assert.equal(f.applied.length, 1);
  assert.equal(f.state.view, payload);
});

test('the actual ordinary request owner commits the default sink exact assigned identity', async () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture(), payload = browsePayload([]);
  const pending = f.read('/view-data?surface=albums');
  assert.equal(f.requests.length, 1);
  f.respond(0, payload);
  const result = await pending;
  assert.ifError(result.error);
  assert.equal(result.value, true);
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].payload, payload);
  assert.equal(f.state.view, payload);
  assert.ok(f.paint.some(entry => entry.kind === 'view'));
});

test('a later explicit reentrant sink returns the original identity and the actual request owner rejects it', async () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture();
  const sink = f.context.applyViewPayload, payload = browsePayload([]);
  const successor = browsePayload([], {selected_artist: 'Successor view'});
  let assigned;
  const reentrant = function(payload, options) {
    assigned = sink.call(this, payload, options);
    f.state.view = successor;
    return assigned;
  };
  f.context.applyViewPayload = reentrant;
  const pending = f.read('/view-data?surface=albums');
  f.respond(0, payload);
  const result = await pending;
  assert.ifError(result.error);
  assert.equal(assigned, payload, 'the adapter never substitutes the successor for the original assigned view');
  assert.equal(result.value, false, 'the real request owner observes lost applied-view identity');
  assert.equal(f.state.view, successor);
  assert.equal(f.applied.length, 1);
  assert.equal(f.paint.length, 0);
  assert.equal(f.context.applyViewPayload, reentrant, 'later explicit wrappers are not intercepted');
  assert.equal(Object.getOwnPropertyDescriptor(f.context, 'applyViewPayload').value, reentrant);
});

for (const returned of [undefined, null, false]) {
  test(`a later explicit ${String(returned)} result is preserved without generic apply success`, async () => {
    const f = companion.looseAuthority().createLooseAuthorityFixture(), payload = browsePayload([]);
    const replacement = value => {f.state.view = value; return returned;};
    f.context.applyViewPayload = replacement;
    // Reinstalling classification cannot rewrap a later, unrelated apply seam.
    companion.installRequestClassification(f.context, runtimeRoot);
    assert.equal(f.context.applyViewPayload, replacement);
    const pending = f.read('/view-data?surface=albums');
    f.respond(0, payload);
    const result = await pending;
    assert.ifError(result.error);
    assert.equal(result.value, false);
    assert.equal(f.state.view, payload);
    assert.equal(f.applied.length, 0);
    assert.equal(f.paint.length, 0);
    assert.equal(f.context.applyViewPayload, replacement);
  });
}


test('missing whole response owner fails without installing an authority substitute', () => {
  const context = vm.createContext({});
  assert.throws(() => loadNativeResponseState(context,
    path.join(runtimeRoot, '__missing_response_owner__')), error => error.code === 'ENOENT');
  assert.equal(context.captureRuntimeAlbumPreferenceScope, undefined);
  assert.equal(context.admitRuntimeAlbumPreferenceRead, undefined);
});

test('Album hydration cannot dispatch when its genuine response owner is absent', async () => {
  const requests = [], shell = {dataset: {nativeAccountId: '7', nativeLibraryId: '9'}};
  const context = vm.createContext({state: {ui: {}, view: {}, player: {}, status: {}},
    window: {}, document: {getElementById: id => id === 'app-shell' ? shell : null},
    PrivateUITransport: {generation: () => 1}, fetch: (...args) => requests.push(args)});
  for (const file of ['track-actions.js', 'track-modal-lightbox-helpers.js'])
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), context, {filename: file});
  await assert.rejects(context.fetchTrackModalAlbumDetails('unavailable-owner'),
    /captureRuntimeAlbumPreferenceScope is not defined/);
  assert.equal(requests.length, 0);
});

test('whole response owner does not fabricate Album taste authority from ordinary Track receipt context', () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture();
  assert.equal(f.responseStateOwner.captureScope, f.context.captureRuntimeAlbumPreferenceScope);
  assert.equal(f.context.captureRuntimeAlbumPreferenceScope(), null,
    'numeric actor/library without private continuity is not an Album taste scope');
  const copied = {album_ref: 'inventory-album:9:11', context_ref: 'a'.repeat(64),
    rating: 10, is_favorite: true, favorite_override: true, favorite_source: 'personal',
    taste_state: 'available', preference_revision: 1, can_edit: true,
    allowed_actions: {can_manage_album_preferences: true}};
  assert.equal(f.context.normalizeRuntimeAlbumPreference(copied, null), null);
  assert.equal(f.requests.length, 0); assert.equal(f.batches.length, 0);
});

test('ordinary modal initialization cannot hide explicitly invalid current modal state', async () => {
  const f = companion.looseAuthority().createLooseAuthorityFixture();
  assert.equal(f.context.getCurrentTrackModalAlbum(), null);
  f.state.modalReleases = null;
  const result = await f.read('/view-data?surface=albums');
  assert.equal(result.error?.name, 'TypeError');
  assert.match(result.error.message, /Cannot read properties of null/);
  assert.equal(f.requests.length, 0);
});

test('whole bootstrap and core owners provide fresh stopped state without application startup effects', () => {
  const first = ordinaryNativeState(runtimeRoot), second = ordinaryNativeState(runtimeRoot);
  assert.notEqual(first, second); assert.notEqual(first.player.streaming, second.player.streaming);
  assert.equal(first.player.current, null); assert.equal(first.player.playbackQueue, null);
  assert.equal(first.player.streaming.mode, 'stopped'); assert.equal(first.player.streaming.context, null);
  assert.equal(first.player.streaming.node, null); assert.equal(first.player.streaming.socket, null);
  assert.equal(first.modalReleases.length, 0); assert.equal(first.modalReleaseIndex, 0);
});
