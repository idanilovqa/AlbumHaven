// Fresh C3-A reconstruction coverage. This file is source-only until root validation.
// Import the genuine provider owner through the existing fixture; do not replace it.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});

const CONTEXT = 'a'.repeat(64), OTHER_CONTEXT = 'b'.repeat(64), EVIDENCE = 'c'.repeat(64);
const DRAFT = F.id(101), PREPARATION = F.id(102), REQUEST = F.id(103), GROUP = F.id(104);
const ACQUISITION = F.id(105), ADMISSION = F.id(106), OPERATION = F.id(107);
const ZERO = '00000000-0000-0000-0000-000000000000';
const createDestination = () => ({kind: 'create', draft_ref: DRAFT});
const topDestination = () => ({kind: 'top', top_ref: F.TOP, revision: '7'});
const summary = (patch = {}) => ({source_kind: 'remote_summary', provider: 'musicbrainz', entity_kind: 'release-group',
  release_group_id: GROUP, title: 'Remote album', artist_display: 'Credited artist',
  first_release_date: '2000-02-29', primary_type: 'Album', metadata_coverage: 'album_summary_only',
  track_metadata_status: 'unavailable', track_count: null, ...patch});
const searchPayload = (destination = createDestination()) => ({destination, title: 'Remote album', artist: 'Credited artist'});
const searchReply = (patch = {}) => ({context_ref: CONTEXT, destination: createDestination(), limit: 10, candidates: [summary()], ...patch});
const capacity = (patch = {}) => ({legacy_initialized: true, legacy_inspected: 0, counts_complete: true,
  actor_pending_count: 1, actor_pending_bytes: 256, actor_reservations: 0, physical_parents: 1,
  actor_pending_slots_available: 511, actor_pending_bytes_available: 8388352,
  actor_reservation_slots_available: 2, physical_parent_slots_available: 31,
  attempt_slots_remaining: 511, pending_slots_available: 511, pending_bytes_available: 8388352,
  reservation_slots_available: 2, worst_case_new_acquisitions: 511, ...patch});
const parent = (patch = {}) => ({preparation_ref: PREPARATION, form_ref: DRAFT, state: 'ready',
  created_at: '2026-10-17T05:00:00+00:00', accepts_until: '2026-10-17T05:30:00+00:00',
  fully_expires_at: '2026-10-17T06:00:00+00:00', attempt_count: 1, pending_count: 1,
  pending_bytes: 256, reservation_count: 0, capacity: capacity(), ...patch});
const beginPayload = (destination = createDestination()) => ({destination, form_ref: DRAFT});
const beginReply = (patch = {}) => ({version: 2, context_ref: CONTEXT, destination: createDestination(), ...parent(), ...patch});
const acquirePayload = (destination = createDestination()) => ({version: 2, preparation_ref: PREPARATION,
  request_key: REQUEST, destination, release_group_id: GROUP});
const attemptCommon = (destination = createDestination()) => ({version: 2, context_ref: CONTEXT,
  preparation_ref: PREPARATION, request_key: REQUEST, destination});
const pendingReply = (patch = {}) => ({...attemptCommon(), state: 'pending', acquisition_ref: ACQUISITION,
  evidence_version: EVIDENCE, expires_at: '2026-10-17T05:35:00+00:00', album: summary(), ...patch});
const consumedReply = (patch = {}) => ({...attemptCommon(), state: 'consumed', acquisition_ref: ACQUISITION,
  evidence_version: EVIDENCE, consumed_top_ref: F.TOP, consumed_revision: '8', operation_request_key: OPERATION, ...patch});
const statusReply = (patch = {}) => ({version: 2, context_ref: CONTEXT, state: 'status',
  sql_now: '2026-10-17T05:06:00+00:00', capacity: capacity(), parents: [parent({state: 'accepting'})],
  maintenance_required: false, ...patch});
const maintenanceReply = (patch = {}) => ({version: 2, context_ref: CONTEXT, state: 'complete',
  branch: 'none', inspected: 0, removed_facts: 0, removed_attempts: 0, released_bytes: 0,
  more_work: false, capacity: capacity(), ...patch});
const closeReply = (patch = {}) => ({version: 2, context_ref: CONTEXT, state: 'closed',
  preparation_ref: PREPARATION, removed_attempts: 1, removed_facts: 1, released_bytes: 256,
  capacity: capacity(), ...patch});
const refusal = (state, resource) => ({state, resource,
  error: state === 'limit' ? 'remote_acquisition_limit' : 'remote_preparation_maintenance_required', capacity: capacity()});
const pendingSelector = (patch = {}) => ({kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: EVIDENCE, ...patch});
const retainedSelector = (patch = {}) => ({kind: 'remote_retained', admission_ref: ADMISSION, evidence_version: EVIDENCE, ...patch});
const localSelector = () => ({kind: 'local', selected_local_album_id: 11, selected_source_ref: F.SOURCE});
const localSelection = () => ({kind: 'local_catalog', album_ref: F.A});
const receipt = (action, patch = {}) => ({top_ref: F.TOP, revision: '8', action, request_key: OPERATION, ...patch});
const localOptions = () => ({scopeKey: F.SCOPE, signal: new AbortController().signal});
const remoteStep = (path, body, data, extra = {}) => ({channel: 'remote', path, body, data, ...extra});
const localStep = (path, body, data, extra = {}) => ({channel: 'local', path, body, data, ...extra});
const SEARCH = '/album-top-catalog/remote-search', PREPARATIONS = '/album-top-catalog/remote-preparations';
const ACQUIRE = '/album-top-catalog/remote-acquisitions', MAINTAIN = PREPARATIONS + '/maintain';
const CLOSE = PREPARATIONS + '/' + PREPARATION + '/close';

// Each call must consume a deliberately supplied route/body/response. No success
// fallback, owner mock, generic HTTP acceptance, or permissive provider fixture.
function fixture(t, expectedSteps = []) {
  let context = CONTEXT, generation = 4, allowed = true;
  const steps = [...expectedSteps], calls = [], boundaryErrors = [];
  async function take(channel, path, request) {
    calls.push({channel, path, request});
    const step = steps.shift();
    try {
      assert.ok(step, 'Unexpected ' + channel + ' request: ' + path);
      assert.equal(channel, step.channel);
      assert.equal(path, step.path);
      assert.equal(request.expected, CONTEXT);
      assert.ok(request.signal instanceof AbortSignal);
      assert.deepEqual(request.body, step.body);
      assert.equal(request.method, step.body === undefined ? undefined : 'POST');
      if (channel === 'remote') {
        assert.equal(request.expectedGeneration, 4);
        assert.equal(typeof request.isCurrent, 'function');
      } else {
        assert.equal(Object.hasOwn(request, 'expectedGeneration'), false);
        assert.equal(Object.hasOwn(request, 'isCurrent'), false);
      }
      if (step.inspect) step.inspect(request);
    } catch (error) {boundaryErrors.push(error); throw error;}
    const data = step.respond ? await step.respond(request) : step.data;
    return Object.hasOwn(step, 'envelope') ? step.envelope : {status: 'ready', context_ref: CONTEXT, data};
  }
  const transport = {context: () => context, generation: () => generation,
    request: (path, request) => take('local', path, request),
    requestAlbumTopRemote: (path, request) => take('remote', path, request)};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => allowed && scope === F.SCOPE});
  t.after(() => {
    providers.dispose();
    assert.equal(steps.length, 0, 'Unconsumed explicit transport replies');
    assert.equal(calls.length, expectedSteps.length, 'Every network call must have one explicit expected reply');
    assert.equal(boundaryErrors.length, 0, 'Transport-boundary assertions must not be mistaken for expected provider rejection: '
      + boundaryErrors.map(error => error.message).join('; '));
  });
  return {providers, transport, calls, deny() {allowed = false;}, context(value) {context = value;},
    generation(value) {generation = value;},
    options(patch = {}) {return {...localOptions(), remoteContext: providers.remoteContext(), ...patch};}};
}
const isAbort = error => error.name === 'AbortError';
const isRemoteFailure = error => error.status === 502;
const forbiddenFields = ['tracks', 'artwork', 'artwork_url', 'cover_url', 'media_url', 'path', 'local_album_id',
  'selected_source_ref', 'access_token', 'actor_account_id', 'original_session_id', 'library_id', 'command_digest'];
