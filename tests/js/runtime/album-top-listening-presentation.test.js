'use strict';
// SOURCE ONLY. Not released for discovery, import, collection or execution.
// Materialize at tests/js/runtime/ only after exact source/dependency approval.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const F = require('./album-top-listening-presentation-fixtures.cjs');
const load = () => import(pathToFileURL(path.resolve(__dirname,
  '../../../music_app/static/js/album-tops/listening-presentation.mjs')).href);
const flags = result => result.statuses.map(row => row.value);
const counts = result => result.candidates.metrics.map(row => row.value);
const sources = result => result.sources.map(row => [row.source_kind, row.label, row.seconds]);
const FAMILY_NAMES = ['manualProgress', 'lifetimeMetrics', 'candidates'];
const METRIC_KEYS = ['full', 'partial', 'uninterrupted_full', 'target_coverage', 'tracks_at_target', 'album_time_equivalents'];
function assertUnknown(result) {
  assert.deepEqual(flags(result), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(result.completion, {manual: 'unknown', automatic: 'unknown'});
  assert.deepEqual(result.sources, []);
  assert.equal(result.candidates.status, 'unavailable');
  assert.deepEqual(counts(result), [null, null, null, null, null, null]);
}
function assertOnlyFamilyRejected(result, family) {
  assert.deepEqual(flags(result), [family === 'lifetimeMetrics' ? 'unknown' : true,
    'unknown', family === 'manualProgress' ? 'unknown' : true, 'unknown']);
  assert.equal(result.completion.manual, family === 'manualProgress' ? 'unknown' : true);
  assert.equal(result.completion.automatic, 'unknown');
  assert.equal(result.sources.length, family === 'lifetimeMetrics' ? 0 : 1);
  assert.equal(result.candidates.status, family === 'candidates' ? 'unavailable' : 'proposed');
  assert.deepEqual(counts(result), family === 'candidates' ? [null, null, null, null, null, null]
    : [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
}
function rebind(f) {
  for (const family of FAMILY_NAMES) f.observations[family].binding = F.binding(f.current);
}

// LP-01: all asserted values are literal, not computed by another product helper.
test('LP-01 exact concise statuses and proposed arithmetic stay distinct', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(), result = present(f.current, f.observations);
  assert.deepEqual(Object.keys(result), ['target', 'statuses', 'completion', 'sources', 'candidates']);
  assert.deepEqual(result.target, {value: 5, status: 'default'});
  assert.deepEqual(result.statuses.map(({key, label, value}) => ({key, label, value})), [
    {key: 'has_plays', label: 'Has plays', value: true},
    {key: 'listened', label: 'Listened', value: 'unknown'},
    {key: 'completed', label: 'Completed', value: true},
    {key: 'rated', label: 'Rated', value: 'unknown'},
  ]);
  assert.deepEqual(result.completion, {manual: true, automatic: 'unknown'});
  assert.deepEqual(sources(result), [['native-v2', 'Native', {
    value: {numerator: 5, denominator: 2}, status: 'exact_recorded', reasons: []}]]);
  assert.equal(result.candidates.status, 'proposed');
  assert.equal(result.candidates.label, 'Proposed candidates');
  assert.equal(result.candidates.target_current, true);
  assert.deepEqual(result.candidates.reasons, ['candidate_only', 'qualification_pending']);
  assert.deepEqual(result.candidates.metrics, [
    {key: 'full', label: 'Proposed full', value: 2, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
    {key: 'partial', label: 'Proposed partial', value: 1, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
    {key: 'uninterrupted_full', label: 'Proposed uninterrupted', value: 1, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
    {key: 'target_coverage', label: 'Proposed target coverage', value: {numerator: 1, denominator: 2}, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
    {key: 'tracks_at_target', label: 'Proposed tracks at target', value: 0, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
    {key: 'album_time_equivalents', label: 'Proposed time equivalents', value: {numerator: 5, denominator: 2}, status: 'exact_recorded', reasons: ['candidate_only', 'qualification_pending']},
  ]);
  for (const row of result.statuses) {
    assert.equal(typeof row.help, 'string');
    assert.notEqual(row.help, row.label);
    assert.doesNotMatch(row.label, /[<>]/);
  }
  assert.match(result.candidates.help, /must not be added to Full/);
  assert.match(result.sources[0].help, /not proof of complete lifetime history/);
});

test('LP-02 target default is absent-only and positive safe integers are not coerced', async () => {
  const {normalizeListeningTarget: normalize} = await load();
  assert.deepEqual(normalize(), {value: 5, status: 'default'});
  assert.deepEqual(normalize(undefined), {value: 5, status: 'default'});
  for (const value of [1, 5, 6, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(normalize(value), {value, status: 'provided'});
    assert.ok(Object.isFrozen(normalize(value)));
  }
  for (const value of [null, false, true, 0, -0, -1, 1.25, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '5', '05', '5.0', '5e0', ' 5 ', '', 5n, [], {}, new Number(5)]) {
    assert.deepEqual(normalize(value), {value: null, status: 'invalid'});
  }
  assert.notEqual(normalize(), normalize());
});

test('LP-03 missing or invalid current data never fabricates a known predicate', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const current of [undefined, null, false, true, 17, '', [], {}, {scopeKey: '[]'}]) {
    assertUnknown(present(current, F.fixture().observations));
  }
  const f = F.fixture();
  for (const observations of [undefined, null, false, 42, '', [], {}]) {
    assertUnknown(present(f.current, observations));
  }
});

test('LP-04 native scope requires exact tuple types and safe generation', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const bad = [null, '', 'not-json', '{}', 'null', '[]', JSON.stringify(['17', '29', F.CONTEXT]),
    JSON.stringify(['17', '29', F.CONTEXT, 4, 'extra']), JSON.stringify([17, '29', F.CONTEXT, 4]),
    JSON.stringify(['17', 29, F.CONTEXT, 4]), JSON.stringify(['0', '29', F.CONTEXT, 4]),
    JSON.stringify(['017', '29', F.CONTEXT, 4]), JSON.stringify(['17', '29', 'c'.repeat(63), 4]),
    JSON.stringify(['17', '29', F.CONTEXT.toUpperCase(), 4]), JSON.stringify(['17', '29', F.CONTEXT, '4']),
    JSON.stringify(['17', '29', F.CONTEXT, -1]), JSON.stringify(['17', '29', F.CONTEXT, 0.5]),
    JSON.stringify(['17', '29', F.CONTEXT, Number.MAX_SAFE_INTEGER + 1]),
    JSON.stringify(['9223372036854775808', '29', F.CONTEXT, 4])];
  for (const scopeKey of bad) {
    const f = F.fixture(); f.current.scopeKey = scopeKey; rebind(f);
    assertUnknown(present(f.current, f.observations));
  }
  for (const generation of [0, Number.MAX_SAFE_INTEGER]) {
    const f = F.fixture(); f.current.scopeKey = JSON.stringify(['17', '29', F.CONTEXT, generation]); rebind(f);
    assert.deepEqual(flags(present(f.current, f.observations)), [true, 'unknown', true, 'unknown']);
  }
});

test('LP-05 Top and binding fields must be own and present', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const key of ['scopeKey', 'top_ref', 'revision', 'item_ref', 'album_ref']) {
    for (const inherited of [false, true]) {
      const f = F.fixture(), original = f.current[key]; delete f.current[key];
      if (inherited) Object.setPrototypeOf(f.current, {[key]: original});
      assertUnknown(present(f.current, f.observations));
    }
    for (const family of FAMILY_NAMES) {
      const f = F.fixture(); delete f.observations[family].binding[key];
      assertOnlyFamilyRejected(present(f.current, f.observations), family);
      const inherited = F.fixture(), old = inherited.observations[family].binding[key];
      delete inherited.observations[family].binding[key];
      Object.setPrototypeOf(inherited.observations[family].binding, {[key]: old});
      assertOnlyFamilyRejected(present(inherited.current, inherited.observations), family);
    }
  }
});

test('LP-06 stale and cross-owner Top associations reject only the affected family', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const alternatives = {scopeKey: [JSON.stringify(['18', '29', F.CONTEXT, 4]),
    JSON.stringify(['17', '30', F.CONTEXT, 4]), JSON.stringify(['17', '29', 'c'.repeat(64), 4]),
    JSON.stringify(['17', '29', F.CONTEXT, 5]), '[ "17", "29", "' + F.CONTEXT + '", 4 ]'],
    top_ref: [F.OTHER], revision: ['14'], item_ref: [F.OTHER], album_ref: [F.OTHER]};
  for (const family of FAMILY_NAMES) for (const [key, values] of Object.entries(alternatives)) {
    for (const value of values) {
      const f = F.fixture(); f.observations[family].binding[key] = value;
      assertOnlyFamilyRejected(present(f.current, f.observations), family);
    }
  }
});

test('LP-07 malformed native identities stay invalid even when all bindings echo them', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const key of ['top_ref', 'item_ref', 'album_ref']) for (const value of [null, 1, '',
    'not-a-uuid', F.TOP.toUpperCase().replace('10000000', 'AAAAAAAA'), F.TOP + 'x', [F.TOP]]) {
    const f = F.fixture(); f.current[key] = value; rebind(f);
    assertUnknown(present(f.current, f.observations));
  }
  for (const revision of ['0', '-1', '01', '1.0', '1e2', '', 13, 13n, '9223372036854775808']) {
    const f = F.fixture(); f.current.revision = revision; rebind(f);
    assertUnknown(present(f.current, f.observations));
  }
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const key of ['top_ref', 'item_ref', 'album_ref', 'revision']) {
      const f = F.fixture(); f.current[key] += suffix; rebind(f);
      assertUnknown(present(f.current, f.observations));
    }
    for (const index of [0, 1, 2]) {
      const f = F.fixture(), scope = ['17', '29', F.CONTEXT, 4]; scope[index] += suffix;
      f.current.scopeKey = JSON.stringify(scope); rebind(f);
      assertUnknown(present(f.current, f.observations));
    }
  }
  const upper = F.fixture(); upper.current.revision = '9223372036854775807'; rebind(upper);
  assert.deepEqual(flags(present(upper.current, upper.observations)), [true, 'unknown', true, 'unknown']);
});

