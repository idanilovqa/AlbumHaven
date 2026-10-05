const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { before, test } = require('node:test');

const helperPath = path.join(__dirname, '../../../music_app/static/js/runtime/collection-action-state.js');
const actionNames = ['play', 'playModes', 'filter', 'resetFilters', 'add', 'createAlbumTop', 'createSamplePlaylist'];
const decisionNames = ['play', 'filter', 'resetFilters', 'add', 'createAlbumTop', 'createSamplePlaylist'];
const granted = Object.freeze(Object.fromEntries(decisionNames.map(name => [name, true])));
let getCollectionActionState;

before(() => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  assert.equal(typeof context.getCollectionActionState, 'function');
  getCollectionActionState = context.getCollectionActionState;
});

function ready(overrides = {}) {
  return { kind: 'top', status: 'ready', canonicalCount: 3, visibleCount: 3,
    allowedActions: { ...granted }, ...overrides };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function action(enabled, reason = '', visible = true) {
  return { visible, enabled, reason };
}

function allActions(enabled, reason = '', playModesVisible = true) {
  return Object.fromEntries(actionNames.map(name => [name,
    action(enabled, reason, name !== 'playModes' || playModesVisible)]));
}

function assertUnavailable(input, state, reason) {
  assert.deepEqual(plain(getCollectionActionState(input)), {
    state, actions: allActions(false, reason, false),
  });
}

for (const kind of ['top', 'playlist', 'album']) {
  test(`${kind}: canonical-empty hides modes and preserves authorized Add and Reset`, () => {
    assert.deepEqual(plain(getCollectionActionState(ready({ kind, canonicalCount: 0, visibleCount: 0 }))), {
      state: 'empty',
      actions: {
        play: action(false, 'empty_resource'),
        playModes: action(false, 'empty_resource', false),
        filter: action(false, 'empty_resource'),
        resetFilters: action(true),
        add: action(true),
        createAlbumTop: action(false, 'empty_resource'),
        createSamplePlaylist: action(false, 'empty_resource'),
      },
    });
  });

  test(`${kind}: populated membership composes with explicit action decisions`, () => {
    assert.deepEqual(plain(getCollectionActionState(ready({ kind }))), {
      state: 'populated', actions: allActions(true),
    });
  });

  test(`${kind}: filtered-empty preserves canonical eligibility and usable Reset`, () => {
    assert.deepEqual(plain(getCollectionActionState(ready({ kind, visibleCount: 0 }))), {
      state: 'filtered_empty', actions: allActions(true),
    });
  });
}

for (const status of ['unknown', 'loading', 'error', 'denied']) {
  test(`${status} is unavailable rather than empty, even with granted actions`, () => {
    const input = { kind: 'playlist', status, allowedActions: { ...granted },
      disabledReasons: { add: 'locked' } };
    assertUnavailable(input, status, `resource_${status}`);
    Object.defineProperties(input, {
      canonicalCount: { get() { throw new Error('Non-ready counts must not be read'); } },
      visibleCount: { get() { throw new Error('Non-ready counts must not be read'); } },
    });
    assertUnavailable(input, status, `resource_${status}`);
  });
}

test('missing or unrecognized status remains unknown without coercion', () => {
  for (const status of [undefined, null, '', 'READY', 'success', true, 1, {}, ['ready']]) {
    assertUnavailable(ready({ status, canonicalCount: 0, visibleCount: 0 }), 'unknown', 'resource_unknown');
  }
});

test('invalid resource containers and kinds fail closed before status or membership', () => {
  for (const input of [undefined, null, [], 'top', 1, true, () => {}]) {
    assertUnavailable(input, 'invalid', 'invalid_resource');
  }
  for (const kind of [undefined, null, '', 'Top', 'favorites', 'sample', 1, {}, ['top']]) {
    for (const status of ['ready', 'loading']) {
      assertUnavailable(ready({ kind, status }), 'invalid', 'invalid_resource');
    }
  }
});

test('ready counts reject missing, coerced, fractional, unsafe and inconsistent values', () => {
  const invalidCounts = [undefined, null, '', '0', false, true, -1, 0.5,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, [], {}, 0n];
  for (const value of invalidCounts) {
    assertUnavailable(ready({ canonicalCount: value, visibleCount: 0 }), 'invalid', 'invalid_counts');
    assertUnavailable(ready({ canonicalCount: 3, visibleCount: value }), 'invalid', 'invalid_counts');
  }
  assertUnavailable(ready({ canonicalCount: 0, visibleCount: 1 }), 'invalid', 'invalid_counts');
  assertUnavailable(ready({ canonicalCount: 3, visibleCount: 4 }), 'invalid', 'invalid_counts');
});

test('safe integer boundary counts retain their real empty or populated state', () => {
  assert.equal(getCollectionActionState(ready({ canonicalCount: -0, visibleCount: 0 })).state, 'empty');
  assert.deepEqual(plain(getCollectionActionState(ready({
    canonicalCount: Number.MAX_SAFE_INTEGER, visibleCount: Number.MAX_SAFE_INTEGER,
  }))), { state: 'populated', actions: allActions(true) });
  assert.deepEqual(plain(getCollectionActionState(ready({
    canonicalCount: Number.MAX_SAFE_INTEGER, visibleCount: 0,
  }))), { state: 'filtered_empty', actions: allActions(true) });
});

test('only exact true grants enable actions, including play modes and Reset', () => {
  for (const value of [undefined, false, null, 0, 1, 'true', {}, [], new Boolean(true)]) {
    const allowedActions = Object.fromEntries(decisionNames.map(name => [name, value]));
    assert.deepEqual(plain(getCollectionActionState(ready({ allowedActions }))), {
      state: 'populated', actions: allActions(false, 'not_allowed'),
    });
  }
  assert.deepEqual(plain(getCollectionActionState(ready({ allowedActions: {} }))), {
    state: 'populated', actions: allActions(false, 'not_allowed'),
  });
});

test('action maps require object containers and own grants and reasons', () => {
  for (const allowedActions of [undefined, null, true, 'true', 1,
    Object.assign([], granted), Object.assign(() => {}, granted)]) {
    assert.deepEqual(plain(getCollectionActionState(ready({ allowedActions }))), {
      state: 'populated', actions: allActions(false, 'not_allowed'),
    });
  }
  const allowedActions = Object.create(granted, { add: { value: true, writable: true, enumerable: true, configurable: true } });
  const disabledReasons = Object.create({ play: 'inherited_denial', filter: 'inherited_denial' });
  assert.deepEqual(plain(getCollectionActionState(ready({ allowedActions, disabledReasons }))), {
    state: 'populated', actions: { ...allActions(false, 'not_allowed'), add: action(true) },
  });
  assert.deepEqual(plain(getCollectionActionState(ready({
    allowedActions: Object.assign(Object.create(null), granted),
  }))), { state: 'populated', actions: allActions(true) });
});

test('explicit denial reasons take precedence over emptiness, including locked Add', () => {
  const allowedActions = Object.fromEntries(decisionNames.map(name => [name, false]));
  const disabledReasons = { play: 'media_denied', filter: 'scope_denied', resetFilters: 'no_active_filters',
    add: 'locked', createAlbumTop: 'destination_denied', createSamplePlaylist: 'readonly' };
  for (const canonicalCount of [0, 3]) {
    assert.deepEqual(plain(getCollectionActionState(ready({
      canonicalCount, visibleCount: canonicalCount, allowedActions, disabledReasons,
    }))), {
      state: canonicalCount === 0 ? 'empty' : 'populated',
      actions: {
        play: action(false, 'media_denied'),
        playModes: action(false, 'media_denied', canonicalCount > 0),
        filter: action(false, 'scope_denied'),
        resetFilters: action(false, 'no_active_filters'),
        add: action(false, 'locked'),
        createAlbumTop: action(false, 'destination_denied'),
        createSamplePlaylist: action(false, 'readonly'),
      },
    });
  }
});

test('reasons preserve exact nonempty strings and never coerce other values', () => {
  const uncoercible = { toString() { throw new Error('Reason must not be coerced'); } };
  for (const value of [undefined, null, '', false, 1, [], uncoercible]) {
    const result = getCollectionActionState(ready({ allowedActions: {}, disabledReasons: { add: value } }));
    assert.deepEqual(plain(result.actions.add), action(false, 'not_allowed'));
  }
  for (const reason of [' locked ', '   ']) {
    const result = getCollectionActionState(ready({ allowedActions: {}, disabledReasons: { add: reason } }));
    assert.deepEqual(plain(result.actions.add), action(false, reason));
  }
  for (const disabledReasons of [null, 'locked', Object.assign([], { add: 'locked' })]) {
    const result = getCollectionActionState(ready({ allowedActions: {}, disabledReasons }));
    assert.deepEqual(plain(result.actions.add), action(false, 'not_allowed'));
  }
  assert.deepEqual(plain(getCollectionActionState(ready({
    disabledReasons: Object.fromEntries(decisionNames.map(name => [name, 'stale_denial'])),
  }))), { state: 'populated', actions: allActions(true) });
});

test('Reset follows its filter owner independently of membership and filter permission', () => {
  for (const canonicalCount of [0, 3]) {
    const input = ready({ canonicalCount, visibleCount: 0, allowedActions: { resetFilters: true } });
    const result = getCollectionActionState(input);
    assert.deepEqual(plain(result.actions.resetFilters), action(true));
    assert.deepEqual(plain(result.actions.filter), action(false, 'not_allowed'));
    assert.deepEqual(plain(result.actions.add), action(false, 'not_allowed'));
    assert.deepEqual(plain(getCollectionActionState({ ...input,
      allowedActions: { filter: true, resetFilters: 'true' },
    }).actions.resetFilters), action(false, 'not_allowed'));
  }
});

test('a populated sample-origin Playlist retains authorized Create Album Top', () => {
  const input = ready({ kind: 'playlist', isSample: true, origin: 'sample', source: 'sample_playlist' });
  assert.deepEqual(plain(getCollectionActionState(input).actions.createAlbumTop), action(true));
  assert.deepEqual(plain(getCollectionActionState({ ...input,
    allowedActions: { ...granted, createAlbumTop: false },
    disabledReasons: { createAlbumTop: 'destination_denied' },
  }).actions.createAlbumTop), action(false, 'destination_denied'));
});

test('derived Favorites use actual projected membership rather than cached manual data', () => {
  const metadata = { kind: 'top', source: 'favorites', cachedCount: 50, manualItems: ['stale-item'] };
  const empty = getCollectionActionState(ready({ ...metadata, canonicalCount: 0, visibleCount: 0 }));
  assert.equal(empty.state, 'empty');
  assert.deepEqual(plain(empty.actions.playModes), action(false, 'empty_resource', false));
  const populated = getCollectionActionState(ready({ ...metadata, canonicalCount: 2, visibleCount: 2,
    cachedCount: 0, manualItems: [] }));
  assert.deepEqual(plain(populated), { state: 'populated', actions: allActions(true) });
  assert.equal(getCollectionActionState(ready({ ...metadata, canonicalCount: 2, visibleCount: 0 })).state,
    'filtered_empty');
});

test('populated public readonly and media-denied collections gain no denied actions', () => {
  for (const kind of ['top', 'playlist', 'album']) {
    assert.deepEqual(plain(getCollectionActionState(ready({ kind, role: 'owner', locked: false,
      scope: 'all', allowedActions: undefined }))), {
      state: 'populated', actions: allActions(false, 'not_allowed'),
    });
    const result = getCollectionActionState(ready({ kind, role: 'owner', locked: false, scope: 'all',
      public: true, readonly: true, allowedActions: { ...granted, play: false, playModes: true, add: false,
        createAlbumTop: false, createSamplePlaylist: false },
      disabledReasons: { play: 'media_denied', add: 'readonly', createAlbumTop: 'readonly',
        createSamplePlaylist: 'readonly' } }));
    assert.deepEqual(plain(result), {
      state: 'populated', actions: { ...allActions(true), play: action(false, 'media_denied'),
        playModes: action(false, 'media_denied'), add: action(false, 'readonly'),
        createAlbumTop: action(false, 'readonly'), createSamplePlaylist: action(false, 'readonly') },
    });
  }
});

test('projection is deterministic, does not mutate inputs and returns unaliased objects', () => {
  const input = ready({ visibleCount: 0, disabledReasons: { add: 'unused' } });
  const snapshot = plain(input);
  const first = getCollectionActionState(input);
  const second = getCollectionActionState(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(plain(first), plain(second));
  assert.notEqual(first, second);
  assert.notEqual(first.actions, second.actions);
  for (const name of actionNames) {
    assert.notEqual(first.actions[name], second.actions[name]);
    assert.notEqual(first.actions[name], input.allowedActions);
    assert.notEqual(first.actions[name], input.disabledReasons);
  }
  assert.deepEqual(plain(getCollectionActionState(Object.freeze({ ...input,
    allowedActions: Object.freeze({ ...input.allowedActions }),
    disabledReasons: Object.freeze({ ...input.disabledReasons }),
  }))), plain(first));
});