const privateFields = () => Object.fromEntries(forbiddenFields.map(key => [key, 'PRIVATE_SENTINEL']));
function assertNoPrivate(value) {
  assert.equal(JSON.stringify(value).includes('PRIVATE_SENTINEL'), false);
  assert.equal(JSON.stringify(value).includes('"tracks"'), false);
  assert.equal(JSON.stringify(value).includes('"artwork"'), false);
}

test('C2 search uses the exact POST body, limit 10, captured context and projected summary only', async t => {
  const data = searchReply({candidates: [{...summary(), ...privateFields(), acquisition_ref: ACQUISITION,
    evidence_version: EVIDENCE, album_ref: F.A}], ...privateFields()});
  const env = fixture(t, [remoteStep(SEARCH, searchPayload(), data)]);
  const result = await env.providers.searchRemoteAlbums(searchPayload(), env.options());
  assert.deepEqual(result, searchReply());
  assertNoPrivate(result);
  assert.equal(Object.hasOwn(result.candidates[0], 'album_ref'), false);
  assert.equal(Object.hasOwn(result.candidates[0], 'acquisition_ref'), false);
  assert.equal(Object.hasOwn(result.candidates[0], 'evidence_version'), false);
  data.candidates[0].title = 'Changed wire object';
  data.destination.draft_ref = F.OTHER;
  assert.equal(result.candidates[0].title, 'Remote album');
  assert.deepEqual(result.destination, createDestination());
  assert.deepEqual(env.calls.map(call => call.channel), ['remote']);
});

test('C2 top search preserves exact destination revision and does not use a query endpoint', async t => {
  const payload = searchPayload(topDestination()), data = searchReply({destination: topDestination(), candidates: []});
  const env = fixture(t, [remoteStep(SEARCH, payload, data)]);
  assert.deepEqual(await env.providers.searchRemoteAlbums(payload, env.options()), data);
});

for (const target of [createDestination(), topDestination()]) test('begin projects exact ready parent and form binding for ' + target.kind, async t => {
  const expected = beginReply({destination: target});
  const data = {...expected, ...privateFields(), capacity: capacity()};
  const env = fixture(t, [remoteStep(PREPARATIONS, beginPayload(target), data)]);
  assert.deepEqual(await env.providers.beginRemotePreparation(beginPayload(target), env.options()), expected);
  assertNoPrivate(await Promise.resolve(expected));
});

for (const [state, resource] of [['maintenance_required', 'legacy_initialization'], ['limit', 'parents'],
  ['limit', 'attempts'], ['limit', 'reservations'], ['limit', 'pending']]) {
  test('begin and acquisition preserve bounded refusal ' + state + '/' + resource, async t => {
    const reason = refusal(state, resource);
    const begun = {version: 2, context_ref: CONTEXT, ...reason};
    const acquired = {...attemptCommon(), ...reason};
    const env = fixture(t, [remoteStep(PREPARATIONS, beginPayload(), {...begun, ...privateFields()}),
      remoteStep(ACQUIRE, acquirePayload(), {...acquired, ...privateFields()})]);
    assert.deepEqual(await env.providers.beginRemotePreparation(beginPayload(), env.options()), begun);
    assert.deepEqual(await env.providers.acquireRemoteAlbum(acquirePayload(), env.options()), acquired);
    assert.equal(env.calls.length, 2);
  });
}

test('pending acquisition projects the exact source identity and no catalog, track or artwork authority', async t => {
  const expected = pendingReply(), data = pendingReply({album: {...summary(), ...privateFields()}, ...privateFields()});
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), data)]);
  const result = await env.providers.acquireRemoteAlbum(acquirePayload(), env.options());
  assert.deepEqual(result, expected);
  assertNoPrivate(result);
  assert.equal(result.album.track_count, null);
  assert.equal(result.album.track_metadata_status, 'unavailable');
  assert.equal(Object.hasOwn(result, 'album_ref'), false);
  assert.equal(result.acquisition_ref, ACQUISITION);
  assert.notEqual(result.acquisition_ref, result.album.release_group_id);
  data.album.title = 'Changed response';
  assert.equal(result.album.title, 'Remote album');
});

for (const reply of [{...attemptCommon(), state: 'in_flight', retry_after_seconds: 1},
  ...['provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed'].map(error => ({...attemptCommon(), state: 'failed', error}))]) {
  test('acquisition exposes only the explicit ' + reply.state + '/' + (reply.error || 'retry') + ' DTO', async t => {
    const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), {...reply, ...privateFields(), acquisition_ref: ACQUISITION, album: summary()})]);
    assert.deepEqual(await env.providers.acquireRemoteAlbum(acquirePayload(), env.options()), reply);
    assert.equal(env.calls.length, 1, 'Provider projection does not poll or retry');
  });
}

test('consumed acquisition remains a preparation observation and cannot become a membership receipt', async t => {
  const expected = consumedReply(), command = {request_key: OPERATION, title: 'Created Top', description: '',
    draft_ref: DRAFT, selections: [pendingSelector()]};
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), {...expected, album: summary(), ...privateFields()}),
    localStep('/album-tops', command, expected)]);
  const result = await env.providers.acquireRemoteAlbum(acquirePayload(), env.options());
  assert.deepEqual(result, expected);
  assert.equal(Object.hasOwn(result, 'action'), false);
  assert.equal(Object.hasOwn(result, 'top_ref'), false);
  assert.equal(Object.hasOwn(result, 'revision'), false);
  assert.equal(Object.hasOwn(result, 'album'), false);
  await assert.rejects(env.providers.execute('create', command, localOptions()), isRemoteFailure);
});

test('consumed Top acquisition must name the exact destination Top', async t => {
  const data = consumedReply({destination: topDestination()});
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(topDestination()), data)]);
  assert.deepEqual(await env.providers.acquireRemoteAlbum(acquirePayload(topDestination()), env.options()), data);
});

test('status projects all four observable parent states without destination or private storage fields', async t => {
  const parents = ['accepting', 'draining', 'expired', 'closed'].map((state, index) =>
    parent({preparation_ref: F.id(200 + index), state}));
  const expected = statusReply({parents}), data = statusReply({parents: parents.map(row => ({...row, ...privateFields(),
    destination: topDestination()})), ...privateFields()});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, data)]);
  assert.deepEqual(await env.providers.readRemotePreparationState(env.options()), expected);
});

for (const mode of ['reclaim', 'discard_legacy']) {
  test('explicit ' + mode + ' maintenance and close use exact bodies and projected counters', async t => {
    const expectedMaintenance = maintenanceReply({state: 'progress', branch: mode === 'reclaim' ? 'expired_facts' : 'discard_legacy',
      inspected: 1, removed_facts: 1, released_bytes: 256, more_work: true});
    const env = fixture(t, [remoteStep(MAINTAIN, {mode}, {...expectedMaintenance, ...privateFields()}),
      remoteStep(CLOSE, {}, {...closeReply(), ...privateFields()})]);
    assert.deepEqual(await env.providers.maintainRemotePreparations({mode}, env.options()), expectedMaintenance);
    assert.deepEqual(await env.providers.closeRemotePreparation(PREPARATION, env.options()), closeReply());
    assert.equal(env.calls.length, 2, 'more_work does not trigger implicit maintenance');
  });
}

for (const branch of ['legacy_initialization', 'legacy_cleanup', 'discard_legacy', 'expired_reservations',
  'expired_facts', 'parent_reclamation', 'none']) test('maintenance recognizes C2 branch ' + branch, async t => {
  const data = maintenanceReply({branch});
  const env = fixture(t, [remoteStep(MAINTAIN, {mode: 'reclaim'}, data)]);
  assert.deepEqual(await env.providers.maintainRemotePreparations({mode: 'reclaim'}, env.options()), data);
});