test('LP-08 manual states use genuine revision and timestamp formats', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const timestamp of ['2026-10-20T12:34:56Z', '2026-10-20T12:34:56+00:00',
    '2026-10-20T12:34:56.1Z', '2026-10-20T12:34:56.123456+00:00', '2024-02-29T00:00:00Z']) {
    const f = F.fixture(); f.observations.manualProgress.value.manual_completed_at = timestamp;
    const result = present(f.current, {manualProgress: f.observations.manualProgress});
    assert.deepEqual(flags(result), ['unknown', 'unknown', true, 'unknown']);
    assert.deepEqual(result.completion, {manual: true, automatic: 'unknown'});
  }
  for (const revision of ['0', '1', '9223372036854775807']) {
    const f = F.fixture(); f.current.progress_revision = revision;
    f.observations.manualProgress.value = {progress_revision: revision, manual_completed_at: null};
    const result = present(f.current, f.observations);
    assert.deepEqual(result.completion, {manual: false, automatic: 'unknown'});
    assert.deepEqual(flags(result), [true, 'unknown', 'unknown', 'unknown']);
  }
});

test('LP-09 malformed manual rows and timestamps are unknown rather than false', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const invalidRows = [undefined, null, [], {}, {progress_revision: '7'}, {manual_completed_at: F.TIME}];
  for (const value of invalidRows) {
    const f = F.fixture(); f.observations.manualProgress.value = value;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
  }
  for (const revision of [null, 7, 7n, '', '-1', '07', '1.5', '9223372036854775808', '1\n', '1\r', '1\u2028']) {
    const f = F.fixture(); f.current.progress_revision = revision;
    f.observations.manualProgress.value.progress_revision = revision;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
  }
  for (const timestamp of [undefined, false, 0, '', '2026-02-30T00:00:00Z', '2026-10-20',
    '2026-10-20T12:34:56', '2026-10-20T12:34:56+01:00', '2026-10-20T12:34:56.1234567Z',
    '2026-10-20T24:00:00Z', F.TIME + '\n']) {
    const f = F.fixture(); f.observations.manualProgress.value.manual_completed_at = timestamp;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
  }
  const f = F.fixture(); f.current.progress_revision = '0';
  f.observations.manualProgress.value.progress_revision = '0';
  assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
});

test('LP-10 independent current progress revision prevents stale manual completion', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const currentRevision of [undefined, '8', 7]) {
    const f = F.fixture();
    if (currentRevision === undefined) delete f.current.progress_revision;
    else f.current.progress_revision = currentRevision;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
  }
  const f = F.fixture(), inherited = f.current.progress_revision;
  delete f.current.progress_revision; Object.setPrototypeOf(f.current, {progress_revision: inherited});
  assertOnlyFamilyRejected(present(f.current, f.observations), 'manualProgress');
  const fresh = F.fixture(); fresh.current.progress_revision = '8';
  fresh.observations.manualProgress.value = {progress_revision: '8', manual_completed_at: null};
  const result = present(fresh.current, fresh.observations);
  assert.equal(fresh.current.revision, '13');
  assert.deepEqual(result.completion, {manual: false, automatic: 'unknown'});
  assert.equal(result.statuses[2].value, 'unknown');
});

test('LP-11 unsupported qualification and rating inputs cannot override fixed unknowns', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const manual of [true, false, 'unknown']) {
    const f = F.fixture();
    if (manual === false) f.observations.manualProgress.value.manual_completed_at = null;
    if (manual === 'unknown') delete f.observations.manualProgress;
    // Deliberately hostile unsupported fields, not invented positive owner joins.
    f.observations.membershipCompletion = {value: {automatic_eligibility: true, status: 'ready'}};
    f.observations.rating = {value: {rating_state: 'available', rating: 10}};
    f.observations.statuses = {listened: true, completed: true, rated: true};
    f.current.automatic_eligibility = true; f.current.rated = true; f.current.listened = true;
    const result = present(f.current, f.observations);
    assert.deepEqual(result.completion, {manual, automatic: 'unknown'});
    assert.deepEqual(flags(result), [true, 'unknown', manual === true ? true : 'unknown', 'unknown']);
  }
});

