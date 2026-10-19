'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const filename = path.join(root, 'music_app/static/js/runtime/resource-selection.js');
const source = fs.readFileSync(filename, 'utf8');
const unexpectedAction = () => assert.fail('Capability checks must not execute a resource action');
// Load the complete production owner. These boundary functions make every
// Album intent available, without hydrating, mounting, or presenting anything.
const context = vm.createContext({
  window: {},
  fetchTrackModalAlbumDetails: unexpectedAction,
  acquireTrackModalSelection: unexpectedAction,
  presentMobileAlbumPage: unexpectedAction,
  handleSidebarArtistSelectionClick: unexpectedAction,
  usesMobilePageLayout: () => true,
});
vm.runInContext(source, context, { filename });
const api = context.window.AlbumHavenResourceSelection;
const plain = value => JSON.parse(JSON.stringify(value));
const intents = ['open', 'artwork', 'page', 'embed', 'artist_gallery'];
const albumIntents = ['open', 'artwork', 'page', 'embed'];
const uuid = 'a1234567-89ab-cdef-0123-456789abcdef';
const otherUuid = 'b2345678-9abc-def0-1234-56789abcdef0';
const variants = [
  { source: 'album_top', identities: ['top_ref', 'item_ref'], revision: 'revision',
    origin: { source: 'album_top', top_ref: uuid, item_ref: otherUuid, revision: '17' } },
  { source: 'playlist_album_top_preview', identities: ['preview_ref', 'playlist_ref', 'album_ref'], revision: 'snapshot_ref',
    origin: { source: 'playlist_album_top_preview', preview_ref: uuid, playlist_ref: otherUuid,
      album_ref: 'c3456789-abcd-ef01-2345-6789abcdef01', snapshot_ref: '29' } },
];

function albumTarget(origin) {
  return { kind: 'album', ref: 'public-album', origin,
    allowed_actions: { can_view_details: true },
    native_actions: { album_ref: 'native-album', allowed_actions: {
      can_open_album: true, can_play_album: true, can_view_artwork: true, can_open_album_page: true,
    } },
  };
}

test('full runtime publishes the frozen native selection API', () => {
  assert.ok(Object.isFrozen(api));
  assert.equal(typeof api.projectOrigin, 'function');
  assert.equal(typeof api.projectTarget, 'function');
  assert.equal(typeof api.create, 'function');
});