const invalidDestinations = [null, [], {kind: 'create', draft_ref: ZERO}, {kind: 'create', draft_ref: DRAFT, revision: '7'},
  {kind: 'create', draft_ref: 'invalid'}, {kind: 'create', draft_ref: DRAFT + '\n'},
  {kind: 'top', top_ref: F.TOP, revision: '7\n'}, {kind: 'top', top_ref: F.TOP, revision: 7},
  {kind: 'top', top_ref: ZERO, revision: '7'}, {kind: 'top', top_ref: F.TOP, revision: '0'},
  {kind: 'top', top_ref: F.TOP, revision: '9223372036854775808'},
  {kind: 'top', top_ref: F.TOP, revision: '7', owner_account_id: 1}];
for (const [index, destination] of invalidDestinations.entries()) test('invalid destination fails before I/O #' + index, async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(destination), env.options()));
  await assert.rejects(env.providers.beginRemotePreparation(beginPayload(destination), env.options()));
  await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(destination), env.options()));
  assert.equal(env.calls.length, 0);
});

for (const [index, patch] of [{title: ''}, {title: '  '}, {title: null}, {artist: 1}, {title: 'x'.repeat(101)},
  {artist: 'x'.repeat(101)}, {title: 'x\n'}, {artist: '\0'}, {title: '\u007f'}, {title: '\ud800'}, {artist: '\udfff'},
  {limit: 10}, {context_ref: CONTEXT}, {provider: 'musicbrainz'}].entries()) {
  test('invalid remote search text or extra input fails before I/O #' + index, async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.searchRemoteAlbums({...searchPayload(), ...patch}, env.options()));
    assert.equal(env.calls.length, 0);
  });
}

test('search bounds count Unicode characters rather than UTF-16 code units', async t => {
  const payload = {...searchPayload(), title: '🎵'.repeat(100), artist: ''};
  const env = fixture(t, [remoteStep(SEARCH, payload, searchReply({candidates: []}))]);
  assert.deepEqual((await env.providers.searchRemoteAlbums(payload, env.options())).candidates, []);
});

for (const [index, patch] of [{limit: 9}, {limit: '10'}, {limit: 100}, {candidates: null},
  {candidates: [summary(), summary()]},
  {candidates: Array.from({length: 11}, (_, n) => summary({release_group_id: F.id(400 + n)}))},
  {destination: topDestination()}, {destination: {kind: 'create', draft_ref: F.OTHER}}].entries()) {
  test('search rejects a malformed C2 page #' + index, async t => {
    const env = fixture(t, [remoteStep(SEARCH, searchPayload(), searchReply(patch))]);
    await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options()));
  });
}

for (const [index, patch] of [{source_kind: 'local'}, {provider: 'other'}, {entity_kind: 'release'},
  {release_group_id: ZERO}, {release_group_id: GROUP + '\n'}, {release_group_id: 'UPPERCASE-INVALID'}, {title: ''}, {title: null},
  {title: 'x'.repeat(1001)}, {title: 'x\0'}, {artist_display: '\ud800'}, {artist_display: []},
  {first_release_date: ''}, {first_release_date: '2000-02-29\n'}, {first_release_date: '0000'}, {first_release_date: '1900-02-29'},
  {first_release_date: '2000-13'}, {first_release_date: '2026-04-31'}, {first_release_date: 2000},
  {primary_type: 'Compilation'}, {primary_type: undefined}, {metadata_coverage: 'complete'},
  {track_metadata_status: 'available'}, {track_count: 0}, {track_count: '0'}].entries()) {
  test('remote summary malformed type, date or unavailable-track contract is rejected #' + index, async t => {
    const env = fixture(t, [remoteStep(SEARCH, searchPayload(), searchReply({candidates: [summary(patch)]}))]);
    await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options()), isRemoteFailure);
  });
}

test('valid partial dates, unknown type and unavailable tracks remain explicit', async t => {
  const candidates = [null, '0001', '2000-02', '2000-02-29', '9999-12-31'].map((first_release_date, n) =>
    summary({release_group_id: F.id(450 + n), first_release_date, primary_type: null}));
  const env = fixture(t, [remoteStep(SEARCH, searchPayload(), searchReply({candidates}))]);
  assert.deepEqual((await env.providers.searchRemoteAlbums(searchPayload(), env.options())).candidates, candidates);
});

for (const [index, patch] of [{version: 1}, {version: '2'}, {state: 'accepting'}, {form_ref: F.OTHER},
  {preparation_ref: ZERO}, {destination: topDestination()}].entries()) {
  test('begin response must match the exact form and ready state #' + index, async t => {
    const env = fixture(t, [remoteStep(PREPARATIONS, beginPayload(), beginReply(patch))]);
    await assert.rejects(env.providers.beginRemotePreparation(beginPayload(), env.options()));
  });
}

for (const [index, payload] of [{...beginPayload(), form_ref: F.OTHER}, {...beginPayload(), form_ref: ZERO},
  {...beginPayload(), state: 'ready'}, {...beginPayload(), context_ref: CONTEXT}].entries()) {
  test('begin rejects mismatched Create form and authority claims before I/O #' + index, async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.beginRemotePreparation(payload, env.options()));
  });
}

for (const [index, patch] of [{version: 1}, {version: '2'}, {preparation_ref: ZERO}, {request_key: ZERO},
  {release_group_id: ZERO}, {preparation_ref: PREPARATION + '\n'}, {request_key: REQUEST + '\n'},
  {release_group_id: GROUP + '\n'}, {acquisition_ref: ACQUISITION}, {evidence_version: EVIDENCE},
  {album: summary()}, {actor_account_id: 1}].entries()) {
  test('acquire permits only the exact C2 command fields #' + index, async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.acquireRemoteAlbum({...acquirePayload(), ...patch}, env.options()));
  });
}

for (const [index, patch] of [{version: 1}, {request_key: F.OTHER}, {preparation_ref: F.OTHER},
  {destination: topDestination()}, {state: 'ready'}, {acquisition_ref: ZERO}, {evidence_version: 'c'.repeat(63)},
  {evidence_version: 'C'.repeat(64)}, {evidence_version: EVIDENCE + '\n'}, {acquisition_ref: ACQUISITION + '\n'}, {expires_at: '2026-10-17'}, {expires_at: '2026-10-17T05:35:00'}, {expires_at: '2026-02-30T05:35:00+00:00'},
  {album: summary({release_group_id: F.OTHER})}, {album: summary({track_count: 2})},
  {state: 'in_flight', retry_after_seconds: '1'}, {state: 'in_flight', retry_after_seconds: 2},
  {state: 'failed', error: 'unknown'}, {state: 'limit', ...refusal('limit', 'pending'), error: 'wrong'},
  {state: 'maintenance_required', ...refusal('maintenance_required', 'legacy_initialization'), resource: 'unknown'}].entries()) {
  test('acquire rejects mismatched identity or malformed state DTO #' + index, async t => {
    const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), pendingReply(patch))]);
    await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(), env.options()));
  });
}

for (const [index, patch] of [{consumed_top_ref: ZERO}, {consumed_revision: 8}, {consumed_revision: '0'},
  {consumed_revision: '9223372036854775808'}, {consumed_revision: '8\n'}, {operation_request_key: ZERO}, {evidence_version: null}].entries()) {
  test('consumed observation requires exact typed receipt hints #' + index, async t => {
    const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), consumedReply(patch))]);
    await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(), env.options()));
  });
}

test('consumed destination cannot redirect to a foreign Top', async t => {
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(topDestination()),
    consumedReply({destination: topDestination(), consumed_top_ref: F.OTHER}))]);
  await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(topDestination()), env.options()), isRemoteFailure);
});

for (const [index, patch] of [{legacy_initialized: 1}, {counts_complete: 'true'}, {counts_complete: false},
  {legacy_inspected: -1}, {actor_pending_count: 1.5}, {actor_pending_bytes: '1'}, {actor_reservations: true},
  {physical_parents: null}, {actor_pending_slots_available: NaN}, {actor_pending_bytes_available: Infinity},
  {actor_reservation_slots_available: Number.MAX_SAFE_INTEGER + 1}, {physical_parent_slots_available: -1},
  {attempt_slots_remaining: false}, {pending_slots_available: '1'}, {pending_bytes_available: -1},
  {reservation_slots_available: 0.5}, {worst_case_new_acquisitions: null}, {unknown_capacity: 1}].entries()) {
  test('capacity exact key set and numeric/boolean types are enforced #' + index, async t => {
    const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({capacity: capacity(patch)}))]);
    await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
  });
}