test('LP-12 observation families are independent across missing and malformed records', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const family of FAMILY_NAMES) for (const bad of [undefined, null, false, [], {}, {binding: {}, value: {}}]) {
    const f = F.fixture(); f.observations[family] = bad;
    assertOnlyFamilyRejected(present(f.current, f.observations), family);
  }
  const f = F.fixture(); delete f.current.metrics;
  const result = present(f.current, f.observations);
  assert.deepEqual(flags(result), ['unknown', 'unknown', true, 'unknown']);
  assert.equal(result.completion.manual, true); assert.deepEqual(result.sources, []);
  assert.equal(result.candidates.status, 'unavailable');
});

function assertMetricsRejected(result) {
  assert.deepEqual(flags(result), ['unknown', 'unknown', true, 'unknown']);
  assert.deepEqual(result.completion, {manual: true, automatic: 'unknown'});
  assert.deepEqual(result.sources, []);
  assert.equal(result.candidates.status, 'unavailable');
  assert.deepEqual(counts(result), [null, null, null, null, null, null]);
}
function resetMetricObservations(f) {
  f.observations.lifetimeMetrics = {binding: F.binding(f.current), value: F.stage(f.current)};
  f.observations.candidates = {binding: F.binding(f.current), value: F.candidate(f.current)};
}

test('LP-13 current metrics require safe owner IDs independently matching native scope', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const key of ['actor_id', 'library_id']) for (const value of [0, -1, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, '17', 17n, true, null]) {
    const f = F.fixture(); f.current.metrics[key] = value; f.current.metrics.mapping[key] = value;
    resetMetricObservations(f); assertMetricsRejected(present(f.current, f.observations));
  }
  for (const [key, value] of [['actor_id', 18], ['library_id', 30]]) {
    const f = F.fixture(); f.current.metrics[key] = value; f.current.metrics.mapping[key] = value;
    resetMetricObservations(f); assertMetricsRejected(present(f.current, f.observations));
  }
  const f = F.fixture();
  f.current.scopeKey = JSON.stringify(['9007199254740991', '29', F.CONTEXT, 4]);
  f.current.metrics.actor_id = Number.MAX_SAFE_INTEGER;
  f.current.metrics.mapping.actor_id = Number.MAX_SAFE_INTEGER;
  resetMetricObservations(f); rebind(f);
  assert.deepEqual(flags(present(f.current, f.observations)), [true, 'unknown', true, 'unknown']);
});

test('LP-14 exact metrics identity and own captured fields reject stale evidence independently', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const alternatives = {actor_id: 18, library_id: 30, local_album_key: 'other-album',
    evidence_revision: 'evidence-12', snapshot_id: 'snapshot-8', snapshot_fingerprint: 'c'.repeat(64)};
  for (const family of ['lifetimeMetrics', 'candidates']) for (const [key, value] of Object.entries(alternatives)) {
    const f = F.fixture(); f.observations[family].binding.metrics[key] = value;
    assertOnlyFamilyRejected(present(f.current, f.observations), family);
    const missing = F.fixture(); delete missing.observations[family].binding.metrics[key];
    assertOnlyFamilyRejected(present(missing.current, missing.observations), family);
    const inherited = F.fixture(), old = inherited.observations[family].binding.metrics[key];
    delete inherited.observations[family].binding.metrics[key];
    Object.setPrototypeOf(inherited.observations[family].binding.metrics, {[key]: old});
    assertOnlyFamilyRejected(present(inherited.current, inherited.observations), family);
  }
  for (const family of ['lifetimeMetrics', 'candidates']) for (const bad of [undefined, null, [], {}]) {
    const f = F.fixture(); f.observations[family].binding.metrics = bad;
    assertOnlyFamilyRejected(present(f.current, f.observations), family);
  }
});

test('LP-15 current and captured catalog mappings must match every genuine mapping field', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const alternatives = {actor_id: 18, library_id: 30, local_album_key: 'other-album',
    catalog_album_ref: F.OTHER, mapping_id: 'mapping-4', revision: 'mapping-revision-6', authority_ref: 'other-authority'};
  for (const family of ['lifetimeMetrics', 'candidates']) for (const [key, value] of Object.entries(alternatives)) {
    const f = F.fixture(); f.observations[family].binding.metrics.mapping[key] = value;
    assertOnlyFamilyRejected(present(f.current, f.observations), family);
    const missing = F.fixture(); delete missing.observations[family].binding.metrics.mapping[key];
    assertOnlyFamilyRejected(present(missing.current, missing.observations), family);
  }
  for (const key of ['actor_id', 'library_id', 'local_album_key', 'catalog_album_ref']) {
    const f = F.fixture(); f.current.metrics.mapping[key] = alternatives[key]; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
  for (const mapping of [undefined, null, [], {}, {inventory_album_ref: 'inventory-album:101'}]) {
    const f = F.fixture(); f.current.metrics.mapping = mapping; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
});

test('LP-16 identifier boundaries use producer UTF-8 bytes, not coercion or character count alone', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const fields = ['local_album_key', 'evidence_revision', 'snapshot_id'];
  const invalid = ['', null, 1, [], {}, 'x'.repeat(129), 'é'.repeat(65), '\ud800', '\udfff',
    'bad\u0000id', 'bad\u001fid', 'bad\u007fid', 'bad\u009fid', 'bad\nid', 'bad\rid'];
  for (const key of fields) for (const value of invalid) {
    const f = F.fixture(); f.current.metrics[key] = value;
    if (key === 'local_album_key') f.current.metrics.mapping.local_album_key = value;
    resetMetricObservations(f); assertMetricsRejected(present(f.current, f.observations));
  }
  for (const key of ['mapping_id', 'revision', 'authority_ref']) for (const value of invalid) {
    const f = F.fixture(); f.current.metrics.mapping[key] = value; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
  // The Python identifier producer permits U+2028/U+2029 and valid astral pairs.
  for (const value of ['x'.repeat(128), 'é'.repeat(64), '😀'.repeat(32), 'owner\u2028id', 'owner\u2029id']) {
    const f = F.fixture(); f.current.metrics.local_album_key = value; f.current.metrics.mapping.local_album_key = value;
    resetMetricObservations(f);
    assert.deepEqual(flags(present(f.current, f.observations)), [true, 'unknown', true, 'unknown']);
  }
  for (const value of [null, 123, 'b'.repeat(63), 'b'.repeat(65), 'B'.repeat(64),
    F.FINGERPRINT + '\n', F.FINGERPRINT + '\r', F.FINGERPRINT + '\u2028', F.FINGERPRINT + '\u2029']) {
    const f = F.fixture(); f.current.metrics.snapshot_fingerprint = value; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
});

test('LP-17 cutoff basis and rational identity are exact without rounding or time conversion', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const family of ['lifetimeMetrics', 'candidates']) {
    for (const replacement of [undefined, null, {}, {basis: 'other-time', value: {numerator: 123, denominator: 2}},
      {basis: 'utc-ns', value: {numerator: 124, denominator: 2}},
      {basis: 'utc-ns', value: {numerator: 246, denominator: 4}}]) {
      const f = F.fixture(); f.observations[family].binding.metrics.source_cutoff = replacement;
      assertOnlyFamilyRejected(present(f.current, f.observations), family);
    }
  }
  const changed = F.fixture(); changed.observations.lifetimeMetrics.value.source_cutoff.value.numerator = 125;
  assertOnlyFamilyRejected(present(changed.current, changed.observations), 'lifetimeMetrics');
  for (const value of [undefined, null, {}, {numerator: '123', denominator: 2}, {numerator: 123, denominator: '2'},
    {numerator: 123n, denominator: 2}, {numerator: NaN, denominator: 2}, {numerator: Infinity, denominator: 2},
    {numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 2}, {numerator: 1, denominator: 0},
    {numerator: 1, denominator: -1}, {numerator: 1, denominator: 0.5},
    {numerator: 1, denominator: Number.MAX_SAFE_INTEGER + 1}]) {
    const f = F.fixture(); f.current.metrics.source_cutoff.value = value; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
  for (const value of [{numerator: -123, denominator: 2}, {numerator: -Number.MAX_SAFE_INTEGER, denominator: 1},
    {numerator: 0, denominator: 1}, {numerator: 1, denominator: Number.MAX_SAFE_INTEGER}]) {
    const f = F.fixture(); f.current.metrics.source_cutoff.value = value; resetMetricObservations(f);
    assert.deepEqual(flags(present(f.current, f.observations)), [true, 'unknown', true, 'unknown']);
  }
  for (const basis of ['', 1, 'bad\nbasis', 'x'.repeat(129)]) {
    const f = F.fixture(); f.current.metrics.source_cutoff.basis = basis; resetMetricObservations(f);
    assertMetricsRejected(present(f.current, f.observations));
  }
});

test('LP-18 actual producer identity must match even when captured bindings are current', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const family of ['lifetimeMetrics', 'candidates']) {
    for (const [key, value] of Object.entries({actor_id: 18, library_id: 30,
      local_album_key: 'other-album', evidence_revision: 'evidence-12'})) {
      const f = F.fixture(); f.observations[family].value[key] = value;
      assertOnlyFamilyRejected(present(f.current, f.observations), family);
      const missing = F.fixture(); delete missing.observations[family].value[key];
      assertOnlyFamilyRejected(present(missing.current, missing.observations), family);
    }
    for (const scope of [undefined, null, [], {}, {kind: 'membership', baseline_id: 'baseline-1'},
      {kind: 'lifetime', baseline_id: 'baseline-1'}, {kind: 'lifetime'}, {baseline_id: null},
      {kind: 'lifetime', baseline_id: null, extra: true}]) {
      const f = F.fixture(); f.observations[family].value.scope = scope;
      assertOnlyFamilyRejected(present(f.current, f.observations), family);
    }
  }
  for (const [family, key] of [['lifetimeMetrics', 'snapshot_id'], ['lifetimeMetrics', 'fingerprint'],
    ['candidates', 'snapshot_id'], ['candidates', 'snapshot_fingerprint']]) {
    const f = F.fixture(), owner = family === 'lifetimeMetrics'
      ? f.observations[family].value.snapshot : f.observations[family].value;
    owner[key] = 'stale'; assertOnlyFamilyRejected(present(f.current, f.observations), family);
  }
});

