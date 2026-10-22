// Independent additive boundary regressions; original 210 cases stay unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});

for (const [name, destination] of [
  ['saved Top UUID with a trailing line feed', {topRef: F.TOP + '\n', q: ''}],
  ['present undefined query', {artistScope: {root_artist_id: '1', mode: 'artist'}, q: undefined}],
]) {
  test('scoped listing rejects ' + name + ' before transport', async t => {
    const calls = [];
    const providers = createAlbumTopBackendProviders({acceptsScope: key => key === F.SCOPE,
      transport: {context: () => 'a'.repeat(64), async request(path, options) {
        calls.push({path, options});
        return {status: 'ready', context_ref: 'a'.repeat(64), data: {albums: [], next_cursor: null}};
      }}});
    t.after(() => {providers.dispose(); assert.deepEqual(calls, [], 'No transport call may be hidden by rejection');});
    await assert.rejects(providers.listScopedAlbums({scopeKey: F.SCOPE,
      signal: new AbortController().signal, ...destination}));
    assert.deepEqual(calls, []);
  });
}