test('capacity accepts only its four nullable per-parent counts and keeps incomplete legacy counts explicit', async t => {
  const limits = capacity({legacy_initialized: false, counts_complete: false, attempt_slots_remaining: null,
    pending_slots_available: null, pending_bytes_available: null, reservation_slots_available: null});
  const data = statusReply({parents: [], capacity: limits, maintenance_required: true});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, data)]);
  assert.deepEqual(await env.providers.readRemotePreparationState(env.options()), data);
});

test('a missing capacity field is rejected instead of silently supplying zero', async t => {
  const limits = capacity(); delete limits.worst_case_new_acquisitions;
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({capacity: limits}))]);
  await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
});

for (const [index, patch] of [{attempt_count: 513}, {pending_count: 513}, {pending_bytes: 8388609},
  {reservation_count: 3}, {attempt_count: 0}, {pending_count: 0, reservation_count: 1},
  {attempt_count: true}, {pending_count: '1'}, {pending_bytes: -1}, {reservation_count: 0.5},
  {created_at: '2026-10-17'}, {accepts_until: '2026-10-17T05:30:01+00:00'},
  {fully_expires_at: '2026-10-17T05:59:59+00:00'}, {preparation_ref: ZERO}, {form_ref: ZERO}].entries()) {
  test('parent count bounds, identity and SQL lifetime are validated #' + index, async t => {
    const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({parents: [parent({state: 'accepting', ...patch})]}))]);
    await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
  });
}

for (const [index, patch] of [{version: '2'}, {state: 'ready'}, {maintenance_required: 0}, {parents: null},
  {sql_now: 'now'}, {sql_now: '2026-02-30T05:06:00+00:00'}, {parents: [parent()]}, {parents: [parent({state: 'accepting'}), parent({state: 'closed'})]},
  {parents: Array.from({length: 33}, (_, n) => parent({state: 'accepting', preparation_ref: F.id(500 + n)}))}].entries()) {
  test('status is bounded to complete unique non-ready parents #' + index, async t => {
    const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply(patch))]);
    await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
  });
}

for (const [index, patch] of [{version: '2'}, {state: 'pending'}, {branch: 'provider_work'}, {more_work: 1},
  {inspected: 1025}, {removed_facts: 513}, {removed_attempts: 513}, {released_bytes: 8388609},
  {inspected: -1}, {removed_facts: '1'}, {removed_attempts: true}, {released_bytes: 0.5}].entries()) {
  test('maintenance counter bounds and state types reject malformed replies #' + index, async t => {
    const env = fixture(t, [remoteStep(MAINTAIN, {mode: 'reclaim'}, maintenanceReply(patch))]);
    await assert.rejects(env.providers.maintainRemotePreparations({mode: 'reclaim'}, env.options()), isRemoteFailure);
  });
}

for (const payload of [{}, {mode: 'delete'}, {mode: true}, {mode: 'reclaim', all_accounts: true}]) {
  test('maintenance invalid mode or scope never reaches transport', async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.maintainRemotePreparations(payload, env.options()));
  });
}

for (const [index, patch] of [{version: 1}, {state: 'complete'}, {preparation_ref: F.OTHER},
  {removed_facts: 513}, {removed_attempts: 513}, {released_bytes: 8388609}, {removed_facts: '1'}].entries()) {
  test('close requires exact parent and bounded cleanup acknowledgement #' + index, async t => {
    const env = fixture(t, [remoteStep(CLOSE, {}, closeReply(patch))]);
    await assert.rejects(env.providers.closeRemotePreparation(PREPARATION, env.options()), isRemoteFailure);
  });
}

for (const ref of [ZERO, 'invalid', null]) test('invalid close identity never reaches transport', async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.closeRemotePreparation(ref, env.options()));
});

test('maximum C2 parent and maintenance counters are accepted without coercion', async t => {
  const data = statusReply({parents: [parent({state: 'draining', attempt_count: 512, pending_count: 512,
    pending_bytes: 8388608, reservation_count: 2})]});
  const maintained = maintenanceReply({inspected: 1024, removed_facts: 512, removed_attempts: 512, released_bytes: 8388608});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, data), remoteStep(MAINTAIN, {mode: 'reclaim'}, maintained)]);
  assert.deepEqual(await env.providers.readRemotePreparationState(env.options()), data);
  assert.deepEqual(await env.providers.maintainRemotePreparations({mode: 'reclaim'}, env.options()), maintained);
});

test('remote context identity is stable, frozen and changes on generation even for the same context string', t => {
  const env = fixture(t), first = env.providers.remoteContext();
  assert.deepEqual(first, {context: CONTEXT, generation: 4});
  assert.equal(Object.isFrozen(first), true);
  assert.equal(env.providers.remoteContext(), first);
  env.generation(5);
  const next = env.providers.remoteContext();
  assert.notEqual(next, first);
  assert.deepEqual(next, {context: CONTEXT, generation: 5});
});

for (const context of [null, '', 'x'.repeat(64), 'A'.repeat(64)]) test('invalid native context cannot start a remote lifetime', t => {
  const env = fixture(t); env.context(context);
  assert.throws(() => env.providers.remoteContext());
});
for (const generation of [null, '4', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) test('invalid generation cannot start a remote lifetime', t => {
  const env = fixture(t); env.generation(generation);
  assert.throws(() => env.providers.remoteContext());
});

test('a transport without native generation or the opt-in remote method is not silently upgraded', t => {
  for (const missing of ['generation', 'requestAlbumTopRemote']) {
    const env = fixture(t); delete env.transport[missing];
    assert.throws(() => env.providers.remoteContext());
  }
});

for (const kind of ['missing', 'clone', 'foreign-owner', 'old-generation', 'wrong-scope', 'isCurrent-false', 'isCurrent-nonfunction']) {
  test('remote request rejects unowned or retired captured lifetime before I/O: ' + kind, async t => {
    const env = fixture(t), options = env.options();
    if (kind === 'missing') delete options.remoteContext;
    if (kind === 'clone') options.remoteContext = {...options.remoteContext};
    if (kind === 'foreign-owner') options.remoteContext = fixture(t).providers.remoteContext();
    if (kind === 'old-generation') env.generation(5);
    if (kind === 'wrong-scope') options.scopeKey = 'foreign-scope';
    if (kind === 'isCurrent-false') options.isCurrent = () => false;
    if (kind === 'isCurrent-nonfunction') options.isCurrent = true;
    await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), options), isAbort);
    assert.equal(env.calls.length, 0);
  });
}

test('reentrant caller currency validation cannot advance generation and still authorize dispatch', async t => {
  const env = fixture(t), options = env.options({isCurrent() {env.generation(5); return true;}});
  await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), options), isAbort);
  assert.equal(env.calls.length, 0);
});

for (const change of ['scope', 'context', 'generation', 'ABA', 'dispose', 'abort', 'isCurrent']) {
  test('late remote metadata is discarded after ' + change + ' retirement', async t => {
    const gate = F.deferred(), env = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {respond: () => gate.promise})]);
    const abort = new AbortController(); let current = true;
    const options = env.options({signal: abort.signal, isCurrent: () => current});
    const waiting = env.providers.searchRemoteAlbums(searchPayload(), options);
    const rejected = assert.rejects(waiting, isAbort);
    if (change === 'scope') env.deny();
    if (change === 'context') env.context(OTHER_CONTEXT);
    if (change === 'generation') env.generation(5);
    if (change === 'ABA') {env.context(OTHER_CONTEXT); env.generation(5); env.context(CONTEXT); env.generation(6);}
    if (change === 'dispose') env.providers.dispose();
    if (change === 'abort') abort.abort();
    if (change === 'isCurrent') current = false;
    assert.equal(env.calls[0].request.isCurrent(), change === 'abort');
    gate.resolve(searchReply());
    await rejected;
    assert.equal(env.calls.length, 1);
  });
}