test('LP-19 observed-window and membership candidates never become lifetime data', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(), value = f.observations.candidates.value;
  Object.assign(value, {scope: {kind: 'observed_window', owner: {id: 'owner'}, window: {id: 'window'}},
    version: 'album-position-observation-v1', observation_status: 'complete_as_observed',
    coordinate_basis: 'browser_reported_track_coordinates', measurement_protocol: 'app-rendered-position-v2',
    measurement_provenance: 'browser-reported-rendered-positions', history_status: 'partial',
    non_additive_across_observations: true, uninterrupted_full_basis: 'observed_window_monotone_continuous_output_passes'});
  assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
  value.scope = {kind: 'observed_window', baseline_id: null};
  assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
  value.scope = {kind: 'membership', baseline_id: null};
  assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
});

test('LP-20 every admitted Stage-A snapshot, history and policy form stays unqualified', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const snapshot of ['observed', 'unknown', 'unavailable', 'overflow']) {
    for (const history of ['complete_recorded_scope', 'partial', 'unknown']) {
      for (const policy of ['absent', 'proposed', 'approved']) {
        const f = F.fixture(), value = f.observations.lifetimeMetrics.value;
        value.snapshot.status = snapshot; value.history_status = history;
        value.policy_status = policy; value.policy_version = policy === 'absent' ? null : 'policy-version-1';
        value.reasons = ['allocation_not_evaluated', ...(snapshot === 'observed' ? [] : ['denominator_unavailable']),
          ...(history === 'partial' ? ['history_partial'] : history === 'unknown' ? ['history_unknown'] : []),
          ...(policy === 'proposed' ? ['qualification_pending'] : [])];
        const result = present(f.current, f.observations);
        assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
        assert.equal(result.sources[0].seconds.value.numerator, 5);
        assert.equal(result.completion.automatic, 'unknown');
      }
    }
  }
});

test('LP-21 Has plays false requires complete history and is never inferred from candidate counts', async () => {
  const {projectTopListeningPresentation: present} = await load();
  // This literal matrix intentionally includes contradictory owner outputs.
  // It tests defensive tri-state handling, not genuine producer reachability.
  const cases = [
    [true, 'complete_recorded_scope', true], [true, 'partial', true], [true, 'unknown', true],
    [false, 'complete_recorded_scope', false], [false, 'partial', 'unknown'], [false, 'unknown', 'unknown'],
    ['unknown', 'complete_recorded_scope', 'unknown'], ['unknown', 'partial', 'unknown'], ['unknown', 'unknown', 'unknown'],
  ];
  for (const [input, history, expected] of cases) {
    const f = F.fixture(), value = f.observations.lifetimeMetrics.value;
    value.predicates.has_plays = input; value.history_status = history;
    // Recorded zero is genuine numeric data, not evidence of complete history.
    value.metrics.source_time_totals[0].seconds = F.exact({numerator: 0, denominator: 1});
    const result = present(f.current, f.observations);
    assert.equal(result.statuses[0].value, expected);
    assert.deepEqual(result.sources[0].seconds, {value: {numerator: 0, denominator: 1}, status: 'exact_recorded', reasons: []});
    assert.deepEqual(counts(result), [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
  }
  const f = F.fixture(); delete f.observations.lifetimeMetrics;
  const result = present(f.current, f.observations);
  assert.equal(result.candidates.metrics[0].value, 2);
  assert.equal(result.statuses[0].value, 'unknown');
  assert.equal(result.statuses[1].value, 'unknown');
});

test('LP-22 malformed Stage-A family cannot retain a positive Has plays predicate', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const patches = [v => {v.status = 'ready';}, v => {v.status = 'invalid_metrics_input';},
    v => {v.snapshot = null;}, v => {v.snapshot.status = 'ready';},
    v => {v.history_status = 'complete';}, v => {v.policy_status = 'admitted';},
    v => {v.policy_version = 'not-null-with-absent';},
    v => {v.policy_status = 'approved'; v.policy_version = null;},
    v => {v.policy_status = 'proposed'; v.policy_version = '';},
    v => {v.witnesses = [{}];}, v => {v.witnesses = null;}, v => {v.reasons = [];},
    v => {v.reasons = 'allocation_not_evaluated';}, v => {v.predicates = null;},
    v => {v.predicates.listened = true;}, v => {v.predicates.has_plays = 'true';},
    v => {v.predicates.has_plays = 1;}, v => {v.predicates.has_plays = null;}];
  for (const patch of patches) {
    const f = F.fixture(); patch(f.observations.lifetimeMetrics.value);
    assertOnlyFamilyRejected(present(f.current, f.observations), 'lifetimeMetrics');
  }
  for (const value of [{status: 'incomplete', reasons: ['resource_limit']},
    {status: 'invalid_metrics_input', reasons: ['scope_mismatch']}]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value = value;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'lifetimeMetrics');
  }
});