for (const variant of variants) {
  test(`${variant.source} round-trips exact canonical fields into a detached frozen origin`, () => {
    const input = { ...variant.origin };
    const projected = api.projectOrigin(input);
    assert.deepEqual(plain(projected), input);
    assert.deepEqual(Object.keys(projected), Object.keys(variant.origin));
    assert.notEqual(projected, input);
    assert.ok(Object.isFrozen(projected));
    assert.equal(Object.isFrozen(input), false, 'projection must not freeze caller-owned data');
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    assert.deepEqual(plain(api.projectOrigin(reversed)), input);
    assert.deepEqual(Object.keys(api.projectOrigin(reversed)), Object.keys(variant.origin));
    input[variant.identities[0]] = otherUuid;
    input[variant.revision] = '99';
    assert.deepEqual(plain(projected), variant.origin);
    for (const revision of ['1', '9007199254740993', '9223372036854775807']) {
      const origin = { ...variant.origin, [variant.revision]: revision };
      assert.deepEqual(plain(api.projectOrigin(origin)), origin, `preserves exact revision ${revision}`);
    }
  });

  test(`${variant.source} rejects every missing field and unrecognized extra fields`, () => {
    for (const key of Object.keys(variant.origin)) {
      const incomplete = { ...variant.origin };
      delete incomplete[key];
      assert.equal(api.projectOrigin(incomplete), null, `missing ${key}`);
    }
    for (const [key, value] of [
      ['account_ref', uuid], ['allowed_actions', { can_open_album: true }],
      ['native_actions', {}], ['kind', 'albums'], ['period', 'all'], ['unexpected', undefined],
      [variant.revision === 'revision' ? 'snapshot_ref' : 'revision', '1'],
    ]) {
      assert.equal(api.projectOrigin({ ...variant.origin, [key]: value }), null, `extra ${key}`);
    }
    assert.equal(api.projectOrigin(Object.assign([], variant.origin)), null, 'array masquerading as origin');
  });

  test(`${variant.source} requires each identity to be a canonical lowercase UUID string`, () => {
    const invalid = [undefined, null, 1, 1n, true, {}, [], [uuid], new String(uuid),
      '', uuid.toUpperCase(), ` ${uuid}`, `${uuid} `, `${uuid}\n`, `${uuid}\r`, `${uuid}\u2028`,
      uuid.replaceAll('-', ''), `{${uuid}}`, `urn:uuid:${uuid}`, `g${uuid.slice(1)}`, `${uuid}0`];
    for (const key of variant.identities) {
      for (const value of invalid) {
        assert.equal(api.projectOrigin({ ...variant.origin, [key]: value }), null,
          `${key} rejects ${String(value)}`);
      }
    }
  });

  test(`${variant.source} rejects noncanonical, nonpositive, and overflowing revision strings`, () => {
    const invalid = [undefined, null, 1, 1n, true, {}, [], ['1'], new String('1'),
      '', '0', '-1', '+1', '01', '0001', ' 1', '1 ', '1\n', '1\r', '1\u2028', '1.0', '1e3', '0x1',
      '9223372036854775808', '9999999999999999999', '10000000000000000000'];
    for (const value of invalid) {
      assert.equal(api.projectOrigin({ ...variant.origin, [variant.revision]: value }), null,
        `${variant.revision} rejects ${String(value)}`);
    }
  });

  test(`${variant.source} survives target projection without inventing permissions`, () => {
    const target = api.projectTarget({ kind: 'album', ref: 'public-album', origin: variant.origin });
    assert.deepEqual(plain(target), { kind: 'album', ref: 'public-album',
      allowed_actions: { can_view_details: false }, origin: variant.origin });
    assert.ok(Object.isFrozen(target));
    assert.ok(Object.isFrozen(target.origin));
    assert.ok(Object.isFrozen(target.allowed_actions));
    assert.equal(Object.hasOwn(target, 'native_actions'), false);
    const granted = api.projectTarget(albumTarget(variant.origin));
    assert.deepEqual(plain(granted), albumTarget(variant.origin));
    assert.ok(Object.isFrozen(granted.native_actions));
    assert.ok(Object.isFrozen(granted.native_actions.allowed_actions));
  });

  test(`${variant.source} invalid origins invalidate otherwise granted targets`, () => {
    for (const origin of [
      { ...variant.origin, [variant.identities[0]]: uuid.toUpperCase() },
      { ...variant.origin, [variant.revision]: '0' },
      { ...variant.origin, account_ref: uuid },
    ]) {
      assert.equal(api.projectTarget(albumTarget(origin)), null);
    }
  });

  test(`${variant.source} cannot authorize any intent without a readable bound source`, () => {
    const target = albumTarget(variant.origin);
    const selectionContext = { scopeKey: 'scope', origin: variant.origin };
    for (const options of [{}, { sourceResource: () => null },
      { sourceResource: () => { throw new Error('source unavailable'); } }]) {
      const owner = api.create(options);
      for (const intent of intents) {
        assert.equal(owner.canResourceIntent(intent, target, selectionContext), false, intent);
      }
    }
    const owner = api.create({ sourceResource: () => target });
    const ungranted = { kind: 'album', ref: target.ref, origin: variant.origin };
    for (const intent of intents) {
      assert.equal(owner.canResourceIntent(intent, ungranted, selectionContext), false, intent);
    }
  });

  test(`${variant.source} defers action authority to the current scoped source grants`, () => {
    const target = albumTarget(variant.origin);
    const selectionContext = { scopeKey: 'scope', origin: variant.origin };
    let current = target;
    const owner = api.create({ sourceResource: (requested, requestedContext) => {
      assert.deepEqual(plain(requested.origin), variant.origin);
      return requestedContext.scopeKey === 'scope'
        && JSON.stringify(requestedContext.origin) === JSON.stringify(variant.origin) ? current : null;
    } });
    for (const intent of albumIntents) {
      assert.equal(owner.canResourceIntent(intent, target, selectionContext), true, `bound ${intent}`);
      assert.equal(owner.canResourceIntent(intent, target, { ...selectionContext, scopeKey: 'elsewhere' }), false);
    }
    for (const deniedSource of [null, { ...target, source_readable: false },
      { ...target, ref: 'another-album' }, { ...target, allowed_actions: { can_view_details: false } },
      { ...target, native_actions: { album_ref: 'native-album', allowed_actions: { can_open_album: false } } }]) {
      current = deniedSource;
      for (const intent of albumIntents) {
        assert.equal(owner.canResourceIntent(intent, target, selectionContext), false, `revoked ${intent}`);
      }
    }
    current = { ...target, native_actions: { album_ref: 'native-album', allowed_actions: {
      can_open_album: true, can_view_artwork: false, can_open_album_page: false,
    } } };
    assert.equal(owner.canResourceIntent('embed', target, selectionContext), true);
    assert.equal(owner.canResourceIntent('artwork', target, selectionContext), false);
    assert.equal(owner.canResourceIntent('page', target, selectionContext), false);
    assert.equal(owner.canResourceIntent('open', target, selectionContext), false, 'mobile open respects page restriction');
  });

  test(`${variant.source} rejects malformed or mismatched context before consulting the source`, () => {
    const target = albumTarget(variant.origin);
    let sourceReads = 0;
    const owner = api.create({ sourceResource: () => { sourceReads++; return target; } });
    for (const origin of [
      { ...variant.origin, [variant.revision]: '0' },
      { ...variant.origin, [variant.revision]: '99' },
      { ...variant.origin, [variant.identities[0]]: otherUuid },
    ]) {
      for (const intent of albumIntents) {
        assert.equal(owner.canResourceIntent(intent, target, { scopeKey: 'scope', origin }), false);
      }
    }
    assert.equal(owner.canResourceIntent('open', target, { origin: variant.origin }), false);
    assert.equal(sourceReads, 0, 'invalid context must not reach the source');
  });
}