test('an already-aborted remote request never dispatches', async t => {
  const env = fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options({signal: abort.signal})), isAbort);
  assert.equal(env.calls.length, 0);
});

for (const status of [401, 403]) test('transport-consumed denial survives its own generation invalidation: ' + status, async t => {
  const denial = Object.assign(new Error('Consumed denial'), {status, responseRejected: true});
  let env;
  env = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {respond() {env.generation(5); throw denial;}})]);
  await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options()), error => error === denial);
});

for (const status of [401, 403, 409, 503]) test('unconsumed stale error is retirement, not a current denial: ' + status, async t => {
  const cause = Object.assign(new Error('Unconsumed failure'), {status});
  let env;
  env = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {respond() {env.generation(5); throw cause;}})]);
  await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options()), isAbort);
});

test('current transport failure is preserved without fabricating an attempt or membership receipt', async t => {
  const cause = Object.assign(new Error('Network outcome unknown'), {status: 503});
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), null, {respond() {throw cause;}})]);
  await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(), env.options()), error => error === cause);
  assert.equal(env.calls.length, 1);
});

for (const [index, envelope] of [null, {status: 'unavailable', context_ref: CONTEXT, data: searchReply()},
  {status: 'ready', context_ref: OTHER_CONTEXT, data: searchReply()},
  {status: 'ready', context_ref: CONTEXT, data: null}, {status: 'ready', context_ref: CONTEXT, data: []},
  {status: 'ready', context_ref: CONTEXT, data: searchReply({context_ref: OTHER_CONTEXT})},
  {status: 'ready', context_ref: CONTEXT, data: {...searchReply(), context_ref: undefined}}].entries()) {
  test('remote projection rejects missing or mismatched inner/outer native context #' + index, async t => {
    const env = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {envelope})]);
    await assert.rejects(env.providers.searchRemoteAlbums(searchPayload(), env.options()), isRemoteFailure);
  });
}

test('typed Create sends local catalog and pending selectors only and requires its exact draft receipt', async t => {
  const command = {request_key: OPERATION, title: 'Mixed Top', description: '', draft_ref: DRAFT,
    selections: [localSelection(), pendingSelector()]};
  const before = F.clone(command), expected = receipt('create', {revision: '1', draft_ref: DRAFT});
  const env = fixture(t, [localStep('/album-tops', command, {...expected, ...privateFields(), acquisition_ref: ACQUISITION})]);
  assert.deepEqual(await env.providers.execute('create', command, localOptions()), expected);
  assert.deepEqual(command, before);
  assert.equal(env.calls[0].channel, 'local', 'Existing membership owner keeps ordinary transport');
  assertNoPrivate(env.calls[0].request.body);
});

test('typed Add preserves ordered local, pending and retained identities without remote preparation requests', async t => {
  const body = {request_key: OPERATION, revision: '7', selections: [localSelection(), pendingSelector(), retainedSelector()]};
  const env = fixture(t, [localStep('/album-tops/' + F.TOP + '/add', body, receipt('add'))]);
  assert.deepEqual(await env.providers.execute('add', {top_ref: F.TOP, ...body}, localOptions()), receipt('add'));
  assert.deepEqual(env.calls[0].request.body.selections, body.selections);
});

test('typed Save retains exact existing IDs and uses typed new-local/new-remote rows', async t => {
  const items = [
    {kind: 'existing', item_ref: F.IA, album_ref: F.A, source: localSelector()},
    {kind: 'existing', item_ref: F.IB, album_ref: F.B, source: retainedSelector()},
    {kind: 'new_local', album_ref: F.C, source: {kind: 'unselected'}},
    {kind: 'new_remote', source: pendingSelector()},
  ];
  const body = {request_key: OPERATION, revision: '7', title: 'Renamed mixed Top', item_selections: items};
  const env = fixture(t, [localStep('/album-tops/' + F.TOP + '/save', body, receipt('save'))]);
  assert.deepEqual(await env.providers.execute('save', {top_ref: F.TOP, ...body}, localOptions()), receipt('save'));
  assert.deepEqual(env.calls[0].request.body.item_selections, items);
  assert.equal(Object.hasOwn(env.calls[0].request.body, 'items'), false);
  assert.equal(Object.hasOwn(items[3], 'album_ref'), false, 'No client-inferred catalog identity for pending remote facts');
});

const typedCreate = () => ({request_key: OPERATION, title: 'Mixed Top', description: '', draft_ref: DRAFT, selections: [pendingSelector()]});
for (const [index, patch] of [{draft_ref: undefined}, {draft_ref: F.OTHER}, {draft_ref: null},
  {request_key: F.OTHER}, {action: 'add'}, {revision: 8}, {top_ref: 'invalid'}].entries()) {
  test('typed Create requires exact action, key, result identity and draft acknowledgement #' + index, async t => {
    const env = fixture(t, [localStep('/album-tops', typedCreate(), receipt('create', {revision: '1', draft_ref: DRAFT, ...patch}))]);
    await assert.rejects(env.providers.execute('create', typedCreate(), localOptions()), isRemoteFailure);
  });
}

for (const [index, patch] of [{draft_ref: ZERO}, {draft_ref: undefined}, {selections: []},
  {selections: [localSelection()]}, {selections: [retainedSelector()]},
  {selections: [pendingSelector(), pendingSelector({evidence_version: 'd'.repeat(64)})]},
  {selections: [pendingSelector({album_ref: F.B})]}, {selections: [pendingSelector({acquisition_ref: ZERO})]},
  {selections: [pendingSelector({evidence_version: 'C'.repeat(64)})]}, {album_refs: [F.A]},
  {selections: [localSelection(), {...localSelection()}, pendingSelector()]},
  {selections: [{...summary(), kind: 'remote_acquisition'}]}].entries()) {
  test('typed Create rejects shape ambiguity, duplicates, retained or forged selections before I/O #' + index, async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.execute('create', {...typedCreate(), ...patch}, localOptions()));
  });
}

for (const [index, items] of [
  [{kind: 'new_remote', album_ref: F.B, source: pendingSelector()}],
  [{kind: 'new_remote', source: localSelector()}],
  [{kind: 'new_local', album_ref: F.A, source: retainedSelector()}],
  [{kind: 'existing', item_ref: null, album_ref: F.A, source: localSelector()}],
  [{kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'local', selected_local_album_id: '11', selected_source_ref: F.SOURCE}}],
  [{kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'unselected', admission_ref: ADMISSION}}],
  [{kind: 'new_remote', source: pendingSelector()}, {kind: 'new_remote', source: pendingSelector({evidence_version: 'd'.repeat(64)})}],
  [{kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'unselected'}},
    {kind: 'existing', item_ref: F.IA, album_ref: F.B, source: retainedSelector()}],
  [{kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'unselected'}},
    {kind: 'new_local', album_ref: F.A, source: localSelector()}],
].entries()) {
  test('typed Save rejects invalid kind/source, identity duplicates and injected fields before I/O #' + index, async t => {
    const env = fixture(t);
    await assert.rejects(env.providers.execute('save', {top_ref: F.TOP, request_key: OPERATION, revision: '7', item_selections: items}, localOptions()));
  });
}

for (const [action, body] of [
  ['add', {draft_ref: DRAFT, selections: [pendingSelector()]}],
  ['save', {items: [], item_selections: []}],
  ['save', {selections: [pendingSelector()]}],
  ['remove', {selections: [pendingSelector()]}],
  ['create', {draft_ref: DRAFT, album_refs: []}],
  ['enable_external', {item_selections: []}],
]) test('typed fields cannot cross action or local command families: ' + action, async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.execute(action, {top_ref: F.TOP, request_key: OPERATION, revision: '7', ...body}, localOptions()));
});