test('LP-23 recorded and reported source buckets stay separate and never imply minutes or sessions', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals = F.allSources();
  const result = present(f.current, f.observations);
  assert.deepEqual(sources(result), [
    ['foobar-playcount', 'foobar2000', {value: null, status: 'unavailable', reasons: ['source_time_unknown']}],
    ['lastfm-scrobble', 'Last.fm', {value: null, status: 'unavailable', reasons: ['source_time_unknown']}],
    ['legacy-measured-v1', 'Legacy measured', {value: {numerator: 7, denominator: 3}, status: 'exact_recorded', reasons: []}],
    ['manual-reported', 'Reported', {value: null, status: 'unavailable', reasons: ['source_time_unknown']}],
    ['native-v2', 'Native', {value: {numerator: 5, denominator: 2}, status: 'exact_recorded', reasons: []}],
  ]);
  assert.deepEqual(counts(result), [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
  for (const source of result.sources) {
    assert.deepEqual(Object.keys(source), ['source_kind', 'label', 'seconds', 'help']);
    assert.equal(Object.hasOwn(source, 'minutes'), false);
    assert.equal(Object.hasOwn(source, 'full'), false);
    assert.equal(Object.hasOwn(source, 'reported_plays'), false);
  }
  const recorded = f.observations.lifetimeMetrics.value.metrics.source_time_totals;
  for (const row of recorded.filter(row => ['foobar-playcount', 'lastfm-scrobble', 'manual-reported'].includes(row.source_kind))) {
    row.seconds = F.exact({numerator: 999999, denominator: 1});
    row.buckets[0].reported_plays.value = Number.MAX_SAFE_INTEGER;
  }
  const hostile = present(f.current, f.observations);
  assert.deepEqual(sources(hostile), sources(result));
  assert.deepEqual(counts(hostile), [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
});

test('LP-24 reported positive counts can accompany Has plays but never create native time', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(), value = f.observations.lifetimeMetrics.value;
  value.history_status = 'partial'; value.reasons.push('history_partial');
  // No Native Runs: all native aggregate and per-track coverage fields agree.
  value.metrics.native_recorded_frames = F.exact(0);
  value.metrics.known_position_frames = F.exact(0);
  value.metrics.track_coverage = [{track_id: 101, source_intervals: [], known_position_frames: F.exact(0)}];
  value.metrics.source_time_totals = [
    {source_kind: 'lastfm-scrobble', seconds: F.missing('source_time_unknown'), buckets: [F.bucket('scrobble-1', 7)]},
    {source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: []},
  ];
  delete f.observations.candidates;
  const result = present(f.current, f.observations);
  assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
  assert.deepEqual(result.sources[1].seconds.value, {numerator: 0, denominator: 1});
  assert.deepEqual(result.sources[0].seconds, {value: null, status: 'unavailable', reasons: ['source_time_unknown']});
  assert.equal(result.candidates.status, 'unavailable');
  assert.deepEqual(counts(result), [null, null, null, null, null, null]);
});

test('LP-25 recorded source metric shapes preserve exact, lower-bound and unavailable states', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const cases = [
    [{value: {numerator: 7, denominator: 3}, status: 'exact_recorded', reasons: []},
      {value: {numerator: 7, denominator: 3}, status: 'exact_recorded', reasons: []}],
    [{value: {numerator: 7, denominator: 3}, status: 'lower_bound', reasons: []},
      {value: {numerator: 7, denominator: 3}, status: 'lower_bound', reasons: []}],
    [{value: null, status: 'unavailable', reasons: ['source_time_unknown']},
      {value: null, status: 'unavailable', reasons: ['source_time_unknown']}],
    [{value: {numerator: 0, denominator: 1}, status: 'exact_recorded', reasons: []},
      {value: {numerator: 0, denominator: 1}, status: 'exact_recorded', reasons: []}],
  ];
  for (const [metric, expected] of cases) {
    const f = F.fixture();
    const buckets = metric.status === 'unavailable' ? [F.bucket('legacy-unknown', null)]
      : [F.bucket('legacy-record', 3, F.clone(metric.value))];
    if (metric.status === 'lower_bound') buckets.push(F.bucket('legacy-unknown', null));
    f.observations.lifetimeMetrics.value.metrics.source_time_totals.push({
      source_kind: 'legacy-measured-v1', seconds: metric, buckets});
    const result = present(f.current, f.observations);
    assert.deepEqual(result.sources[1].seconds, expected);
    assert.deepEqual(result.sources[0].seconds, {value: {numerator: 5, denominator: 2}, status: 'exact_recorded', reasons: []});
    assert.equal(result.statuses[0].value, true);
  }
});

test('LP-26 unsafe or malformed rational seconds fail locally without erasing admitted siblings', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const invalid = [undefined, null, 1, '1/2', [], {}, {numerator: 1}, {denominator: 2},
    {numerator: -1, denominator: 2}, {numerator: 1.5, denominator: 2},
    {numerator: '5', denominator: 2}, {numerator: 5, denominator: '2'},
    {numerator: 5n, denominator: 2}, {numerator: true, denominator: 2},
    {numerator: NaN, denominator: 2}, {numerator: Infinity, denominator: 2},
    {numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 2},
    {numerator: 5, denominator: Number.MAX_SAFE_INTEGER + 1},
    {numerator: 5, denominator: 0}, {numerator: 5, denominator: -1}, {numerator: 5, denominator: 1.5}];
  for (const value of invalid) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals = F.allSources();
    f.observations.lifetimeMetrics.value.metrics.source_time_totals[4].seconds.value = value;
    const result = present(f.current, f.observations);
    assert.deepEqual(result.sources[4].seconds, {value: null, status: 'unavailable', reasons: ['unsafe_or_invalid_metric']});
    assert.deepEqual(result.sources[2].seconds, {value: {numerator: 7, denominator: 3}, status: 'exact_recorded', reasons: []});
    assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
    assert.equal(result.candidates.metrics[0].value, 2);
  }
  for (const value of [{numerator: Number.MAX_SAFE_INTEGER, denominator: 1},
    {numerator: 1, denominator: Number.MAX_SAFE_INTEGER}]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals[0].seconds.value = value;
    assert.deepEqual(present(f.current, f.observations).sources[0].seconds.value, value);
  }
  for (const metric of [undefined, null, [], {}, {value: null, status: 'unavailable'},
    {value: {numerator: 1, denominator: 1}, status: 'exact_recorded', reasons: null}]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals[0].seconds = metric;
    const result = present(f.current, f.observations);
    assert.deepEqual(result.sources[0].seconds, {value: null, status: 'unavailable', reasons: ['invalid_metric']});
    assert.equal(result.statuses[0].value, true);
  }
  for (const metric of [
    {value: null, status: 'exact_recorded', reasons: []},
    {value: {numerator: 1, denominator: 1}, status: 'unavailable', reasons: []},
    {value: {numerator: 1, denominator: 1}, status: 'estimated', reasons: []}]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals[0].seconds = metric;
    assert.deepEqual(present(f.current, f.observations).sources[0].seconds,
      {value: null, status: 'unavailable', reasons: ['unsafe_or_invalid_metric']});
  }
});