test('malformed roots and unknown origin discriminators stay rejected', () => {
  for (const value of [undefined, null, false, 1, 'album_top', [], {},
    { ...variants[0].origin, source: 'ALBUM_TOP' },
    { ...variants[1].origin, source: 'playlist_album_top' }]) {
    assert.equal(api.projectOrigin(value), null);
  }
});

test('queue origins retain ordered unique references and their detached frozen array', () => {
  const input = { source: 'queue', occurrence_refs: ['occurrence-a', 'occurrence-b'] };
  const projected = api.projectOrigin(input);
  assert.deepEqual(plain(projected), input);
  assert.ok(Object.isFrozen(projected));
  assert.ok(Object.isFrozen(projected.occurrence_refs));
  assert.notEqual(projected.occurrence_refs, input.occurrence_refs);
  input.occurrence_refs.reverse();
  assert.deepEqual(plain(projected.occurrence_refs), ['occurrence-a', 'occurrence-b']);
  const limit = Array.from({ length: 5000 }, (_, index) => `occurrence-${index}`);
  assert.equal(api.projectOrigin({ source: 'queue', occurrence_refs: limit }).occurrence_refs.length, 5000);
});

test('queue origins retain their bounds, uniqueness, scalar and exact-key checks', () => {
  for (const occurrence_refs of [undefined, null, 'one', [], ['same', 'same'], [''], ['bad\nref'], [1],
    ['x'.repeat(513)], Array.from({ length: 5001 }, (_, index) => `occurrence-${index}`)]) {
    assert.equal(api.projectOrigin({ source: 'queue', occurrence_refs }), null);
  }
  assert.equal(api.projectOrigin({ source: 'queue', occurrence_refs: ['one'], revision: '1' }), null);
});

const ordinaryOrigins = [
  { source: 'recent', kind: 'albums', period: 'week', snapshot_ref: 'recent-snapshot' },
  { source: 'activity', account_ref: 'account-a', kind: 'listens', period: 'month', snapshot_ref: 'activity-snapshot' },
  { source: 'playlist', playlist_ref: 'playlist-a', snapshot_ref: 'playlist-snapshot' },
  { source: 'comparison', account_ref: 'account-b', kind: 'artists', period: 'all', snapshot_ref: 'comparison-snapshot' },
];

for (const origin of ordinaryOrigins) {
  test(`${origin.source} retains its existing origin and target projection`, () => {
    const expected = { ...origin, account_ref: origin.account_ref ?? null };
    const projected = api.projectOrigin({ ...origin, ignored: 'legacy extra key' });
    assert.deepEqual(plain(projected), expected);
    assert.ok(Object.isFrozen(projected));
    assert.deepEqual(plain(api.projectTarget(albumTarget(origin))).origin, expected);
    const withoutSnapshot = { ...origin };
    delete withoutSnapshot.snapshot_ref;
    assert.equal(Object.hasOwn(api.projectOrigin(withoutSnapshot), 'snapshot_ref'), false);
  });
}

test('ordinary origins retain account, kind, period, playlist and snapshot rejection rules', () => {
  for (const value of [
    { source: 'recent', kind: 'albums', period: 'week', account_ref: 'account-a' },
    { source: 'activity', kind: 'unknown', period: 'all' },
    { source: 'comparison', kind: 'tracks', period: 'unknown' },
    { source: 'activity', kind: 'albums', period: 'all', account_ref: 1 },
    { source: 'playlist' }, { source: 'playlist', playlist_ref: '' },
    { source: 'playlist', playlist_ref: 'playlist-a', snapshot_ref: 1 },
  ]) {
    assert.equal(api.projectOrigin(value), null);
  }
});

test('queue and ordinary origins keep source-bound action admission and revocation', () => {
  for (const input of [{ source: 'queue', occurrence_refs: ['occurrence-a'] }, ...ordinaryOrigins]) {
    const origin = api.projectOrigin(input);
    const target = albumTarget(origin);
    let readable = true;
    const owner = api.create({ sourceResource: () => readable ? target : null });
    const selectionContext = { scopeKey: 'scope', origin };
    for (const intent of albumIntents) {
      assert.equal(owner.canResourceIntent(intent, target, selectionContext), true, `${input.source} ${intent}`);
    }
    readable = false;
    for (const intent of albumIntents) {
      assert.equal(owner.canResourceIntent(intent, target, selectionContext), false, `${input.source} revoked ${intent}`);
    }
  }
});