test('typed selection and item arrays retain the server 5000-member bound', async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.execute('create', {...typedCreate(),
    selections: Array.from({length: 5001}, (_, n) => pendingSelector({acquisition_ref: F.id(10000 + n)}))}, localOptions()));
  await assert.rejects(env.providers.execute('save', {top_ref: F.TOP, request_key: OPERATION, revision: '7',
    item_selections: Array.from({length: 5001}, (_, n) => ({kind: 'new_local', album_ref: F.id(20000 + n), source: {kind: 'unselected'}}))}, localOptions()));
  assert.equal(env.calls.length, 0);
});

const mixedSources = () => [
  {kind: 'existing', item_ref: F.IA, album_ref: F.A, source: localSelector()},
  {kind: 'existing', item_ref: F.IB, album_ref: F.B, source: retainedSelector()},
];
function mixedDetail(patch = {}) {
  return {top_ref: F.TOP, revision: '7', title: 'Mixed Top', description: 'Metadata', visibility: 'private',
    allowed_actions: {[F.BROWSE]: true, [F.MANAGE]: true, [F.ITEMS]: true, can_edit: true,
      can_rename: true, can_add: true, can_remove: true, can_reorder: true},
    items: [
      {ref: F.IA, catalog_ref: F.A, title: 'Local album', artist_display: 'Local artist', release_year: 2001, original_position: 4, curator_position: 1},
      {ref: F.IB, catalog_ref: F.B, ...summary(), release_year: 1999, original_position: 9, curator_position: 2},
    ],
    edit_draft: {item_selections: mixedSources(), publication_preview_required: false}, ...patch};
}

test('complete mixed detail pairs retained sources with immutable item/catalog IDs and projects no private material', async t => {
  const data = mixedDetail();
  data.items = data.items.map(row => ({...row, ...privateFields()}));
  data.edit_draft.private_storage = 'PRIVATE_SENTINEL';
  data.access_token = 'PRIVATE_SENTINEL';
  const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data)]);
  const result = await env.providers.read(F.TOP, localOptions());
  assert.deepEqual(result.edit_draft, {item_selections: mixedSources(), publication_preview_required: false});
  assert.deepEqual(result.items[0], {item_ref: F.IA, album_ref: F.A, title: 'Local album', artist: 'Local artist',
    year: 2001, original_position: 4, position: 1});
  assert.deepEqual(result.items[1], {item_ref: F.IB, album_ref: F.B, title: 'Remote album', artist: 'Credited artist',
    year: 2000, original_position: 9, position: 2, ...summary()});
  assert.notEqual(result.items[1].album_ref, GROUP);
  assert.equal(result.edit_draft.item_selections[1].source.admission_ref, ADMISSION);
  assertNoPrivate(result);
  data.edit_draft.item_selections[1].source.admission_ref = F.OTHER;
  data.items[1].catalog_ref = F.C;
  assert.equal(result.edit_draft.item_selections[1].source.admission_ref, ADMISSION);
  assert.equal(result.items[1].album_ref, F.B);
});

test('Manage-only mixed detail keeps complete typed metadata projection while Items actions remain false', async t => {
  const data = mixedDetail({allowed_actions: {[F.BROWSE]: true, [F.MANAGE]: true, [F.ITEMS]: false,
    can_edit: true, can_rename: true, can_add: false, can_remove: false, can_reorder: false}});
  const save = {request_key: OPERATION, revision: '7', title: 'Metadata only', description: 'Changed description'};
  const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data),
    localStep('/album-tops/' + F.TOP + '/save', save, receipt('save'))]);
  const result = await env.providers.read(F.TOP, localOptions());
  assert.deepEqual(result.edit_draft, data.edit_draft);
  assert.equal(result.allowed_actions[F.ITEMS], false);
  assert.equal(result.allowed_actions.can_add, false);
  assert.equal(result.allowed_actions.can_remove, false);
  assert.equal(result.allowed_actions.can_reorder, false);
  assert.deepEqual(await env.providers.execute('save', {top_ref: F.TOP, ...save}, localOptions()), receipt('save'));
  assert.equal(Object.hasOwn(env.calls[1].request.body, 'items'), false);
  assert.equal(Object.hasOwn(env.calls[1].request.body, 'item_selections'), false);
  assert.equal(env.calls.some(call => call.channel === 'remote'), false);
});

for (const change of ['missing-row', 'duplicate-row', 'reordered', 'wrong-item', 'wrong-album', 'remote-as-local',
  'local-as-remote', 'pending-as-retained', 'new-row', 'both-vectors', 'old-vector', 'missing-vector', 'flag-type',
  'bad-source-version', 'unknown-source-kind', 'extra-source-field', 'paginated']) {
  test('mixed detail requires complete ordered exact source pairing: ' + change, async t => {
    const data = mixedDetail(), rows = data.edit_draft.item_selections;
    if (change === 'missing-row') rows.pop();
    if (change === 'duplicate-row') rows[1] = F.clone(rows[0]);
    if (change === 'reordered') rows.reverse();
    if (change === 'wrong-item') rows[1].item_ref = F.id(999);
    if (change === 'wrong-album') rows[1].album_ref = F.C;
    if (change === 'remote-as-local') rows[1].source = localSelector();
    if (change === 'local-as-remote') rows[0].source = retainedSelector({admission_ref: F.id(998)});
    if (change === 'pending-as-retained') rows[1].source = pendingSelector();
    if (change === 'new-row') rows[1] = {kind: 'new_remote', source: retainedSelector()};
    if (change === 'both-vectors') data.edit_draft.items = [];
    if (change === 'old-vector') {delete data.edit_draft.item_selections; data.edit_draft.items = [{item_ref: F.IA, album_ref: F.A}, {item_ref: F.IB, album_ref: F.B}];}
    if (change === 'missing-vector') delete data.edit_draft.item_selections;
    if (change === 'flag-type') data.edit_draft.publication_preview_required = 'false';
    if (change === 'bad-source-version') rows[1].source.evidence_version = 'bad';
    if (change === 'unknown-source-kind') data.items[1].source_kind = 'remote_tracks';
    if (change === 'extra-source-field') rows[1].source.actor_account_id = 1;
    if (change === 'paginated') data.next_cursor = 'more';
    const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data)]);
    await assert.rejects(env.providers.read(F.TOP, localOptions()));
  });
}

test('read-only mixed detail may omit edit authority and never synthesizes selectors', async t => {
  const data = mixedDetail({allowed_actions: {[F.BROWSE]: true, can_edit: false}});
  delete data.edit_draft;
  const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data)]);
  const result = await env.providers.read(F.TOP, localOptions());
  assert.equal(Object.hasOwn(result, 'edit_draft'), false);
  assert.equal(result.items[1].album_ref, F.B);
  assert.equal(Object.hasOwn(result.items[1], 'source'), false);
});

test('remote typed drafts cannot enter the existing local publication preview endpoint', async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.preview(F.TOP, {revision: '7', item_selections: mixedSources()}, localOptions()),
    error => error.code === 'remote_publication_unavailable');
  await assert.rejects(env.providers.preview(F.TOP, {revision: '7', items: [{item_ref: F.IB, album_ref: F.B,
    source_kind: 'remote_summary'}]}, localOptions()), error => error.code === 'remote_publication_unavailable');
  assert.equal(env.calls.length, 0);
});