test('LP-27 actual candidate unavailable forms preserve reasons without qualification', async () => {
  const {projectTopListeningPresentation: present} = await load();
  // Literal producer branches, not reasons synthesized by the implementation.
  // _candidate_project always couples continuity uncertainty to traversal_unknown.
  const cases = [
    {name: 'denominator unavailable', timeUnavailable: true,
      groupReasons: ['candidate_only', 'denominator_unavailable', 'qualification_pending'],
      unavailableReasons: ['candidate_only', 'denominator_unavailable', 'qualification_pending']},
    {name: 'traversal unknown', timeUnavailable: false,
      groupReasons: ['candidate_only', 'qualification_pending', 'traversal_unknown'],
      unavailableReasons: ['candidate_only', 'qualification_pending', 'traversal_unknown']},
    {name: 'continuity and traversal unknown', timeUnavailable: false,
      groupReasons: ['candidate_only', 'continuity_unknown', 'qualification_pending', 'traversal_unknown'],
      unavailableReasons: ['candidate_only', 'continuity_unknown', 'qualification_pending', 'traversal_unknown']},
  ];
  for (const scenario of cases) {
    const f = F.fixture(), value = f.observations.candidates.value;
    value.reasons = [...scenario.groupReasons];
    value.witnesses = [];
    if (scenario.timeUnavailable) {
      // This observed snapshot has an incomplete denominator, so Stage A also
      // declares its missing denominator while preserving measured native time.
      f.observations.lifetimeMetrics.value.reasons = ['allocation_not_evaluated', 'denominator_unavailable'];
    }
    for (const key of METRIC_KEYS) {
      if (!scenario.timeUnavailable && key === 'album_time_equivalents') continue;
      value.metrics[key] = {value: null, status: 'unavailable', reasons: [...scenario.unavailableReasons]};
    }
    const result = present(f.current, f.observations);
    assert.equal(result.candidates.status, 'proposed', scenario.name);
    assert.equal(result.candidates.target_current, true);
    assert.deepEqual(result.candidates.reasons, scenario.groupReasons);
    for (const row of result.candidates.metrics) {
      if (!scenario.timeUnavailable && row.key === 'album_time_equivalents') {
        assert.deepEqual(row.value, {numerator: 5, denominator: 2});
        assert.equal(row.status, 'exact_recorded');
        assert.deepEqual(row.reasons, ['candidate_only', 'qualification_pending']);
      } else {
        assert.equal(row.value, null); assert.equal(row.status, 'unavailable');
        assert.deepEqual(row.reasons, scenario.unavailableReasons);
      }
    }
    assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
    assert.equal(result.completion.automatic, 'unknown');
  }
  // An authoritative one-track snapshot with no native Runs, reported plays,
  // losses or traversal paths genuinely produces exact zero candidate metrics.
  const zero = F.fixture(), stage = zero.observations.lifetimeMetrics.value;
  stage.metrics.native_recorded_frames = F.exact(0);
  stage.metrics.known_position_frames = F.exact(0);
  stage.metrics.track_coverage = [{track_id: 101, source_intervals: [], known_position_frames: F.exact(0)}];
  stage.metrics.source_time_totals[0].seconds = F.exact({numerator: 0, denominator: 1});
  stage.predicates.has_plays = false;
  zero.observations.candidates.value.witnesses = [];
  for (const key of METRIC_KEYS) zero.observations.candidates.value.metrics[key].value =
    ['target_coverage', 'album_time_equivalents'].includes(key) ? {numerator: 0, denominator: 1} : 0;
  const result = present(zero.current, zero.observations);
  assert.deepEqual(counts(result),
    [0, 0, 0, {numerator: 0, denominator: 1}, 0, {numerator: 0, denominator: 1}]);
  assert.deepEqual(flags(result), [false, 'unknown', true, 'unknown']);
  assert.equal(result.completion.automatic, 'unknown');
  assert.deepEqual(result.candidates.reasons, ['candidate_only', 'qualification_pending']);
  for (const row of result.candidates.metrics) {
    assert.equal(row.status, 'exact_recorded');
    assert.deepEqual(row.reasons, ['candidate_only', 'qualification_pending']);
  }
});

test('LP-28 candidate family shape is proposed only and rejects qualification spoofing', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const patches = [v => {v.status = 'ready';}, v => {v.policy_status = 'approved';},
    v => {v.policy_version = 'album-overlap-r3-candidate-v2';}, v => {v.qualification = true;},
    v => {v.qualification = 'qualified';}, v => {v.predicates = null;},
    v => {v.predicates.listened = true;}, v => {v.predicates.listened = null;},
    v => {v.required_time_basis = 'minutes';}, v => {v.completion_witnesses = [{}];},
    v => {v.completion_witnesses = null;}, v => {v.witnesses = null;},
    v => {v.reasons = ['candidate_only'];}, v => {v.reasons = ['qualification_pending'];},
    v => {v.reasons = null;}, v => {v.metrics = null;}, v => {v.metrics = [];}];
  for (const patch of patches) {
    const f = F.fixture(); patch(f.observations.candidates.value);
    assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
  }
  for (const target of [undefined, null, false, 0, -1, 1.5, NaN, Infinity, '5', 5n, Number.MAX_SAFE_INTEGER + 1]) {
    const f = F.fixture(); f.observations.candidates.value.target = target;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
  }
  for (const value of [{status: 'incomplete', reasons: ['resource_limit']},
    {status: 'invalid_metrics_input', reasons: ['evidence_conflict']}]) {
    const f = F.fixture(); f.observations.candidates.value = value;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'candidates');
  }
});