test('local search, inventory, preview and membership commands retain their exact ordinary routes and bodies', async t => {
  const search = {albums: [F.album()], next_cursor: null};
  const items = [{item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE}];
  const previewPayload = {revision: '7', items};
  const previewData = {top_ref: F.TOP, revision: '7', evidence_revision: EVIDENCE,
    items: [{...items[0], title: 'Local album', artist: 'Artist', year: 2001, track_count: 3}]};
  const create = {request_key: OPERATION, title: 'Local Top', description: '', album_refs: [F.A]};
  const add = {request_key: OPERATION, revision: '7', album_refs: [F.A]};
  const save = {request_key: OPERATION, revision: '7', title: 'Local Top', items};
  const env = fixture(t, [
    localStep('/album-top-catalog/search?limit=100&q=Local', undefined, search),
    localStep('/album-top-catalog/inventory', {album_id: 11}, {album_ref: F.A}),
    localStep('/album-tops/' + F.TOP + '/catalog/inventory', {album_id: 11}, {album_ref: F.A}),
    localStep('/album-tops/' + F.TOP + '/publication-preview', previewPayload, previewData),
    localStep('/album-tops', create, receipt('create')),
    localStep('/album-tops/' + F.TOP + '/add', add, receipt('add')),
    localStep('/album-tops/' + F.TOP + '/save', save, receipt('save')),
  ]);
  assert.deepEqual(await env.providers.searchAlbums({...localOptions(), q: '  Local  '}), search);
  assert.deepEqual(await env.providers.admitAlbum(11, localOptions()), {album_ref: F.A});
  assert.deepEqual(await env.providers.admitAlbum(11, {...localOptions(), topRef: F.TOP}), {album_ref: F.A});
  assert.deepEqual(await env.providers.preview(F.TOP, previewPayload, localOptions()), previewData);
  assert.deepEqual(await env.providers.execute('create', create, localOptions()), receipt('create'));
  assert.deepEqual(await env.providers.execute('add', {top_ref: F.TOP, ...add}, localOptions()), receipt('add'));
  assert.deepEqual(await env.providers.execute('save', {top_ref: F.TOP, ...save}, localOptions()), receipt('save'));
  assert.equal(env.calls.every(call => call.channel === 'local'), true);
});

test('ordinary membership keeps its existing 512 KiB body limit', async t => {
  const env = fixture(t);
  await assert.rejects(env.providers.execute('save', {top_ref: F.TOP, request_key: OPERATION, revision: '7',
    description: 'x'.repeat(512 * 1024)}, localOptions()), error => error.status === 413 && error.code === 'command_too_large');
  assert.equal(env.calls.length, 0);
});


test('SQL parent times cannot normalize an impossible calendar day into another lifetime', async t => {
  const malformed = parent({state: 'accepting', created_at: '2026-02-30T05:00:00+00:00',
    accepts_until: '2026-02-30T05:30:00+00:00', fully_expires_at: '2026-02-30T06:00:00+00:00'});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({parents: [malformed]}))]);
  await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
});

test('nested parent capacity uses the same strict DTO validator as aggregate capacity', async t => {
  const data = statusReply({parents: [parent({state: 'accepting', capacity: capacity({actor_pending_bytes: '256'})})]});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, data)]);
  await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
});

test('search accepts ten unique candidates and status accepts thirty-two unique parents', async t => {
  const searched = searchReply({candidates: Array.from({length: 10}, (_, n) => summary({release_group_id: F.id(600 + n)}))});
  const status = statusReply({parents: Array.from({length: 32}, (_, n) => parent({state: 'accepting', preparation_ref: F.id(700 + n)}))});
  const env = fixture(t, [remoteStep(SEARCH, searchPayload(), searched), remoteStep(PREPARATIONS, undefined, status)]);
  assert.deepEqual(await env.providers.searchRemoteAlbums(searchPayload(), env.options()), searched);
  assert.deepEqual(await env.providers.readRemotePreparationState(env.options()), status);
});

const remoteOperations = [
  {name: 'search', path: SEARCH, body: searchPayload(), invoke: (providers, options) => providers.searchRemoteAlbums(searchPayload(), options)},
  {name: 'begin', path: PREPARATIONS, body: beginPayload(), invoke: (providers, options) => providers.beginRemotePreparation(beginPayload(), options)},
  {name: 'acquire', path: ACQUIRE, body: acquirePayload(), invoke: (providers, options) => providers.acquireRemoteAlbum(acquirePayload(), options)},
  {name: 'status', path: PREPARATIONS, body: undefined, invoke: (providers, options) => providers.readRemotePreparationState(options)},
  {name: 'maintenance', path: MAINTAIN, body: {mode: 'reclaim'}, invoke: (providers, options) => providers.maintainRemotePreparations({mode: 'reclaim'}, options)},
  {name: 'close', path: CLOSE, body: {}, invoke: (providers, options) => providers.closeRemotePreparation(PREPARATION, options)},
];
for (const operation of remoteOperations) {
  for (const [status, code] of [[409, 'remote_preparation_unavailable'], [409, 'remote_evidence_unavailable'],
    [503, 'remote_acquisition_unavailable']]) {
    test(operation.name + ' preserves exact current structured rejection ' + status + '/' + code, async t => {
      const failure = Object.assign(new Error('Exact endpoint rejection'), {status, code, responseRejected: true});
      const env = fixture(t, [remoteStep(operation.path, operation.body, null, {respond() {throw failure;}})]);
      await assert.rejects(operation.invoke(env.providers, env.options()), error => error === failure);
      assert.equal(env.calls.length, 1, 'Failure does not create a successful preparation or implicit retry');
    });
  }
}

for (const status of [401, 403]) test('disposed old provider suppresses consumed denial before a replacement owner can observe it: ' + status, async t => {
  const gate = F.deferred(), denial = Object.assign(new Error('Consumed old denial'), {status, responseRejected: true});
  const old = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {respond: () => gate.promise})]);
  const waiting = old.providers.searchRemoteAlbums(searchPayload(), old.options());
  const rejected = assert.rejects(waiting, isAbort);
  old.providers.dispose();
  const replacement = fixture(t, [remoteStep(SEARCH, searchPayload(), searchReply())]);
  gate.reject(denial);
  await rejected;
  assert.deepEqual(await replacement.providers.searchRemoteAlbums(searchPayload(), replacement.options()), searchReply());
});

for (const status of [401, 403]) test('consumed live-generation denial is preserved despite caller request retirement: ' + status, async t => {
  const gate = F.deferred(), denial = Object.assign(new Error('Current actor denial'), {status, responseRejected: true});
  const env = fixture(t, [remoteStep(SEARCH, searchPayload(), null, {respond: () => gate.promise})]);
  const abort = new AbortController(); let current = true;
  const waiting = env.providers.searchRemoteAlbums(searchPayload(), env.options({signal: abort.signal, isCurrent: () => current}));
  const rejected = assert.rejects(waiting, error => error === denial);
  current = false; abort.abort(); env.generation(5);
  gate.reject(denial);
  await rejected;
});


for (const timestamp of ['0000-01-01T05:06:00Z', '2026-10-17T24:00:00Z', '2026-10-17T05:60:00Z',
  '2026-10-17T05:06:60Z', '2026-10-17T05:06:00+24:00', '2026-10-17T05:06:00+00:60',
  '2026-10-17T05:06:00.1234567Z', '2026-10-17T05:06:00Z\n']) {
  test('SQL timestamps reject invalid calendar, clock, zone and precision: ' + JSON.stringify(timestamp), async t => {
    const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({sql_now: timestamp}))]);
    await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
  });
}

test('parent lifetime rejects sub-millisecond expiry drift hidden by Date.parse precision', async t => {
  const malformed = parent({state: 'accepting', created_at: '2026-10-17T05:00:00.123456Z',
    accepts_until: '2026-10-17T05:30:00.123457Z', fully_expires_at: '2026-10-17T06:00:00.123456Z'});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, statusReply({parents: [malformed]}))]);
  await assert.rejects(env.providers.readRemotePreparationState(env.options()), isRemoteFailure);
});

test('matching SQL microseconds and equivalent timezone representations preserve an exact parent lifetime', async t => {
  const exact = parent({state: 'accepting', created_at: '2026-10-17T05:00:00.123456Z',
    accepts_until: '2026-10-17T06:30:00.123456+01:00', fully_expires_at: '2026-10-17T06:00:00.123456+00:00'});
  const data = statusReply({parents: [exact]});
  const env = fixture(t, [remoteStep(PREPARATIONS, undefined, data)]);
  assert.deepEqual(await env.providers.readRemotePreparationState(env.options()), data);
});


for (const consumed_revision of ['6', '7', '9']) {
  test('consumed existing-Top observation requires the original destination revision plus one: ' + consumed_revision, async t => {
    const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(topDestination()),
      consumedReply({destination: topDestination(), consumed_revision}))]);
    await assert.rejects(env.providers.acquireRemoteAlbum(acquirePayload(topDestination()), env.options()), isRemoteFailure);
  });
}

test('consumed Create observation has no invented previous Top revision', async t => {
  const data = consumedReply({consumed_revision: '99'});
  const env = fixture(t, [remoteStep(ACQUIRE, acquirePayload(), data)]);
  assert.deepEqual(await env.providers.acquireRemoteAlbum(acquirePayload(), env.options()), data);
});

for (const duplicate of ['item', 'catalog', 'release-group']) {
  test('read-only remote detail rejects duplicate ' + duplicate + ' identities without relying on edit or overlay validation', async t => {
    const data = mixedDetail({allowed_actions: {[F.BROWSE]: true, can_edit: false}});
    delete data.edit_draft;
    if (duplicate === 'item') data.items[1].ref = data.items[0].ref;
    if (duplicate === 'catalog') data.items[1].catalog_ref = data.items[0].catalog_ref;
    if (duplicate === 'release-group') data.items.push({...data.items[1], ref: F.id(990), catalog_ref: F.C, curator_position: 3});
    const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data)]);
    await assert.rejects(env.providers.read(F.TOP, localOptions()), isRemoteFailure);
  });
}

for (const malformed of ['item', 'catalog', 'revision']) {
  test('read-only mixed detail requires canonical ' + malformed + ' identity without an edit projection', async t => {
    const data = mixedDetail({allowed_actions: {[F.BROWSE]: true, can_edit: false}});
    delete data.edit_draft;
    if (malformed === 'item') data.items[1].ref += '\n';
    if (malformed === 'catalog') data.items[1].catalog_ref += '\n';
    if (malformed === 'revision') data.revision += '\n';
    const env = fixture(t, [localStep('/album-tops/' + F.TOP, undefined, data)]);
    const expectedMessage = malformed === 'revision' ? 'Invalid Album Top response.' : 'Invalid Album Top album.';
    await assert.rejects(env.providers.read(F.TOP, localOptions()),
      error => error.status === 409 && error.message === expectedMessage);
    assert.equal(env.calls.length, 1, 'The unchanged outer validator rejects the single actual read');
  });
}

// R2: strict opt-in receipt validation protects the existing membership owner.
const mixedCommand = action => action === 'create' ? typedCreate() : action === 'add'
  ? {top_ref: F.TOP, request_key: OPERATION, revision: '7', selections: [pendingSelector()]}
  : {top_ref: F.TOP, request_key: OPERATION, revision: '7', item_selections: mixedSources()};
for (const action of ['create', 'add', 'save']) {
  for (const patch of [{top_ref: F.TOP + '\n'}, {top_ref: ZERO}, {revision: '8\n'}, {revision: '0'},
    {revision: '08'}, {revision: '9223372036854775808'}, ...(action === 'create' ? [{revision: '2'}, {revision: '8'}, {revision: '9223372036854775807'}] : [{revision: '6'}, {revision: '7'}, {revision: '9'}])]) {
    test('typed ' + action + ' never acknowledges malformed or impossible result ' + JSON.stringify(patch), async t => {
      const command = mixedCommand(action), {top_ref, ...body} = command;
      const route = action === 'create' ? '/album-tops' : '/album-tops/' + F.TOP + '/' + action;
      const data = receipt(action, {...(action === 'create' ? {revision: '1', draft_ref: DRAFT} : {}), ...patch});
      const env = fixture(t, [localStep(route, body, data)]);
      await assert.rejects(env.providers.execute(action, command, localOptions()), isRemoteFailure);
    });
  }
  for (const patch of [{request_key: OPERATION + '\n'}, {request_key: ZERO},
    ...(action === 'create' ? [] : [{top_ref: F.TOP + '\n'}, {top_ref: ZERO}])]) {
    test('typed ' + action + ' rejects noncanonical command identity before dispatch ' + JSON.stringify(patch), async t => {
      const env = fixture(t);
      await assert.rejects(env.providers.execute(action, {...mixedCommand(action), ...patch}, localOptions()));
      assert.equal(env.calls.length, 0);
    });
  }
}

test('real controller retains exact uncertain typed Create through malformed and impossible-positive acknowledgments on exact retry', async t => {
  const {createAlbumTopController} = await F.load('album-tops/model.mjs');
  const command = typedCreate(), {request_key, ...payload} = command;
  const directory = {tops: [], next_cursor: null, allowed_actions: {[F.BROWSE]: true, [F.CREATE]: true, can_create: true}};
  const env = fixture(t, [localStep('/album-tops?limit=100', undefined, directory),
    localStep('/album-tops', command, receipt('create', {top_ref: F.TOP + '\n', revision: '1', draft_ref: DRAFT})),
    localStep('/album-tops', command, receipt('create', {revision: '8', draft_ref: DRAFT}))]);
  const controller = createAlbumTopController({providers: env.providers, requestKey: () => OPERATION});
  t.after(() => controller.dispose()); controller.setScope(F.SCOPE); await controller.load();
  assert.equal(await controller.mutate('create', payload), false);
  const first = F.clone(controller.getSnapshot().mutation.command);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  assert.deepEqual(first, command); assert.equal(controller.canRetryMutation(), true);
  assert.equal(controller.getSnapshot().selectedTopRef, null);
  assert.equal(await controller.mutate('create', {title: 'Replacement', description: '', album_refs: []}), false);
  assert.equal(env.calls.length, 2, 'No replacement mutation or refresh/read can escape a malformed receipt');
  assert.equal(await controller.retryMutation(), false);
  assert.deepEqual(controller.getSnapshot().mutation.command, first);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain'); assert.equal(controller.canRetryMutation(), true);
  assert.deepEqual(env.calls.slice(1).map(call => call.request.body), [command, command]);
});

// Use the actual shared transport, not a remote-request success double, for the
// final scope/caller ordering. The facade only witnesses transport completion.
for (const change of ['dispose', 'generation', 'navigation', 'source', 'context-read-dispose']) {
  test('actual transport plus provider rejects final scope/caller reentry: ' + change, async t => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(F.source('runtime/private-ui-transport.js'), 'utf8');
    const shell = {dataset: {privateUiContext: CONTEXT}}, window = {}, calls = [], events = [];
    vm.runInNewContext(source, {window, document: {getElementById: () => shell}, URLSearchParams,
      fetch: async (path, request) => {calls.push({path, request}); return {status: 200, ok: true,
        json: async () => ({status: 'ready', context_ref: CONTEXT, data: searchReply()})};}});
    const actual = window.AlbumHavenPrivateUITransport;
    let completed = false, changed = false, form = true, armContextRead = false, providers;
    const transport = {
      context() {const value = actual.context(); if (armContextRead) {armContextRead = false; events.push('context-dispose'); providers.dispose();} return value;},
      generation: () => actual.generation(),
      async requestAlbumTopRemote(...args) {const result = await actual.requestAlbumTopRemote(...args); completed = true; return result;},
    };
    providers = createAlbumTopBackendProviders({transport, acceptsScope(scope) {
      assert.equal(scope, F.SCOPE);
      if (completed && !changed) {
        changed = true; events.push('scope');
        if (change === 'dispose') providers.dispose();
        if (change === 'generation') {shell.dataset.privateUiContext = OTHER_CONTEXT; actual.generation();}
        if (change === 'navigation' || change === 'source') form = false;
      }
      return true;
    }});
    t.after(() => {providers.dispose(); actual.dispose();});
    const options = {...localOptions(), remoteContext: providers.remoteContext(), isCurrent() {
      if (completed) {events.push('caller'); if (change === 'context-read-dispose') armContextRead = true;}
      return form;
    }};
    await assert.rejects(providers.searchRemoteAlbums(searchPayload(), options), isAbort);
    assert.equal(completed, true); assert.equal(changed, true); assert.equal(calls.length, 1);
    assert.equal(calls[0].path, SEARCH); assert.deepEqual(JSON.parse(calls[0].request.body), searchPayload());
    if (change === 'navigation' || change === 'source') assert.deepEqual(events, ['scope', 'caller']);
    if (change === 'context-read-dispose') assert.deepEqual(events, ['scope', 'caller', 'context-dispose']);
  });
}