test('LP-29 candidate unsafe integer and rational values become unavailable individually', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const key of ['full', 'partial', 'uninterrupted_full', 'tracks_at_target']) {
    for (const value of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
      '2', '9007199254740993', 2n, false, [], {}, new Number(2)]) {
      const f = F.fixture(); f.observations.candidates.value.metrics[key].value = value;
      const result = present(f.current, f.observations), row = result.candidates.metrics.find(row => row.key === key);
      assert.deepEqual({value: row.value, status: row.status, reasons: row.reasons},
        {value: null, status: 'unavailable', reasons: ['unsafe_or_invalid_metric']});
      assert.equal(result.candidates.status, 'proposed');
      assert.deepEqual(result.candidates.metrics[5].value, {numerator: 5, denominator: 2});
      assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
    }
  }
  for (const key of ['target_coverage', 'album_time_equivalents']) for (const value of [null, 0.5, '1/2', [], {},
    {numerator: -1, denominator: 2}, {numerator: 1, denominator: 0}, {numerator: 1, denominator: -2},
    {numerator: '1', denominator: 2}, {numerator: 1, denominator: '2'}, {numerator: 1n, denominator: 2},
    {numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 2},
    {numerator: 1, denominator: Number.MAX_SAFE_INTEGER + 1}]) {
    const f = F.fixture(); f.observations.candidates.value.metrics[key].value = value;
    const result = present(f.current, f.observations), row = result.candidates.metrics.find(row => row.key === key);
    assert.equal(row.value, null); assert.equal(row.status, 'unavailable');
    assert.deepEqual(row.reasons, ['unsafe_or_invalid_metric']);
    assert.equal(result.candidates.metrics[0].value, 2);
  }
  const max = F.fixture(); max.observations.candidates.value.metrics.full.value = Number.MAX_SAFE_INTEGER;
  max.observations.candidates.value.metrics.album_time_equivalents.value = {numerator: 1, denominator: Number.MAX_SAFE_INTEGER};
  const result = present(max.current, max.observations);
  assert.equal(result.candidates.metrics[0].value, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(result.candidates.metrics[5].value, {numerator: 1, denominator: Number.MAX_SAFE_INTEGER});
});

test('LP-30 candidate numeric status and reasons must themselves remain explicitly proposed', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const key of METRIC_KEYS) for (const patch of [m => {m.status = 'lower_bound';},
    m => {m.reasons = [];}, m => {m.reasons = ['candidate_only'];},
    m => {m.reasons = ['qualification_pending'];}]) {
    const f = F.fixture(); patch(f.observations.candidates.value.metrics[key]);
    const result = present(f.current, f.observations), row = result.candidates.metrics.find(row => row.key === key);
    assert.equal(row.value, null); assert.equal(row.status, 'unavailable');
    assert.deepEqual(row.reasons, ['invalid_candidate_metric']);
    assert.equal(result.candidates.status, 'proposed');
    assert.equal(result.completion.automatic, 'unknown');
  }
  for (const key of METRIC_KEYS) {
    const f = F.fixture(); delete f.observations.candidates.value.metrics[key];
    const row = present(f.current, f.observations).candidates.metrics.find(row => row.key === key);
    assert.equal(row.value, null); assert.deepEqual(row.reasons, ['invalid_metric']);
  }
});

test('LP-31 source list shape and unique required namespaces are family boundaries', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const invalid = [undefined, null, {}, [], [null], [undefined], new Array(1),
    [{source_kind: 'lastfm-scrobble', seconds: F.missing('source_time_unknown'), buckets: []}],
    [{source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: null}],
    [{source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: [{}]}],
    [{source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: []},
      {source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: []}]];
  for (const rows of invalid) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals = rows;
    assertOnlyFamilyRejected(present(f.current, f.observations), 'lifetimeMetrics');
  }
  for (const source_kind of ['spotify', 'Native', '__proto__', 'constructor', '<img src=x>', '', null, 1]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals.push({
      source_kind, seconds: F.missing('source_time_unknown'), buckets: []});
    assertOnlyFamilyRejected(present(f.current, f.observations), 'lifetimeMetrics');
  }
  const six = F.fixture(); six.observations.lifetimeMetrics.value.metrics.source_time_totals =
    [...F.allSources(), {source_kind: 'native-v2', seconds: F.exact({numerator: 0, denominator: 1}), buckets: []}];
  assertOnlyFamilyRejected(present(six.current, six.observations), 'lifetimeMetrics');
});

test('LP-32 non-string source namespaces are rejected without coercion, aliasing or thrown projection', async () => {
  const {projectTopListeningPresentation: present} = await load();
  // This is a contract regression, not acceptance of the P1 implementation.
  for (const source_kind of [['lastfm-scrobble'], ['native-v2'], new String('manual-reported'),
    {toString: null}, {toString: ['lastfm-scrobble']}, {valueOf: null, toString: null}]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals.push({
      source_kind, seconds: F.missing('source_time_unknown'), buckets: []});
    // A throw fails this test. A bad lifetime family must not hide manual truth.
    const result = present(f.current, f.observations);
    assertOnlyFamilyRejected(result, 'lifetimeMetrics');
    assert.equal(result.completion.manual, true);
    assert.equal(Object.isFrozen(source_kind), false);
  }
});

test('LP-33 producer bucket boundaries admit 1024 total and reject overflow without summing times', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const total of [0, 1, 1024]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals.push({
      source_kind: 'manual-reported', seconds: F.missing('source_time_unknown'),
      buckets: Array.from({length: total}, (_, i) => F.bucket('record-' + i, 1))});
    const result = present(f.current, f.observations);
    assert.equal(result.statuses[0].value, true); assert.equal(result.sources.length, 2);
    assert.deepEqual(result.sources[1].seconds, {value: null, status: 'unavailable', reasons: ['source_time_unknown']});
  }
  const single = F.fixture(); single.observations.lifetimeMetrics.value.metrics.source_time_totals.push({
    source_kind: 'manual-reported', seconds: F.missing('source_time_unknown'),
    buckets: Array.from({length: 1025}, (_, i) => F.bucket('record-' + i, 1))});
  assertOnlyFamilyRejected(present(single.current, single.observations), 'lifetimeMetrics');
  for (const secondCount of [512, 513]) {
    const f = F.fixture();
    for (const [source_kind, count] of [['lastfm-scrobble', 512], ['manual-reported', secondCount]]) {
      f.observations.lifetimeMetrics.value.metrics.source_time_totals.push({source_kind,
        seconds: F.missing('source_time_unknown'), buckets: Array.from({length: count}, (_, i) => F.bucket('record-' + i, 1))});
    }
    if (secondCount === 512) assert.equal(present(f.current, f.observations).sources.length, 3);
    else assertOnlyFamilyRejected(present(f.current, f.observations), 'lifetimeMetrics');
  }
});

test('LP-34 reason bounds apply locally and reject sparse or malformed reason lists', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const bad of [undefined, null, 'reason', [null], [1], [''], ['bad\nreason'],
    ['x'.repeat(129)], ['é'.repeat(65)], ['\ud800'], new Array(1), Array(33).fill('reason')]) {
    const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals[0].seconds.reasons = bad;
    const result = present(f.current, f.observations);
    assert.deepEqual(result.sources[0].seconds, {value: null, status: 'unavailable', reasons: ['invalid_metric']});
    assert.equal(result.statuses[0].value, true);
    const candidate = F.fixture(); candidate.observations.candidates.value.metrics.full.reasons = bad;
    assert.deepEqual(present(candidate.current, candidate.observations).candidates.metrics[0].reasons, ['invalid_metric']);
  }
  for (const family of ['lifetimeMetrics', 'candidates']) {
    const f = F.fixture(), required = family === 'lifetimeMetrics'
      ? ['allocation_not_evaluated'] : ['candidate_only', 'qualification_pending'];
    f.observations[family].value.reasons = [...required, ...Array(32 - required.length).fill('source_reason')];
    const result = present(f.current, f.observations);
    assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
    assert.equal(result.candidates.status, 'proposed');
    f.observations[family].value.reasons.push('one_too_many');
    assertOnlyFamilyRejected(present(f.current, f.observations), family);
  }
  const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals[0].seconds.reasons = Array(32).fill('x'.repeat(128));
  const result = present(f.current, f.observations);
  assert.equal(result.sources[0].seconds.status, 'exact_recorded');
  assert.equal(result.sources[0].seconds.reasons.length, 32);
});

test('LP-35 invalid or mismatched targets disable only target-dependent candidate metrics', async () => {
  const {projectTopListeningPresentation: present} = await load();
  for (const target of [1, 6, Number.MAX_SAFE_INTEGER, null, false, 0, -1, 1.5, '5', 5n, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1]) {
    const f = F.fixture(), result = present(f.current, f.observations, target);
    assert.equal(result.candidates.status, 'proposed');
    assert.equal(result.candidates.target_current, false);
    assert.deepEqual(counts(result), [2, 1, 1, null, null, {numerator: 5, denominator: 2}]);
    for (const index of [3, 4]) {
      assert.equal(result.candidates.metrics[index].status, 'unavailable');
      assert.deepEqual(result.candidates.metrics[index].reasons, ['target_not_current']);
    }
    assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
    assert.deepEqual(result.sources[0].seconds.value, {numerator: 5, denominator: 2});
  }
  for (const target of [undefined, 5]) {
    const f = F.fixture(), result = present(f.current, f.observations, target);
    assert.equal(result.candidates.target_current, true);
    assert.deepEqual(result.candidates.metrics[3].value, {numerator: 1, denominator: 2});
    assert.equal(result.candidates.metrics[4].value, 0);
  }
  const changed = F.fixture(); changed.observations.candidates.value.target = 1;
  changed.observations.candidates.value.metrics.target_coverage.value = {numerator: 1, denominator: 1};
  changed.observations.candidates.value.metrics.tracks_at_target.value = 1;
  const result = present(changed.current, changed.observations, 1);
  assert.equal(result.candidates.target_current, true);
  assert.deepEqual(counts(result), [2, 1, 1, {numerator: 1, denominator: 1}, 1, {numerator: 5, denominator: 2}]);
});

test('LP-36 changing target does not rewrite evidence, recalculate counts or qualify anything', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(), before = F.clone(f);
  F.deepFreeze(f);
  const initial = present(f.current, f.observations, 5), changed = present(f.current, f.observations, 9),
    returned = present(f.current, f.observations, 5);
  assert.deepEqual(f, before);
  assert.deepEqual(counts(initial), [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
  assert.deepEqual(counts(changed), [2, 1, 1, null, null, {numerator: 5, denominator: 2}]);
  assert.deepEqual(counts(returned), [2, 1, 1, {numerator: 1, denominator: 2}, 0, {numerator: 5, denominator: 2}]);
  assert.deepEqual(changed.sources, initial.sources);
  assert.deepEqual(changed.statuses, initial.statuses);
  assert.deepEqual(changed.completion, {manual: true, automatic: 'unknown'});
  assert.equal(changed.candidates.metrics[0].value, 2, 'Full remains 2, not Full 2 plus uninterrupted 1');
  assert.equal(changed.candidates.metrics[2].value, 1);
  assert.equal(f.observations.candidates.value.target, 5);
  assert.equal(f.observations.manualProgress.value.manual_completed_at, F.TIME);
  assert.deepEqual(Object.keys(changed), ['target', 'statuses', 'completion', 'sources', 'candidates']);
});

test('LP-37 every returned container is fresh and frozen without freezing or aliasing inputs', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(); f.observations.lifetimeMetrics.value.metrics.source_time_totals = F.allSources();
  const before = F.clone(f), inputObjects = F.objectReferences(f);
  const first = present(f.current, f.observations), second = present(f.current, f.observations);
  const firstObjects = F.objectReferences(first), secondObjects = F.objectReferences(second);
  assert.deepEqual(f, before);
  for (const object of inputObjects) assert.equal(Object.isFrozen(object), false);
  for (const object of firstObjects) {
    assert.ok(Object.isFrozen(object));
    assert.equal(inputObjects.has(object), false);
    assert.equal(secondObjects.has(object), false);
  }
  for (const object of secondObjects) assert.ok(Object.isFrozen(object));
  assert.deepEqual(first, second);
  assert.throws(() => {first.completion.manual = false;}, TypeError);
  assert.throws(() => {first.statuses.push({});}, TypeError);
  assert.throws(() => {first.sources[2].seconds.value.numerator = 99;}, TypeError);
  assert.throws(() => {first.candidates.metrics[0].reasons.push('qualified');}, TypeError);
  f.observations.candidates.value.metrics.full.value = 99;
  f.observations.lifetimeMetrics.value.metrics.source_time_totals[2].seconds.value.numerator = 99;
  assert.equal(first.candidates.metrics[0].value, 2);
  assert.deepEqual(first.sources[2].seconds.value, {numerator: 7, denominator: 3});
  const absent1 = present(), absent2 = present();
  for (const object of F.objectReferences(absent1)) {
    assert.ok(Object.isFrozen(object)); assert.equal(F.objectReferences(absent2).has(object), false);
  }
});

test('LP-38 scope string resource bound rejects over-limit whitespace without changing identity semantics', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture(), raw = f.current.scopeKey;
  f.current.scopeKey = raw + ' '.repeat(256 - raw.length); rebind(f);
  assert.deepEqual(flags(present(f.current, f.observations)), [true, 'unknown', true, 'unknown']);
  f.current.scopeKey += ' '; rebind(f);
  assertUnknown(present(f.current, f.observations));
});

test('LP-39 maximum safe candidate target is current while an unsafe derived rational stays unavailable', async () => {
  const {projectTopListeningPresentation: present} = await load();
  const f = F.fixture();
  f.observations.candidates.value.target = Number.MAX_SAFE_INTEGER;
  // An upstream exact rational can exceed JavaScript safety even with a safe target.
  // 5 / 18014398509481982 is the reduced 2.5-album / target coverage here.
  f.observations.candidates.value.metrics.target_coverage.value = {numerator: 5, denominator: 18014398509481982};
  // Stage A has no target-dependent admitted metric in this presentation.
  f.observations.lifetimeMetrics.value.target = 11;
  const result = present(f.current, f.observations, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(result.target, {value: Number.MAX_SAFE_INTEGER, status: 'provided'});
  assert.equal(result.candidates.target_current, true);
  assert.deepEqual(counts(result), [2, 1, 1, null, 0, {numerator: 5, denominator: 2}]);
  assert.deepEqual(result.candidates.metrics[3].reasons, ['unsafe_or_invalid_metric']);
  assert.deepEqual(flags(result), [true, 'unknown', true, 'unknown']);
  assert.deepEqual(result.sources[0].seconds.value, {numerator: 5, denominator: 2});
});
