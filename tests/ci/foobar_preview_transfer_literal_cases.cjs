'use strict';

/*
 * SOURCE-ONLY AUTHORING: this file has not been executed or collected.
 * Future execution is the separately authorized, exact whole-file CLI below.
 * The subject is the hash-bound workflow literal, not a copied algorithm.
 * Pure host path/UTF-8/hash operations are mediated; no host require, process,
 * environment, filesystem, network, timer or stream enters the subject context.
 * A VM is not asserted to be a security sandbox. Trusted pinned source, closed
 * fake capabilities, post-case audits and the owned child boundary are required.
 */
const assert = require('node:assert/strict');
const hostFS = require('node:fs');
const hostPath = require('node:path');
const hostCrypto = require('node:crypto');
const hostVM = require('node:vm');
const {TextDecoder: HostTextDecoder} = require('node:util');
const HostBuffer = Buffer;
const HOST_VERSION = process.version;
const FILE = 'tests/ci/foobar_preview_transfer_literal_cases.cjs';
const WORKFLOW = '.github/workflows/foobar-preview-backend-evidence.yml';
const WORKFLOW_SHA = 'c5cccbcbdfdbe85ce637fdc454a7f2c786d227d080c0814e5d08b707d8707726';
const LITERAL_SHA = '65a5239082ab154affd06ec85183a5ecd451d630954e43d8aeb04ca46eebbe90';
const LITERAL_BYTES = 15483;
const CAP = Object.freeze({metadata: 1048576, metadataTotal: 2097152, rpc: 262144,
  artifact: 268435456, aggregate: 2147483648, file: 33554432, pull: 65536});
const NAMES = Object.freeze([
  'positive_helper_exact_artifact',
  'positive_reconcile_complete_chain',
  'two_anonymous_metadata_requests',
  'raw_acquisition_bytes_and_digests',
  'public_api_and_blob_no_authorization',
  'artifact_service_only_synthetic_token',
  'metadata_non200',
  'artifact_service_non200',
  'blob_non200',
  'metadata_link_header',
  'metadata_location_header',
  'redirect_no_follow',
  'compressed_response',
  'stream_error',
  'stream_aborted',
  'incomplete_stream',
  'request_timeout',
  'cancellation',
  'shared_deadline_not_reset',
  'request_deadline_at_10_seconds',
  'request_deadline_over_10_seconds',
  'shared_deadline_before_110_seconds',
  'shared_deadline_at_110_seconds',
  'no_retry_or_credential_fallback',
  'metadata_declared_exact_limit',
  'metadata_declared_over_limit',
  'metadata_chunked_over_limit',
  'metadata_aggregate_exact_limit',
  'metadata_aggregate_over_limit',
  'blob_declared_over_capacity',
  'blob_chunked_over_capacity',
  'actual_length_short',
  'actual_length_long',
  'invalid_utf8',
  'nonfinite_exponent_positive',
  'nonfinite_exponent_negative',
  'nonfinite_literal',
  'wrong_artifact_owner',
  'wrong_artifact_name',
  'wrong_artifact_run',
  'wrong_artifact_id',
  'wrong_artifact_digest',
  'duplicate_artifact_ids',
  'unsupported_signed_host',
  'request_pull_64k_bound',
  'buffer_capacity_bound',
  'fixture_file_read_64k_bound',
  'fixture_file_mutation_during_read',
  'fixture_symlink_rejected',
  'archive_aggregate_over_limit',
  'retained_outputs_no_bearer',
  'retained_outputs_no_signed_url',
  'missing_upload_outputs_reconcile_explicit_absence',
  'missing_upload_outputs_producer_holds',
  'partial_upload_identity_rejected',
  'fixture_forbidden_effect_attempt_survives_catch',
  'fixture_unlisted_module_denied',
  'fixture_host_environment_not_exposed'
]);
const IDS = Object.freeze(NAMES.map(name => FILE + '::' + name));
const SOURCE_PATHS = Object.freeze([
  '.github/workflows/foobar-preview-backend-evidence.yml',
  '.github/workflows/new-feature-backend-evidence.yml',
  'scripts/ci/admit-new-feature-evidence.py',
  'scripts/ci/new_feature_evidence.py',
  'scripts/ci/foobar_preview_evidence.py',
  'scripts/ci/foobar_preview_plan.json',
  'tests/py/test_new_feature_ci_contract.py',
  'tests/py/test_new_feature_evidence.py',
  'tests/py/test_foobar_preview_ci_contract.py',
  'tests/py/test_foobar_preview_evidence.py',
  'music_app/services/foobar_snapshot_parser.py',
  'music_app/services/foobar_snapshot_preview.py',
  'tests/py/test_foobar_snapshot_preview.py',
  'tests/py/test_foobar_snapshot_preview_resources.py',
  '.github/workflows/foobar-preview-validation-controls.yml',
  'scripts/ci/foobar_preview_controls_evidence.py',
  'tests/ci/foobar_preview_validation_controls_cases.py',
  FILE,
  'requirements.txt'
]);
const OWNERS = Object.freeze(['admission', 'helper', 'core', 'resource_1', 'resource_2', 'resource_3', 'resource_4']);
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const RUN = 314159;
const ATTEMPT = 2;
const BACKEND_RUN = '11111111-1111-1111-1111-111111111111';
const BACKEND_CONSUMER = '22222222-2222-2222-2222-222222222222';
const BACKEND_PRODUCER = '33333333-3333-3333-3333-333333333333';
const SYNTHETIC_TOKEN = 'SYNTHETIC_NOT_A_CREDENTIAL.' +
  HostBuffer.from(JSON.stringify({scp: 'Actions.Results:' + BACKEND_RUN + ':' + BACKEND_CONSUMER})).toString('base64url') + '.SYNTHETIC_SIGNATURE';
const SYNTHETIC_QUERY = '?sig=SYNTHETIC_NOT_A_SIGNED_CREDENTIAL';
const BASE_TIME = 1760000000000;
function hash(bytes) { return hostCrypto.createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value) { return HostBuffer.from(JSON.stringify(value) + '\n'); }
function sortedKeys(value) { return Object.keys(value).sort(); }
function exactKeys(value, keys) { assert.deepEqual(sortedKeys(value), [...keys].sort()); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function utf8(bytes) { return new HostTextDecoder('utf-8', {fatal: true}).decode(bytes); }
function strictJSON(bytes) {
  const source = utf8(bytes);
  let cursor = 0;
  let depth = 0;
  function whitespace() { while (cursor < source.length && /[ \t\r\n]/.test(source[cursor])) cursor += 1; }
  function string() {
    assert.equal(source[cursor], '"');
    const start = cursor++;
    let escaped = false;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === '"' && !escaped) return JSON.parse(source.slice(start, cursor));
      if (char === '\\' && !escaped) escaped = true; else escaped = false;
    }
    assert.fail('unfinished JSON string');
  }
  function value() {
    whitespace();
    assert.ok(++depth <= 64);
    let result;
    if (source[cursor] === '{') {
      cursor += 1; whitespace(); result = {};
      const seen = new Set();
      if (source[cursor] !== '}') for (;;) {
        whitespace(); const key = string();
        assert.equal(seen.has(key), false, 'duplicate JSON key'); seen.add(key);
        whitespace(); assert.equal(source[cursor++], ':');
        Object.defineProperty(result, key, {value: value(), enumerable: true, configurable: true, writable: true});
        whitespace(); if (source[cursor] !== ',') break; cursor += 1;
      }
      assert.equal(source[cursor++], '}');
    } else if (source[cursor] === '[') {
      cursor += 1; whitespace(); result = [];
      if (source[cursor] !== ']') for (;;) {
        result.push(value()); whitespace(); if (source[cursor] !== ',') break; cursor += 1;
      }
      assert.equal(source[cursor++], ']');
    } else if (source[cursor] === '"') result = string();
    else {
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(cursor));
      assert.ok(token); cursor += token[0].length; result = JSON.parse(token[0]);
      if (typeof result === 'number') assert.ok(Number.isFinite(result));
    }
    depth -= 1; return result;
  }
  const result = value(); whitespace(); assert.equal(cursor, source.length); return result;
}
function artifactName(owner) { return 'preview-v1-' + HEAD + '-' + RUN + '-' + ATTEMPT + '-' + owner; }
function artifactPayload(owner) {
  // Arbitrary source-known archive transfer bytes. ZIP decoding is a separate
  // Python owner; this literal must transfer these exact bytes without parsing.
  return HostBuffer.from('SYNTHETIC_ARCHIVE_BYTES\0' + owner + '\0END\n');
}
function padJSON(value, length) {
  const data = jsonBytes(value);
  assert.ok(data.length <= length);
  return HostBuffer.concat([data, HostBuffer.alloc(length - data.length, 0x20)]);
}

function extractLiteral(bytes) {
  const text = utf8(bytes);
  assert.ok(!text.includes('\r') && !text.includes('\t'), 'ambiguous workflow indentation');
  const lines = text.split('\n');
  const candidates = lines.map((line, index) => ({line, index})).filter(x => /PREVIEW_TRANSFER_SCRIPT\s*:/.test(x.line));
  assert.equal(candidates.length, 1, 'literal must have one declaration');
  const start = candidates[0].index;
  assert.equal(lines[start], '  PREVIEW_TRANSFER_SCRIPT: |');
  let top = start - 1;
  while (top >= 0 && (lines[top] === '' || lines[top].startsWith(' '))) top -= 1;
  assert.equal(lines[top], 'env:', 'literal must belong to top-level env');
  const body = [];
  let cursor = start + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line === '') { body.push(''); continue; }
    if (!line.startsWith('    ')) {
      assert.ok(!line.startsWith('   '), 'unexpected block indentation');
      break;
    }
    body.push(line.slice(4));
  }
  assert.ok(cursor < lines.length && body.length > 0, 'unclosed literal');
  while (body.length && body[body.length - 1] === '') body.pop();
  const literal = body.join('\n') + '\n';
  assert.equal(HostBuffer.byteLength(literal), LITERAL_BYTES);
  assert.equal(hash(literal), LITERAL_SHA);
  return literal;
}

/* Host-side proof I/O is not available to the VM. All reads are bounded,
 * nofollow and descriptor-stable, including the harness's own source binding. */
function noLinkPath(root, relative) {
  assert.ok(hostPath.isAbsolute(root));
  assert.ok(!relative.includes('\\') && !relative.includes(':') && !relative.includes('\0'));
  const parts = relative.split('/');
  assert.ok(parts.every(p => p && p !== '.' && p !== '..'));
  let target = root;
  assert.ok(hostFS.lstatSync(target).isDirectory() && !hostFS.lstatSync(target).isSymbolicLink());
  for (let index = 0; index < parts.length; index += 1) {
    target = hostPath.join(target, parts[index]);
    const stat = hostFS.lstatSync(target);
    assert.ok(!stat.isSymbolicLink());
    assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory());
  }
  return target;
}
function boundedRead(filename, limit = CAP.file) {
  const descriptor = hostFS.openSync(filename, hostFS.constants.O_RDONLY | hostFS.constants.O_NOFOLLOW);
  try {
    const before = hostFS.fstatSync(descriptor);
    assert.ok(before.isFile() && before.size >= 0 && before.size <= limit);
    const bytes = HostBuffer.alloc(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = hostFS.readSync(descriptor, bytes, offset, Math.min(CAP.pull, before.size - offset), offset);
      assert.ok(read > 0);
      offset += read;
    }
    const after = hostFS.fstatSync(descriptor);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    return bytes;
  } finally { hostFS.closeSync(descriptor); }
}
function checkedContext(root, evidence) {
  assert.ok(hostPath.isAbsolute(root) && hostPath.isAbsolute(evidence));
  assert.equal(hostFS.realpathSync(root), root);
  assert.equal(hostFS.realpathSync(evidence), evidence);
  const context = strictJSON(boundedRead(noLinkPath(evidence, 'context.json'), 1048576));
  exactKeys(context, ['repository', 'head_sha', 'checkout_head', 'workflow_path', 'job_id',
    'run_id', 'run_attempt', 'root', 'git_executable', 'python_executable', 'node_executable',
    'python_version', 'node_version', 'source_hashes', 'event_sha256', 'admission_sha256',
    'admission_context_sha256', 'bootstrap_sha256', 'transfer_literal_sha256']);
  assert.match(context.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(context.checkout_head, context.head_sha);
  assert.ok(Number.isSafeInteger(context.run_id) && context.run_id > 0);
  assert.ok(Number.isSafeInteger(context.run_attempt) && context.run_attempt >= 2);
  for (const key of ['event_sha256', 'admission_sha256', 'admission_context_sha256', 'bootstrap_sha256', 'transfer_literal_sha256']) assert.match(context[key], /^[0-9a-f]{64}$/);
  for (const key of ['git_executable', 'python_executable', 'node_executable']) assert.ok(typeof context[key] === 'string' && hostPath.isAbsolute(context[key]));
  assert.ok(typeof context.python_version === 'string' && /3\.11/.test(context.python_version));
  assert.equal(context.root, root);
  assert.equal(context.repository, 'idanilovqa/AlbumHaven');
  assert.equal(context.workflow_path, '.github/workflows/foobar-preview-validation-controls.yml');
  assert.equal(context.job_id, 'validation_controls');
  assert.equal(context.node_version, HOST_VERSION);
  assert.match(HOST_VERSION, /^v20\./);
  assert.equal(hostFS.realpathSync(process.execPath), hostFS.realpathSync(context.node_executable));
  exactKeys(context.source_hashes, SOURCE_PATHS);
  let workflow;
  for (const relative of SOURCE_PATHS) {
    assert.match(context.source_hashes[relative], /^[0-9a-f]{64}$/);
    const bytes = boundedRead(noLinkPath(root, relative));
    assert.equal(hash(bytes), context.source_hashes[relative], 'source binding mismatch');
    if (relative === WORKFLOW) workflow = bytes;
  }
  assert.equal(context.source_hashes[WORKFLOW], WORKFLOW_SHA);
  assert.equal(context.transfer_literal_sha256, LITERAL_SHA);
  assert.equal(hostFS.realpathSync(__filename), hostFS.realpathSync(noLinkPath(root, FILE)));
  const literal = extractLiteral(workflow);
  const binding = {workflow_path: WORKFLOW, workflow_sha256: context.source_hashes[WORKFLOW],
    literal_sha256: LITERAL_SHA, harness_path: FILE, harness_sha256: context.source_hashes[FILE],
    capability_profile: 'foobar-preview-transfer-fakes-v1', node_version: HOST_VERSION};
  return {literal, binding};
}

class HarnessFault extends Error { constructor() { super('synthetic harness invariant'); this.name = 'HarnessFault'; } }

/* Build expectations independently before constructing any fake capability. */
function fixture(name, nonfiniteLiteral = 'NaN') {
  const reconcile = ['positive_reconcile_complete_chain', 'shared_deadline_not_reset',
    'shared_deadline_before_110_seconds', 'shared_deadline_at_110_seconds',
    'duplicate_artifact_ids', 'archive_aggregate_over_limit',
    'missing_upload_outputs_reconcile_explicit_absence'].includes(name);
  const consumer = reconcile ? 'reconcile' : 'helper';
  const producers = reconcile ? [...OWNERS] : ['admission'];
  const event = {repository: {full_name: 'idanilovqa/AlbumHaven'}, pull_request: {head: {
    sha: HEAD, repo: {full_name: 'idanilovqa/AlbumHaven'}, ref: '2026-10-03-album-tops'}}};
  let eventBytes = jsonBytes(event);
  if (name === 'fixture_file_read_64k_bound') eventBytes = padJSON(event, 131089);
  const runData = {id: RUN, run_attempt: ATTEMPT, head_sha: HEAD, status: 'in_progress'};
  const jobsData = {total_count: producers.length, jobs: producers.map((owner, index) =>
    ({id: 900 + index, name: owner, status: 'completed', conclusion: 'success'}))};
  let runBytes = jsonBytes(runData);
  let jobsBytes = jsonBytes(jobsData);
  if (name === 'metadata_declared_exact_limit' || name === 'metadata_aggregate_exact_limit' || name === 'metadata_aggregate_over_limit') runBytes = padJSON(runData, CAP.metadata);
  if (name === 'metadata_aggregate_exact_limit') jobsBytes = padJSON(jobsData, CAP.metadata);
  if (name === 'metadata_aggregate_over_limit') jobsBytes = padJSON(jobsData, CAP.metadata + 1);
  if (name === 'metadata_chunked_over_limit') runBytes = padJSON(runData, CAP.metadata + 1);
  if (name === 'request_pull_64k_bound' || name === 'buffer_capacity_bound') runBytes = padJSON(runData, 131097);
  const trusted = {};
  const artifacts = producers.map((owner, index) => {
    const bytes = artifactPayload(owner);
    const digest = hash(bytes);
    const id = 401 + index;
    trusted[owner] = {artifact_id: String(id), sha256: digest};
    return {owner, id, bytes, digest, size: bytes.length, name: artifactName(owner),
      signedURL: 'https://synthetic-artifacts.blob.core.windows.net/fixture/' + owner + SYNTHETIC_QUERY};
  });
  if (name === 'duplicate_artifact_ids') trusted.helper.artifact_id = trusted.admission.artifact_id;
  if (name === 'missing_upload_outputs_reconcile_explicit_absence') trusted.resource_2 = {artifact_id: '', sha256: ''};
  if (name === 'missing_upload_outputs_producer_holds') trusted.admission = {artifact_id: '', sha256: ''};
  if (name === 'partial_upload_identity_rejected') trusted.admission = {artifact_id: String(artifacts[0].id), sha256: ''};
  const environment = Object.freeze({GITHUB_JOB: consumer, GITHUB_REPOSITORY: 'idanilovqa/AlbumHaven',
    GITHUB_EVENT_NAME: 'pull_request', PREVIEW_CANCELLED: 'false', PREVIEW_EXPECTED_HEAD: HEAD,
    GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: String(ATTEMPT),
    GITHUB_EVENT_PATH: '/synthetic/event.json', PREVIEW_ARTIFACTS: JSON.stringify(trusted),
    ACTIONS_RUNTIME_TOKEN: SYNTHETIC_TOKEN, ACTIONS_RESULTS_URL: 'https://synthetic.actions.githubusercontent.com/',
    RUNNER_TEMP: '/synthetic/tmp'});
  const attemptURL = 'https://api.github.com/repos/idanilovqa/AlbumHaven/actions/runs/' + RUN + '/attempts/' + ATTEMPT;
  const metadata = [
    {kind: 'run', url: attemptURL, path: 'run-attempt.json', bytes: runBytes},
    {kind: 'jobs', url: attemptURL + '/jobs?per_page=100&page=1', path: 'attempt-jobs.json', bytes: jobsBytes}
  ];
  const responses = metadata.map(m => ({role: 'metadata', owner: null, url: m.url, method: 'GET',
    body: m.bytes, status: 200, headers: {'content-length': String(m.bytes.length)}, delay: 1}));
  for (const artifact of artifacts) {
    if (trusted[artifact.owner].artifact_id === '') continue;
    const record = {database_id: String(artifact.id), workflow_run_backend_id: BACKEND_RUN,
      workflow_job_run_backend_id: BACKEND_PRODUCER, name: artifact.name,
      size: String(artifact.size), digest: 'sha256:' + artifact.digest};
    if (artifact === artifacts[0]) {
      if (name === 'wrong_artifact_owner') record.name = artifactName('helper');
      if (name === 'wrong_artifact_name') record.name = artifact.name + '-unrecognized';
      if (name === 'wrong_artifact_run') record.workflow_run_backend_id = '44444444-4444-4444-4444-444444444444';
      if (name === 'wrong_artifact_id') record.database_id = String(artifact.id + 99);
      if (name === 'wrong_artifact_digest') record.digest = 'sha256:' + '0'.repeat(64);
      if (name === 'archive_aggregate_over_limit') record.size = String(CAP.aggregate + 1);
    }
    const listBody = jsonBytes({artifacts: [record]});
    responses.push({role: 'list', owner: artifact.owner,
      url: 'https://synthetic.actions.githubusercontent.com/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts',
      method: 'POST', body: listBody, status: 200, headers: {'content-length': String(listBody.length)}, delay: 1,
      requestBody: {workflow_run_backend_id: BACKEND_RUN, workflow_job_run_backend_id: BACKEND_CONSUMER, id_filter: String(artifact.id)}});
    const signedURL = name === 'unsupported_signed_host' ?
      'https://synthetic-unsupported.invalid/fixture' + SYNTHETIC_QUERY : artifact.signedURL;
    const signedBody = jsonBytes({signed_url: signedURL});
    responses.push({role: 'signed', owner: artifact.owner,
      url: 'https://synthetic.actions.githubusercontent.com/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL',
      method: 'POST', body: signedBody, status: 200, headers: {'content-length': String(signedBody.length)}, delay: 1,
      requestBody: {workflow_run_backend_id: BACKEND_RUN, workflow_job_run_backend_id: BACKEND_PRODUCER, name: artifact.name}});
    responses.push({role: 'blob', owner: artifact.owner, url: artifact.signedURL, method: 'GET',
      body: artifact.bytes, status: 200, headers: {'content-length': String(artifact.size)}, delay: 1});
  }
  const first = responses[0];
  const list = responses.find(r => r.role === 'list');
  const blob = responses.find(r => r.role === 'blob');
  const replaceBody = (response, bytes) => { response.body = bytes; response.headers['content-length'] = String(bytes.length); };
  if (name === 'metadata_non200' || name === 'no_retry_or_credential_fallback') first.status = 503;
  if (name === 'artifact_service_non200') list.status = 403;
  if (name === 'blob_non200') blob.status = 404;
  if (name === 'metadata_link_header') first.headers.link = '<https://synthetic-next.invalid/>; rel="next"';
  if (name === 'metadata_location_header') first.headers.location = 'https://synthetic-redirect.invalid/';
  if (name === 'redirect_no_follow') { first.status = 302; first.headers.location = 'https://synthetic-redirect.invalid/'; }
  if (name === 'compressed_response') first.headers['content-encoding'] = 'gzip';
  if (name === 'stream_error') first.streamFailure = 'error';
  if (name === 'stream_aborted') first.streamFailure = 'aborted';
  if (name === 'incomplete_stream') first.incomplete = true;
  if (name === 'cancellation') first.requestFailure = true;
  if (name === 'request_timeout') first.delay = 12000;
  if (name === 'request_deadline_at_10_seconds') first.delay = 10000;
  if (name === 'request_deadline_over_10_seconds') first.delay = 10001;
  if (name === 'shared_deadline_not_reset') for (const response of responses) response.delay = 5000;
  if (name === 'shared_deadline_before_110_seconds' || name === 'shared_deadline_at_110_seconds') {
    for (const response of responses) response.delay = 4782;
    responses[responses.length - 1].delay = (name.endsWith('before_110_seconds') ? 109999 : 110000) - 4782 * (responses.length - 1);
  }
  if (name === 'metadata_declared_over_limit') first.headers['content-length'] = String(CAP.metadata + 1);
  if (name === 'metadata_chunked_over_limit') delete first.headers['content-length'];
  if (name === 'blob_declared_over_capacity') blob.headers['content-length'] = String(artifacts[0].size + 1);
  if (name === 'blob_chunked_over_capacity' || name === 'actual_length_long') {
    blob.body = HostBuffer.concat([blob.body, HostBuffer.from([0x21])]);
    if (name === 'blob_chunked_over_capacity') delete blob.headers['content-length'];
  }
  if (name === 'actual_length_short') blob.body = blob.body.subarray(0, blob.body.length - 1);
  if (name === 'invalid_utf8') replaceBody(list, HostBuffer.concat([
    HostBuffer.from('{"ignored":"'), HostBuffer.from([0xff]), HostBuffer.from('",'), list.body.subarray(1)
  ]));
  if (name === 'nonfinite_exponent_positive') replaceBody(list, HostBuffer.from('{"ignored":1e999,' + utf8(list.body).slice(1)));
  if (name === 'nonfinite_exponent_negative') replaceBody(list, HostBuffer.from('{"ignored":-1e999,' + utf8(list.body).slice(1)));
  if (name === 'nonfinite_literal') {
    assert.ok(['NaN', 'Infinity', '-Infinity'].includes(nonfiniteLiteral));
    replaceBody(list, HostBuffer.from('{"ignored":' + nonfiniteLiteral + ',' + utf8(list.body).slice(1)));
  }
  const positives = new Set(NAMES.slice(0, 6).concat(['shared_deadline_before_110_seconds',
    'metadata_declared_exact_limit', 'metadata_aggregate_exact_limit', 'request_pull_64k_bound',
    'buffer_capacity_bound', 'fixture_file_read_64k_bound', 'retained_outputs_no_bearer',
    'retained_outputs_no_signed_url', 'missing_upload_outputs_reconcile_explicit_absence',
    'fixture_forbidden_effect_attempt_survives_catch', 'fixture_unlisted_module_denied',
    'fixture_host_environment_not_exposed']));
  return {name, consumer, producers, artifacts, trusted, environment, eventBytes, metadata, responses,
    success: positives.has(name), symlink: name === 'fixture_symlink_rejected',
    mutateFile: name === 'fixture_file_mutation_during_read'};
}

function createFakes(spec) {
  // Strip host constructor/prototype chains from every supplied callable and
  // record. This complements, not replaces, trusted source and process isolation.
  const hardened = new WeakSet();
  function seal(value) {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
    if (hardened.has(value)) return value;
    hardened.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) seal(descriptor.value);
      if (descriptor.get) seal(descriptor.get);
      if (descriptor.set) seal(descriptor.set);
    }
    Object.setPrototypeOf(value, null);
    return Object.freeze(value);
  }
  function syntheticError(name) {
    return seal(Object.assign(Object.create(null), {name, message: 'synthetic fixture error'}));
  }
  let now = 0;
  let tickSequence = 0;
  let timerId = 0;
  const events = [];
  const detailed = {requests: [], allocations: [], reads: [], fileReads: [], outputs: [],
    writes: [], requestTimers: [], destroyed: [], controls: [], faults: [], consumed: []};
  const files = new Map();
  const descriptors = new Map();
  const scheduled = [];
  const timers = new Map();
  const views = new WeakMap();
  const directory = '/synthetic/tmp/foobar-preview-transfer';
  let directoryCreated = false;
  let nextDescriptor = 70;
  function record(capability, operation, requested = null, returned = null, origin = 'subject', disposition = 'fake') {
    guard(Number.isFinite(now) && now >= 0);
    guard(operation.length > 0 && operation.length <= 128);
    for (const size of [requested, returned]) guard(size === null || (Number.isSafeInteger(size) && size >= 0));
    events.push({sequence: events.length + 1, origin, capability, operation, disposition,
      requested_bytes: requested, returned_bytes: returned, fake_time_ms: now});
  }
  function guard(condition) {
    if (!condition) { detailed.faults.push('fixture-contract'); throw syntheticError('HarnessFault'); }
  }
  function deny(operation, origin = 'subject') {
    record('forbidden', operation, null, null, origin, 'blocked');
    throw syntheticError('ForbiddenEffect');
  }
  function task(at, priority, call, kind) {
    scheduled.push({at, priority, call, kind, order: ++tickSequence, active: true});
    return scheduled[scheduled.length - 1];
  }
  function advance() {
    scheduled.sort((a, b) => a.at - b.at || a.priority - b.priority || a.order - b.order);
    const next = scheduled.find(entry => entry.active);
    if (!next) return false;
    next.active = false;
    guard(next.at >= now);
    now = next.at;
    record('clock', 'advance');
    next.call();
    return true;
  }
  function rawView(view) { guard(views.has(view)); return views.get(view); }
  function bytesAt(view, start = 0, length = rawView(view).length - start) {
    const state = rawView(view);
    guard(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= state.length);
    // Only bounded materialization in the fixture. Large capacity is sparse;
    // all source-requested allocation sizes remain visible in the ledger.
    guard(length <= CAP.file);
    const result = HostBuffer.alloc(length);
    for (const segment of state.segments) {
      const left = Math.max(start, segment.offset);
      const right = Math.min(start + length, segment.offset + segment.bytes.length);
      if (left < right) segment.bytes.copy(result, left - start, left - segment.offset, right - segment.offset);
    }
    return result;
  }
  function makeView(length, segments = []) {
    guard(Number.isSafeInteger(length) && length >= 0 && length <= CAP.aggregate);
    const object = Object.create(null);
    views.set(object, {length, segments});
    Object.defineProperties(object, {
      length: {enumerable: true, get() { record('buffer', 'length', null, length); return length; }},
      subarray: {value(start = 0, end = length) {
        guard(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= length);
        record('buffer', 'subarray', end - start, end - start);
        const selection = [];
        for (const segment of rawView(object).segments) {
          const left = Math.max(start, segment.offset);
          const right = Math.min(end, segment.offset + segment.bytes.length);
          if (left < right) selection.push({offset: left - start, bytes: segment.bytes.subarray(left - segment.offset, right - segment.offset)});
        }
        return makeView(end - start, selection);
      }},
      copy: {value(destination, offset = 0) {
        const target = rawView(destination);
        guard(Number.isSafeInteger(offset) && offset >= 0 && offset + length <= target.length);
        const bytes = bytesAt(object);
        target.segments.push({offset, bytes});
        record('buffer', 'copy', length, length);
        return length;
      }}
    });
    return seal(object);
  }
  const fromNative = bytes => makeView(bytes.length, [{offset: 0, bytes: HostBuffer.from(bytes)}]);
  const fakeBuffer = seal({
    alloc(size) {
      guard(Number.isSafeInteger(size) && size >= 0 && size <= CAP.aggregate);
      detailed.allocations.push({size, request: detailed.requests.length ? detailed.requests.length - 1 : null});
      record('buffer', 'alloc', size, size);
      return makeView(size);
    },
    from(value, encoding) {
      guard(typeof value === 'string' && (encoding === undefined || encoding === 'base64url'));
      guard(HostBuffer.byteLength(value) <= CAP.file);
      const bytes = HostBuffer.from(value, encoding);
      guard(bytes.length <= CAP.file);
      record('buffer', encoding === 'base64url' ? 'from.base64url' : 'from.utf8', HostBuffer.byteLength(value), bytes.length);
      return fromNative(bytes);
    },
    byteLength(value) {
      guard(typeof value === 'string');
      const size = HostBuffer.byteLength(value);
      record('buffer', 'byteLength', size, size);
      return size;
    },
    isBuffer(value) { record('buffer', 'isBuffer'); return views.has(value); }
  });
  const fakePath = seal({join(...parts) {
    guard(parts.every(p => typeof p === 'string'));
    record('path', 'join');
    const joined = hostPath.posix.join(...parts);
    guard(joined === directory || joined.startsWith(directory + '/'));
    return joined;
  }});
  const fakeFS = seal({
    constants: seal({O_RDONLY: 0, O_NOFOLLOW: 131072}),
    openSync(filename, flags) {
      record('fs', 'openSync');
      guard(filename === spec.environment.GITHUB_EVENT_PATH && flags === 131072);
      if (spec.symlink) throw syntheticError('ELOOP');
      const fd = nextDescriptor++;
      descriptors.set(fd, {reads: 0, stats: 0});
      return fd;
    },
    fstatSync(descriptor) {
      record('fs', 'fstatSync');
      guard(descriptors.has(descriptor));
      const state = descriptors.get(descriptor);
      state.stats += 1;
      const changed = spec.mutateFile && state.stats > 1;
      return seal({dev: 8, ino: changed ? 72 : 71, size: spec.eventBytes.length,
        mtimeMs: changed ? 2 : 1, ctimeMs: changed ? 2 : 1, isFile() { record('fs', 'stat.isFile'); return true; }});
    },
    readSync(descriptor, buffer, offset, size, position) {
      guard(descriptors.has(descriptor));
      guard(Number.isSafeInteger(size) && size > 0 && size <= CAP.pull);
      guard(position === offset && position >= 0 && offset + size <= rawView(buffer).length);
      const returned = Math.min(size, spec.eventBytes.length - position);
      guard(returned >= 0);
      rawView(buffer).segments.push({offset, bytes: HostBuffer.from(spec.eventBytes.subarray(position, position + returned))});
      descriptors.get(descriptor).reads += 1;
      detailed.fileReads.push({requested: size, returned, position});
      record('fs', 'readSync', size, returned);
      return returned;
    },
    closeSync(descriptor) {
      record('fs', 'closeSync');
      guard(descriptors.delete(descriptor));
    },
    mkdirSync(filename, options) {
      record('fs', 'mkdirSync');
      guard(filename === directory && !directoryCreated && options.mode === 0o700);
      directoryCreated = true;
    },
    writeFileSync(filename, data, options) {
      guard(directoryCreated && filename.startsWith(directory + '/') && !filename.slice(directory.length + 1).includes('/'));
      guard(options.mode === 0o600 && options.flag === 'wx' && !files.has(filename));
      if (typeof data === 'string') guard(HostBuffer.byteLength(data) <= CAP.file);
      const bytes = typeof data === 'string' ? HostBuffer.from(data) : bytesAt(data);
      guard(bytes.length <= CAP.file);
      files.set(filename, HostBuffer.from(bytes));
      detailed.writes.push({filename, bytes: HostBuffer.from(bytes)});
      record('fs', 'writeFileSync', bytes.length, bytes.length);
    },
    renameSync(from, to) {
      record('fs', 'renameSync');
      guard(from === directory + '/transfer.pending' && to === directory + '/transfer.json' && files.has(from));
      files.set(to, files.get(from));
      files.delete(from);
    }
  });
  const fakeCrypto = seal({createHash(algorithm) {
    guard(algorithm === 'sha256');
    record('crypto', 'createHash.sha256');
    const hasher = hostCrypto.createHash('sha256');
    let complete = false;
    const wrapped = seal({update(view) {
      guard(!complete);
      const bytes = bytesAt(view);
      hasher.update(bytes);
      record('crypto', 'hash.update', bytes.length, bytes.length);
      return wrapped;
    }, digest(encoding) {
      guard(!complete && encoding === 'hex');
      complete = true;
      record('crypto', 'hash.digest.hex', null, 64);
      return hasher.digest('hex');
    }});
    return wrapped;
  }});
  const fakeUtil = seal({TextDecoder: class {
    constructor(encoding, options) {
      guard(encoding === 'utf-8' && options.fatal === true);
      record('util', 'TextDecoder.construct');
    }
    decode(view) {
      const bytes = bytesAt(view);
      record('util', 'TextDecoder.decode', bytes.length, bytes.length);
      try { return new HostTextDecoder('utf-8', {fatal: true}).decode(bytes); }
      catch (_) { throw syntheticError('TypeError'); }
    }
  }});
  function emitter() {
    const listeners = new Map();
    return {on(name, callback) {
      guard(typeof callback === 'function');
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    }, emit(name) {
      for (const callback of listeners.get(name) || []) callback();
    }};
  }
  const fakeHTTPS = seal({request(url, options, callback) {
    const index = detailed.requests.length;
    const response = spec.responses[index];
    guard(response !== undefined && String(url) === response.url && options.method === response.method);
    const headers = clone(options.headers);
    guard(headers['Accept-Encoding'] === 'identity');
    guard(headers['User-Agent'] === 'AlbumHaven-preview-evidence-v1');
    const authenticated = response.role === 'list' || response.role === 'signed';
    if (authenticated) guard(headers.Authorization === 'Bearer ' + SYNTHETIC_TOKEN);
    else guard(!Object.hasOwn(headers, 'Authorization'));
    const requestDetail = {index, role: response.role, owner: response.owner, url: String(url),
      method: options.method, headers, body: null, started: now, completed: null,
      consumed: 0, responseDestroyed: false, requestDestroyed: false};
    detailed.requests.push(requestDetail);
    record('https', 'request.' + response.role);
    const requestEvents = emitter();
    let requestDestroyed = false;
    const request = seal({on(name, listener) {
      guard(name === 'error'); record('https', 'request.on.error'); requestEvents.on(name, listener); return request;
    }, end(body) {
      record('https', 'request.end', body === null ? 0 : HostBuffer.byteLength(body), 0);
      requestDetail.body = body;
      if (authenticated) {
        guard(typeof body === 'string');
        guard(JSON.stringify(JSON.parse(body)) === JSON.stringify(response.requestBody));
        guard(headers['Content-Type'] === 'application/json' && headers['Content-Length'] === String(HostBuffer.byteLength(body)));
      } else guard(body === null);
      task(now + response.delay, 1, () => {
        if (requestDestroyed) return;
        if (response.requestFailure) {
          record('https', 'request.error.synthetic-cancellation');
          requestEvents.emit('error');
          return;
        }
        const streamEvents = emitter();
        let offset = 0;
        let destroyed = false;
        const stream = Object.create(null);
        Object.defineProperties(stream, {
          statusCode: {value: response.status},
          headers: {value: seal({...response.headers})},
          complete: {get() { record('https', 'stream.complete'); return !response.incomplete; }},
          readableLength: {get() { const remaining = response.body.length - offset;
            record('https', 'stream.readableLength', null, remaining); return remaining; }},
          on: {value(name, listener) {
            guard(['readable', 'end', 'error', 'aborted'].includes(name));
            record('https', 'stream.on.' + name); streamEvents.on(name, listener); return stream;
          }},
          read: {value(size) {
            guard(Number.isSafeInteger(size) && size > 0 && size <= CAP.pull && !destroyed);
            const count = Math.min(size, response.body.length - offset);
            detailed.reads.push({request: index, requested: size, returned: count});
            record('https', 'stream.read', size, count);
            if (count === 0) return null;
            const result = fromNative(response.body.subarray(offset, offset + count));
            offset += count;
            requestDetail.consumed += count;
            return result;
          }},
          destroy: {value() { destroyed = true; requestDetail.responseDestroyed = true;
            detailed.destroyed.push('stream'); record('https', 'stream.destroy'); }}
        });
        seal(stream);
        record('https', 'response.' + response.role);
        callback(stream);
        if (destroyed || requestDestroyed) return;
        if (response.streamFailure) {
          record('https', 'stream.emit.' + response.streamFailure);
          streamEvents.emit(response.streamFailure);
          return;
        }
        record('https', 'stream.emit.readable');
        streamEvents.emit('readable');
        if (destroyed || requestDestroyed) return;
        record('https', 'stream.emit.end');
        requestDetail.completed = now;
        streamEvents.emit('end');
      }, 'response');
    }, destroy() {
      requestDestroyed = true;
      requestDetail.requestDestroyed = true;
      detailed.destroyed.push('request');
      record('https', 'request.destroy');
    }});
    return request;
  }});
  const moduleMap = seal({'node:fs': fakeFS, 'node:path': fakePath,
    'node:https': fakeHTTPS, 'node:crypto': fakeCrypto, 'node:util': fakeUtil});
  function fakeRequire(name, origin = 'subject') {
    if (!Object.hasOwn(moduleMap, name)) return deny('require.' + String(name), origin);
    record(name.slice(5) === 'https' ? 'https' : name.slice(5), 'require');
    return moduleMap[name];
  }
  function readEnvironment(key, origin = 'subject') {
    if (typeof key !== 'string') return deny('environment.symbol', origin);
    record('environment', 'read.' + key, null, null, origin);
    return Object.hasOwn(spec.environment, key) ? spec.environment[key] : undefined;
  }
  const environment = new Proxy(Object.create(null), {
    get(_target, key) { return readEnvironment(key); }, set() { return deny('environment.write'); },
    ownKeys() { return deny('environment.enumerate'); }
  });
  const fakeProcess = new Proxy(Object.create(null), {
    get(_target, key) { if (key === 'env') return environment; return deny('process.' + String(key)); },
    set() { return deny('process.write'); }
  });
  const fakePerformance = seal({now() { record('clock', 'performance.now'); return now; }});
  class FakeDate {
    constructor(...args) { guard(args.length === 0); this.value = now; record('clock', 'Date.construct'); }
    toISOString() { record('clock', 'Date.toISOString'); return new Date(BASE_TIME + this.value).toISOString(); }
    static now() { record('clock', 'Date.now'); return BASE_TIME + now; }
  }
  class FakeURL {
    constructor(value, base) {
      guard(typeof value === 'string' && (base === undefined || typeof base === 'string'));
      record('util', 'URL.construct');
      let parsed;
      try { parsed = new URL(value, base); } catch (_) { throw syntheticError('TypeError'); }
      for (const key of ['protocol', 'hostname', 'username', 'password', 'search', 'hash', 'origin', 'href']) {
        Object.defineProperty(this, key, {value: parsed[key], enumerable: true});
      }
      Object.defineProperty(this, 'toString', {value: () => { record('util', 'URL.toString'); return this.href; }});
      seal(this);
    }
  }
  const fakeCore = seal({setOutput(name, value) {
    record('core', 'setOutput');
    guard(name === 'transferred' && typeof value === 'string');
    detailed.outputs.push({name, value});
  }, info(value) { record('core', 'info'); detailed.outputs.push({name: 'info', value: String(value)}); },
  warning(value) { record('core', 'warning'); detailed.outputs.push({name: 'warning', value: String(value)}); },
  error(value) { record('core', 'error'); detailed.outputs.push({name: 'error', value: String(value)}); }});
  const sandbox = Object.create(null);
  Object.assign(sandbox, {require: name => fakeRequire(name), process: fakeProcess, Buffer: fakeBuffer,
    performance: fakePerformance, Date: FakeDate, URL: FakeURL, core: fakeCore,
    setTimeout(callback, duration) {
      guard(typeof callback === 'function' && Number.isFinite(duration) && duration > 0);
      const id = ++timerId;
      detailed.requestTimers.push({created: now, duration, due: now + duration});
      record('timer', 'setTimeout');
      // Lower priority value means timeout is delivered BEFORE same-time response.
      const entry = task(now + duration, 0, () => { timers.delete(id); record('timer', 'fire'); callback(); }, 'timer');
      timers.set(id, entry);
      return id;
    },
    clearTimeout(id) {
      record('timer', 'clearTimeout');
      if (timers.has(id)) { timers.get(id).active = false; timers.delete(id); }
    },
    fetch() { return deny('fetch'); },
    setInterval() { return deny('setInterval'); },
    setImmediate() { return deny('setImmediate'); },
    console: seal({log() { return deny('console.log'); }, error() { return deny('console.error'); }})
  });
  for (const [key, value] of Object.entries(sandbox)) {
    if (key !== 'process') seal(value);
  }
  // The fake process/environment proxies have null-prototype targets and no
  // readable constructor property. Their traps are never passed as objects.
  function selfControl() {
    if (spec.name === 'fixture_forbidden_effect_attempt_survives_catch') {
      try { deny('child_process.spawn', 'control'); } catch (error) { assert.equal(error.name, 'ForbiddenEffect'); }
      assert.equal(events.filter(event => event.disposition === 'blocked').length, 1);
    }
    if (spec.name === 'fixture_unlisted_module_denied') {
      try { fakeRequire('node:net', 'control'); } catch (error) { assert.equal(error.name, 'ForbiddenEffect'); }
      assert.equal(events.filter(event => event.disposition === 'blocked').length, 1);
    }
    if (spec.name === 'fixture_host_environment_not_exposed') {
      // Intentionally never look at host process.env, even to construct a test.
      assert.equal(readEnvironment('GITHUB_TOKEN', 'control'), undefined);
      assert.equal(Object.hasOwn(spec.environment, 'GITHUB_TOKEN'), false);
    }
  }
  function audit() {
    if (detailed.faults.length !== 0) throw new HarnessFault();
    assert.equal(descriptors.size, 0, 'fake descriptor must close on every path');
    assert.equal(timers.size, 0, 'request timer must not survive settlement');
    const blocked = events.filter(event => event.disposition === 'blocked');
    const controls = events.filter(event => event.origin === 'control');
    const expectedOperation = spec.name === 'fixture_forbidden_effect_attempt_survives_catch' ? 'child_process.spawn' :
      spec.name === 'fixture_unlisted_module_denied' ? 'require.node:net' : null;
    if (expectedOperation !== null) {
      assert.equal(blocked.length, 1);
      assert.equal(controls.length, 1);
      assert.equal(blocked[0].origin, 'control');
      assert.equal(blocked[0].capability, 'forbidden');
      assert.equal(blocked[0].operation, expectedOperation);
      assert.equal(blocked[0].requested_bytes, null);
      assert.equal(blocked[0].returned_bytes, null);
    } else {
      assert.deepEqual(blocked, [], 'caught subject effect remains a nonpass');
      if (spec.name === 'fixture_host_environment_not_exposed') {
        assert.equal(controls.length, 1);
        assert.equal(controls[0].operation, 'read.GITHUB_TOKEN');
        assert.equal(controls[0].capability, 'environment');
        assert.equal(controls[0].disposition, 'fake');
        assert.equal(controls[0].requested_bytes, null);
        assert.equal(controls[0].returned_bytes, null);
      } else assert.deepEqual(controls, []);
    }
    for (const [index, event] of events.entries()) assert.equal(event.sequence, index + 1);
    for (const pull of detailed.reads.concat(detailed.fileReads)) {
      assert.ok(pull.requested > 0 && pull.requested <= CAP.pull);
      assert.ok(pull.returned >= 0 && pull.returned <= pull.requested);
    }
    for (const timer of detailed.requestTimers) {
      assert.ok(timer.duration > 0 && timer.duration <= 10000);
      assert.ok(timer.due <= 110000);
    }
    for (const request of detailed.requests) {
      if (request.completed !== null) assert.ok(request.completed - request.started < 10000);
    }
  }
  return {sandbox, events, detailed, files, now: () => now, advance, selfControl, audit,
    timerCount: () => timers.size, pending: () => scheduled.filter(entry => entry.active).length,
    importDenied: () => deny('import.dynamic')};
}

function retained(fakes, name) {
  const bytes = fakes.files.get('/synthetic/tmp/foobar-preview-transfer/' + name);
  assert.ok(bytes, 'required retained synthetic file missing: ' + name);
  return bytes;
}
function retainedJSON(fakes, name) { return JSON.parse(utf8(retained(fakes, name))); }
function assertNoSecrets(fakes) {
  const prohibited = [SYNTHETIC_TOKEN, 'Bearer ', SYNTHETIC_QUERY, 'SYNTHETIC_NOT_A_SIGNED_CREDENTIAL'];
  const retainedBytes = [...fakes.files.values(), ...fakes.detailed.writes.map(write => write.bytes),
    HostBuffer.from(JSON.stringify(fakes.detailed.outputs)), HostBuffer.from(JSON.stringify(fakes.events))];
  for (const bytes of retainedBytes) {
    for (const secret of prohibited) assert.equal(bytes.includes(HostBuffer.from(secret)), false, 'secret-bearing retained byte');
  }
}
function assertRequestProtocol(spec, fakes) {
  const requests = fakes.detailed.requests;
  assert.ok(requests.length <= spec.responses.length);
  // Exact prefix and exact count assertions disallow retry, pagination, redirect,
  // fallback origin/credential and requests after a rejected transaction.
  for (const [index, request] of requests.entries()) {
    const expected = spec.responses[index];
    assert.equal(request.url, expected.url);
    assert.equal(request.method, expected.method);
    if (expected.role === 'metadata' || expected.role === 'blob') {
      assert.equal(Object.hasOwn(request.headers, 'Authorization'), false);
    } else assert.equal(request.headers.Authorization, 'Bearer ' + SYNTHETIC_TOKEN);
    assert.equal(request.headers['Accept-Encoding'], 'identity');
    assert.ok(request.consumed <= (expected.role === 'metadata' ? CAP.metadata :
      expected.role === 'blob' ? spec.artifacts.find(a => a.owner === expected.owner).size : CAP.rpc));
  }
  for (const allocation of fakes.detailed.allocations) {
    if (allocation.request === null) assert.equal(allocation.size, spec.eventBytes.length);
    else {
      const response = spec.responses[allocation.request];
      const independentlyExpectedCapacity = response.role === 'metadata' ? CAP.metadata :
        response.role === 'blob' ? spec.artifacts.find(a => a.owner === response.owner).size : CAP.rpc;
      assert.equal(allocation.size, independentlyExpectedCapacity, 'original request capacity must not change');
    }
  }
  assertNoSecrets(fakes);
}
function assertSuccess(spec, fakes) {
  const included = spec.artifacts.filter(artifact => spec.trusted[artifact.owner].artifact_id !== '');
  assert.equal(fakes.detailed.requests.length, 2 + included.length * 3);
  assert.deepEqual(fakes.detailed.outputs, [{name: 'transferred', value: String(included.length)}]);
  const transfer = retainedJSON(fakes, 'transfer.json');
  const expectedTransfer = {schema_version: 'foobar-preview-transfer-v1', repository: 'idanilovqa/AlbumHaven',
    head_sha: HEAD, workflow_path: WORKFLOW, run_id: RUN, run_attempt: ATTEMPT, cancelled: false,
    provenance: included.map(artifact => ({producer_job: artifact.owner, artifact_name: artifact.name,
      artifact_id: artifact.id, repository: 'idanilovqa/AlbumHaven', head_sha: HEAD,
      workflow_path: WORKFLOW, run_id: RUN, run_attempt: ATTEMPT})),
    archives: included.map(artifact => ({producer_job: artifact.owner, path: artifact.owner + '.zip',
      size: artifact.bytes.length, sha256: hash(artifact.bytes)}))};
  assert.deepEqual(transfer, expectedTransfer);
  assert.deepEqual(retained(fakes, 'transfer.json'), jsonBytes(expectedTransfer));
  for (const artifact of included) {
    assert.deepEqual(retained(fakes, artifact.owner + '.zip'), artifact.bytes);
    assert.equal(hash(retained(fakes, artifact.owner + '.zip')), artifact.digest);
  }
  const acquisition = retainedJSON(fakes, 'acquisition.json');
  const expectedAcquisition = {schema_version: 'foobar-preview-acquisition-v1',
    repository: 'idanilovqa/AlbumHaven', head_sha: HEAD, workflow_path: WORKFLOW,
    run_id: RUN, run_attempt: ATTEMPT, consumer_job: spec.consumer,
    responses: spec.metadata.map((metadata, index) => {
      const start = spec.responses.slice(0, index).reduce((sum, response) => sum + response.delay, 0);
      const finish = start + spec.responses[index].delay;
      return {kind: metadata.kind, url: metadata.url, status: 200,
        started_at: new Date(BASE_TIME + start).toISOString(), finished_at: new Date(BASE_TIME + finish).toISOString(),
        size: metadata.bytes.length, sha256: hash(metadata.bytes), path: metadata.path};
    })};
  assert.deepEqual(acquisition, expectedAcquisition);
  assert.deepEqual(retained(fakes, 'acquisition.json'), jsonBytes(expectedAcquisition));
  for (const metadata of spec.metadata) assert.deepEqual(retained(fakes, metadata.path), metadata.bytes);
  assert.deepEqual([...fakes.files.keys()].map(path => path.split('/').at(-1)).sort(),
    ['run-attempt.json', 'attempt-jobs.json', 'acquisition.json', 'transfer.json', ...included.map(a => a.owner + '.zip')].sort());
  const total = spec.metadata.reduce((sum, m) => sum + m.bytes.length, 0) +
    jsonBytes(expectedAcquisition).length + 32768 + included.reduce((sum, a) => sum + a.bytes.length, 0);
  assert.ok(total <= CAP.aggregate);
  assert.ok(fakes.now() < 110000);
}

/* Each case has an explicit independent mutation and assertion of the named
 * effect. Negative verdicts are never accepted solely because something threw. */
function assertNamedOracle(spec, fakes, outcome) {
  const requests = fakes.detailed.requests;
  const allocations = fakes.detailed.allocations;
  const first = requests[0];
  const blobIndex = spec.responses.findIndex(response => response.role === 'blob');
  function count(expected) { assert.equal(requests.length, expected, 'exact rejected request prefix'); }
  function noArchive() {
    assert.equal([...fakes.files.keys()].some(path => path.endsWith('.zip')), false);
    assert.deepEqual(fakes.detailed.outputs, []);
  }
  function responseUnread(index) { assert.equal(requests[index].consumed, 0); }
  function noAllocationFor(index) { assert.equal(allocations.some(a => a.request === index), false); }
  function readLimit(index, maximum) { assert.ok(requests[index].consumed <= maximum); }
  switch (spec.name) {
    case 'positive_helper_exact_artifact':
      assert.deepEqual(retainedJSON(fakes, 'transfer.json').archives.map(a => a.producer_job), ['admission']);
      assert.equal(retainedJSON(fakes, 'transfer.json').provenance[0].artifact_id, 401);
      break;
    case 'positive_reconcile_complete_chain':
      assert.deepEqual(retainedJSON(fakes, 'transfer.json').archives.map(a => a.producer_job), OWNERS);
      count(23);
      break;
    case 'two_anonymous_metadata_requests':
      assert.deepEqual(requests.filter(r => r.role === 'metadata').map(r => r.url), spec.metadata.map(m => m.url));
      assert.deepEqual(requests.slice(0, 2).map(r => r.role), ['metadata', 'metadata']);
      break;
    case 'raw_acquisition_bytes_and_digests':
      for (const item of spec.metadata) {
        assert.deepEqual(retained(fakes, item.path), item.bytes);
        assert.equal(retainedJSON(fakes, 'acquisition.json').responses.find(r => r.kind === item.kind).sha256, hash(item.bytes));
      }
      break;
    case 'public_api_and_blob_no_authorization':
      assert.equal(requests.filter(r => r.role === 'metadata' || r.role === 'blob').length, 3);
      for (const request of requests.filter(r => r.role === 'metadata' || r.role === 'blob')) assert.equal('Authorization' in request.headers, false);
      break;
    case 'artifact_service_only_synthetic_token':
      assert.equal(requests.filter(r => 'Authorization' in r.headers).length, 2);
      for (const request of requests.filter(r => 'Authorization' in r.headers)) {
        assert.ok(['list', 'signed'].includes(request.role));
        assert.equal(request.headers.Authorization, 'Bearer ' + SYNTHETIC_TOKEN);
        assert.equal(new URL(request.url).origin, 'https://synthetic.actions.githubusercontent.com');
      }
      break;
    case 'metadata_non200':
    case 'metadata_link_header':
    case 'metadata_location_header':
    case 'redirect_no_follow':
    case 'compressed_response':
    case 'no_retry_or_credential_fallback':
      count(1); responseUnread(0); noAllocationFor(0); noArchive();
      assert.equal(first.requestDestroyed, true);
      assert.equal(first.responseDestroyed, true);
      break;
    case 'artifact_service_non200':
      count(3); responseUnread(2); noAllocationFor(2); noArchive();
      break;
    case 'blob_non200':
      count(5); responseUnread(blobIndex); noAllocationFor(blobIndex); noArchive();
      break;
    case 'stream_error':
    case 'stream_aborted':
      count(1); responseUnread(0); noArchive();
      assert.equal(first.responseDestroyed, true);
      assert.ok(fakes.events.some(e => e.operation === 'stream.emit.' + spec.responses[0].streamFailure));
      break;
    case 'incomplete_stream':
      count(1); noArchive(); assert.equal(first.consumed, spec.metadata[0].bytes.length);
      assert.equal(first.responseDestroyed, true);
      break;
    case 'request_timeout':
    case 'request_deadline_at_10_seconds':
    case 'request_deadline_over_10_seconds':
      count(1); responseUnread(0); noAllocationFor(0); noArchive();
      assert.equal(fakes.now(), 10000);
      assert.equal(fakes.detailed.requestTimers[0].due, 10000);
      assert.equal(first.requestDestroyed, true);
      assert.equal(fakes.events.some(e => e.operation === 'response.metadata'), false);
      break;
    case 'cancellation':
      count(1); responseUnread(0); noArchive();
      assert.equal(first.requestDestroyed, true);
      assert.ok(fakes.events.some(e => e.operation === 'request.error.synthetic-cancellation'));
      break;
    case 'shared_deadline_not_reset':
      count(22);
      assert.equal(fakes.now(), 110000);
      assert.equal(requests.at(-1).started, 105000);
      assert.equal(fakes.detailed.requestTimers.at(-1).duration, 5000);
      assert.equal(requests.at(-1).requestDestroyed, true);
      assert.deepEqual(fakes.detailed.outputs, []);
      assert.equal(retainedJSON(fakes, 'transfer.json').archives.length, 6);
      break;
    case 'shared_deadline_before_110_seconds':
      count(23); assert.equal(fakes.now(), 109999);
      assert.ok(requests.every(r => r.completed - r.started < 10000));
      break;
    case 'shared_deadline_at_110_seconds':
      count(23); assert.equal(fakes.now(), 110000);
      assert.equal(requests.at(-1).completed, null);
      assert.equal(requests.at(-1).requestDestroyed, true);
      assert.deepEqual(fakes.detailed.outputs, []);
      assert.equal(retainedJSON(fakes, 'transfer.json').archives.length, 6);
      break;
    case 'metadata_declared_exact_limit':
      assert.equal(spec.responses[0].headers['content-length'], String(CAP.metadata));
      assert.equal(retained(fakes, 'run-attempt.json').length, CAP.metadata);
      assert.equal(first.consumed, CAP.metadata);
      break;
    case 'metadata_declared_over_limit':
      count(1); responseUnread(0); noAllocationFor(0); noArchive();
      assert.equal(spec.responses[0].headers['content-length'], String(CAP.metadata + 1));
      break;
    case 'metadata_chunked_over_limit':
      count(1); noArchive();
      assert.equal(spec.responses[0].body.length, CAP.metadata + 1);
      assert.equal('content-length' in spec.responses[0].headers, false);
      assert.equal(first.consumed, CAP.metadata);
      assert.ok(fakes.events.some(e => e.operation === 'stream.readableLength' && e.returned_bytes === 1));
      assert.equal(fakes.files.has('/synthetic/tmp/foobar-preview-transfer/run-attempt.json'), false);
      break;
    case 'metadata_aggregate_exact_limit':
      assert.equal(spec.metadata.reduce((sum, m) => sum + m.bytes.length, 0), CAP.metadataTotal);
      assert.equal(requests[0].consumed + requests[1].consumed, CAP.metadataTotal);
      break;
    case 'metadata_aggregate_over_limit':
      // EXACT reachability limitation: there are only two requests, each <=1MiB.
      // Their accepted sum cannot exceed 2MiB. The attempted candidate is 2MiB+1,
      // honestly rejected by the second response's 1MiB declaration guard BEFORE
      // reading the excess. This does NOT claim aggregate-only branch coverage.
      assert.equal(spec.metadata.reduce((sum, m) => sum + m.bytes.length, 0), CAP.metadataTotal + 1);
      count(2); assert.equal(first.consumed, CAP.metadata); responseUnread(1); noAllocationFor(1); noArchive();
      assert.equal(fakes.files.has('/synthetic/tmp/foobar-preview-transfer/attempt-jobs.json'), false);
      break;
    case 'blob_declared_over_capacity':
      count(5); responseUnread(blobIndex); noAllocationFor(blobIndex); noArchive();
      assert.equal(spec.responses[blobIndex].headers['content-length'], String(spec.artifacts[0].size + 1));
      break;
    case 'blob_chunked_over_capacity':
    case 'actual_length_long':
      count(5); noArchive();
      assert.equal(spec.responses[blobIndex].body.length, spec.artifacts[0].size + 1);
      assert.equal(requests[blobIndex].consumed, spec.artifacts[0].size);
      assert.ok(fakes.events.some(e => e.operation === 'stream.readableLength' && e.returned_bytes === 1));
      break;
    case 'actual_length_short':
      count(5); noArchive();
      assert.equal(requests[blobIndex].consumed, spec.artifacts[0].size - 1);
      assert.equal(requests[blobIndex].responseDestroyed, true);
      break;
    case 'invalid_utf8':
    case 'nonfinite_exponent_positive':
    case 'nonfinite_exponent_negative':
    case 'nonfinite_literal':
      count(3); noArchive();
      assert.equal(requests[2].consumed, spec.responses[2].body.length);
      assert.ok(fakes.events.some(e => e.operation === 'TextDecoder.decode'));
      // UTF-8/nonfinite fixtures retain the complete valid artifact record;
      // replacement decoding or missing numeric checks must not be masked by a
      // later missing/invalid artifacts-field rejection.
      assert.ok(spec.responses[2].body.includes(HostBuffer.from('"artifacts":[{')));
      break;
    case 'wrong_artifact_owner':
      // Owner authority at this seam is producer encoded in exact artifact.name.
      // A different valid backend job UUID is NOT claimed to be rejected here.
      assert.equal(JSON.parse(utf8(spec.responses[2].body)).artifacts[0].name, artifactName('helper'));
      count(3); noArchive();
      break;
    case 'wrong_artifact_name':
    case 'wrong_artifact_run':
    case 'wrong_artifact_id':
    case 'wrong_artifact_digest':
      count(3); noArchive();
      break;
    case 'duplicate_artifact_ids':
      count(5);
      assert.equal(spec.trusted.helper.artifact_id, spec.trusted.admission.artifact_id);
      assert.equal(retainedJSON(fakes, 'transfer.json').archives.length, 1);
      assert.deepEqual(fakes.detailed.outputs, []);
      assert.equal(requests.filter(r => r.role === 'list').length, 1);
      break;
    case 'unsupported_signed_host':
      count(4); noArchive(); assert.equal(requests.some(r => r.role === 'blob'), false);
      break;
    case 'request_pull_64k_bound':
      assert.ok(fakes.detailed.reads.some(read => read.requested === CAP.pull));
      assert.ok(fakes.detailed.reads.length > 2);
      for (const read of fakes.detailed.reads) assert.ok(read.requested <= CAP.pull && read.returned <= read.requested);
      break;
    case 'buffer_capacity_bound':
      assert.deepEqual(allocations.map(a => a.size), [spec.eventBytes.length, CAP.metadata,
        CAP.metadata, CAP.rpc, CAP.rpc, spec.artifacts[0].size]);
      break;
    case 'fixture_file_read_64k_bound':
      assert.deepEqual(fakes.detailed.fileReads.map(read => read.requested), [65536, 65536, 17]);
      assert.equal(fakes.detailed.fileReads.reduce((sum, read) => sum + read.returned, 0), 131089);
      break;
    case 'fixture_file_mutation_during_read':
      count(0); noArchive();
      assert.equal(fakes.events.filter(e => e.operation === 'fstatSync').length, 2);
      assert.equal(fakes.events.filter(e => e.operation === 'closeSync').length, 1);
      assert.equal(fakes.detailed.fileReads.reduce((sum, read) => sum + read.returned, 0), spec.eventBytes.length);
      break;
    case 'fixture_symlink_rejected':
      count(0); noArchive();
      assert.equal(fakes.events.filter(e => e.operation === 'openSync').length, 1);
      assert.equal(fakes.detailed.fileReads.length, 0);
      assert.equal(allocations.length, 0);
      break;
    case 'archive_aggregate_over_limit':
      // EXACT reachability limitation: seven finite producer slots times 256MiB
      // plus <=2MiB metadata, <=16KiB acquisition and 32KiB reserve is <2GiB.
      // A 2GiB+1 declared candidate violates BOTH the per-item and aggregate caps;
      // rejection is correctly proved at the earlier per-item guard, with no
      // signed-URL/blob request or enormous buffer. No aggregate branch claim.
      assert.ok(OWNERS.length * CAP.artifact + CAP.metadataTotal + 16384 + 32768 < CAP.aggregate);
      assert.equal(JSON.parse(utf8(spec.responses[2].body)).artifacts[0].size, String(CAP.aggregate + 1));
      count(3); noArchive();
      assert.equal(requests.some(r => r.role === 'signed' || r.role === 'blob'), false);
      assert.ok(allocations.every(a => a.size <= CAP.metadata));
      break;
    case 'retained_outputs_no_bearer':
    case 'retained_outputs_no_signed_url':
      assertNoSecrets(fakes);
      assert.ok(fakes.files.size > 0 && fakes.detailed.outputs.length > 0);
      break;
    case 'missing_upload_outputs_reconcile_explicit_absence':
      assert.equal(spec.trusted.resource_2.artifact_id, '');
      assert.equal(spec.trusted.resource_2.sha256, '');
      assert.deepEqual(retainedJSON(fakes, 'transfer.json').archives.map(a => a.producer_job), OWNERS.filter(o => o !== 'resource_2'));
      assert.equal(fakes.files.has('/synthetic/tmp/foobar-preview-transfer/resource_2.zip'), false);
      assert.equal(requests.some(r => r.owner === 'resource_2'), false);
      count(20);
      break;
    case 'missing_upload_outputs_producer_holds':
    case 'partial_upload_identity_rejected':
      count(2); noArchive();
      assert.deepEqual(retainedJSON(fakes, 'transfer.json').archives, []);
      assert.deepEqual(retainedJSON(fakes, 'transfer.json').provenance, []);
      break;
    case 'fixture_forbidden_effect_attempt_survives_catch':
    case 'fixture_unlisted_module_denied':
      assert.equal(fakes.events.filter(e => e.disposition === 'blocked').length, 1);
      break;
    case 'fixture_host_environment_not_exposed':
      assert.equal(Object.hasOwn(spec.environment, 'GITHUB_TOKEN'), false);
      assert.equal(fakes.events.filter(e => e.origin === 'control' && e.operation === 'read.GITHUB_TOKEN').length, 1);
      break;
    default: throw new HarnessFault();
  }
  assert.equal(outcome.status, spec.success ? 'resolved' : 'rejected');
  if (!spec.success) {
    assert.equal(outcome.error.message, 'Preview artifact transfer failed closed; no evidence acceptance is available');
    assert.deepEqual(fakes.detailed.outputs, [], 'rejection cannot signal continuation');
  }
  for (let index = 0; index < requests.length; index += 1) {
    const response = spec.responses[index];
    readLimit(index, response.role === 'metadata' ? CAP.metadata : response.role === 'blob' ?
      spec.artifacts.find(a => a.owner === response.owner).size : CAP.rpc);
  }
}

async function evaluateExactLiteral(literal, fakes) {
  const context = hostVM.createContext(fakes.sandbox, {
    name: 'foobar-preview-transfer-fakes-v1', codeGeneration: {strings: false, wasm: false}
  });
  // The literal bytes are unchanged inside an async wrapper solely to provide
  // the top-level await capability of the production github-script action.
  const script = new hostVM.Script('"use strict"; (async function () {\n' + literal + '\n}).call(undefined);', {
    filename: 'verified-preview-transfer-literal.js',
    importModuleDynamically: () => fakes.importDenied()
  });
  const outcome = {status: 'pending', error: null};
  let promise;
  try { promise = script.runInContext(context, {timeout: 1000}); }
  catch (_) { throw new HarnessFault(); }
  Promise.resolve(promise).then(() => { outcome.status = 'resolved'; },
    error => { outcome.status = 'rejected'; outcome.error = error; });
  // A finite synthetic queue, no host timer, sleeping, network or child process.
  // Drain promise continuations before selecting the next fake-time event.
  for (let dispatches = 0; dispatches < 256; dispatches += 1) {
    for (let drain = 0; drain < 16; drain += 1) await Promise.resolve();
    if (outcome.status !== 'pending') return outcome;
    if (!fakes.advance()) throw new HarnessFault();
  }
  throw new HarnessFault();
}

async function executeVariant(name, literal, nonfiniteLiteral) {
  let spec;
  let fakes;
  try { spec = fixture(name, nonfiniteLiteral); fakes = createFakes(spec); }
  catch (_) { return {status: 'error', error_code: 'harness', ledger: []}; }
  let problem = null;
  try {
    fakes.selfControl();
    const outcome = await evaluateExactLiteral(literal, fakes);
    assert.equal(outcome.status, spec.success ? 'resolved' : 'rejected');
    assertRequestProtocol(spec, fakes);
    if (spec.success) assertSuccess(spec, fakes);
    assertNamedOracle(spec, fakes, outcome);
  } catch (error) { problem = error; }
  // Kept OUTSIDE subject and initial assertion capture. A caught forbidden
  // capability, timer leak or fake contract fault cannot disappear on rejection.
  try { fakes.audit(); }
  catch (error) { problem = error instanceof assert.AssertionError ? error : new HarnessFault(); }
  return {status: problem === null ? 'passed' : problem instanceof assert.AssertionError ? 'failed' : 'error',
    error_code: problem === null ? null : problem instanceof assert.AssertionError ? 'assertion' : 'harness',
    ledger: fakes.events};
}

async function executeCase(name, literal) {
  // One fixed case has three explicit literal-token variants. All three run;
  // none can be skipped or hidden behind another variant's passing verdict.
  const variants = name === 'nonfinite_literal' ? ['NaN', 'Infinity', '-Infinity'] : [undefined];
  const results = [];
  const ledger = [];
  for (const variant of variants) {
    const result = await executeVariant(name, literal, variant);
    results.push(result);
    for (const event of result.ledger) ledger.push({...event, sequence: ledger.length + 1});
  }
  assert.equal(results.length, variants.length);
  const status = results.some(result => result.status === 'error') ? 'error' :
    results.some(result => result.status === 'failed') ? 'failed' : 'passed';
  return {status, error_code: status === 'error' ? 'harness' : status === 'failed' ? 'assertion' : null, ledger};
}

function createProofWriter(evidence) {
  assert.ok(hostFS.lstatSync(evidence).isDirectory() && !hostFS.lstatSync(evidence).isSymbolicLink());
  const node = hostPath.join(evidence, 'node');
  let nodeExists = false;
  try { const stat = hostFS.lstatSync(node); assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); nodeExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!nodeExists) hostFS.mkdirSync(node, {mode: 0o700});
  function writeNew(relative, value) {
    const parts = relative.split('/');
    assert.ok(parts.every(part => part && part !== '..' && part !== '.' && !part.includes('\\') && !part.includes(':')));
    const filename = hostPath.join(node, relative);
    const bytes = jsonBytes(value);
    assert.ok(bytes.length <= CAP.file);
    const fd = hostFS.openSync(filename, hostFS.constants.O_WRONLY | hostFS.constants.O_CREAT |
      hostFS.constants.O_EXCL | hostFS.constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const wrote = hostFS.writeSync(fd, bytes, offset, Math.min(CAP.pull, bytes.length - offset), offset);
        assert.ok(wrote > 0); offset += wrote;
      }
      hostFS.fsyncSync(fd);
    } finally { hostFS.closeSync(fd); }
  }
  let runtimeDescriptor = null;
  let runtimeIdentity = null;
  function beginRuntime(value) {
    assert.equal(runtimeDescriptor, null);
    runtimeDescriptor = hostFS.openSync(hostPath.join(node, 'runtime.json'), hostFS.constants.O_RDWR |
      hostFS.constants.O_CREAT | hostFS.constants.O_EXCL | hostFS.constants.O_NOFOLLOW, 0o600);
    runtimeIdentity = hostFS.fstatSync(runtimeDescriptor);
    updateRuntime(value);
    hostFS.mkdirSync(hostPath.join(node, 'ledgers'), {mode: 0o700});
  }
  function updateRuntime(value) {
    assert.notEqual(runtimeDescriptor, null);
    const current = hostFS.fstatSync(runtimeDescriptor);
    assert.ok(current.isFile());
    assert.equal(current.dev, runtimeIdentity.dev);
    assert.equal(current.ino, runtimeIdentity.ino);
    const bytes = jsonBytes(value);
    assert.ok(bytes.length <= CAP.file);
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = hostFS.writeSync(runtimeDescriptor, bytes, offset, Math.min(CAP.pull, bytes.length - offset), offset);
      assert.ok(wrote > 0); offset += wrote;
    }
    hostFS.ftruncateSync(runtimeDescriptor, bytes.length);
    hostFS.fsyncSync(runtimeDescriptor);
  }
  function close() { if (runtimeDescriptor !== null) { hostFS.closeSync(runtimeDescriptor); runtimeDescriptor = null; } }
  return {writeNew, beginRuntime, updateRuntime, close};
}

async function main(argv) {
  // Frozen CLI: no selection/filter, repeat, mode aliases or extra argument.
  assert.equal(argv.length, 5);
  assert.ok(argv[0] === '--list' || argv[0] === '--run');
  assert.equal(argv[1], '--root');
  assert.equal(argv[3], '--evidence-dir');
  const root = argv[2];
  const evidence = argv[4];
  assert.equal(IDS.length, 58);
  assert.equal(new Set(IDS).size, 58);
  const {literal, binding} = checkedContext(root, evidence);
  const writer = createProofWriter(evidence);
  if (argv[0] === '--list') {
    // Important: no createFakes, VM construction or subject evaluation here.
    writer.writeNew('list.json', {schema_version: 'foobar-preview-controls-node-list-v1', case_ids: IDS, binding});
    return 0;
  }
  const listing = strictJSON(boundedRead(noLinkPath(evidence, 'node/list.json')));
  assert.deepEqual(listing, {schema_version: 'foobar-preview-controls-node-list-v1', case_ids: IDS, binding});
  const runtime = {schema_version: 'foobar-preview-controls-node-runtime-v1', binding,
    case_ids: IDS, events: [], writer_complete: false};
  let hasAssertion = false;
  let hasHarness = false;
  try {
    writer.beginRuntime(runtime);
    for (const [index, name] of NAMES.entries()) {
      const case_id = IDS[index];
      runtime.events.push({event: 'start', case_id, sequence: runtime.events.length + 1});
      writer.updateRuntime(runtime);
      const result = await executeCase(name, literal);
      const ordinal = String(index + 1).padStart(3, '0');
      const ledger_path = 'node/ledgers/' + ordinal + '.json';
      writer.writeNew('ledgers/' + ordinal + '.json', {
        schema_version: 'foobar-preview-controls-fake-ledger-v1', case_id, events: result.ledger
      });
      runtime.events.push({event: 'finish', case_id, sequence: runtime.events.length + 1,
        status: result.status, error_code: result.error_code, ledger_path});
      writer.updateRuntime(runtime);
      hasAssertion ||= result.status === 'failed';
      hasHarness ||= result.status === 'error';
    }
    runtime.writer_complete = true;
    writer.updateRuntime(runtime);
  } finally { writer.close(); }
  return hasHarness ? 2 : hasAssertion ? 1 : 0;
}

// Only this executable entry point owns runtime. Requiring the file is not a
// supported interface, and --list never evaluates the transfer literal.
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    // Never retain raw exception text, URLs, source/environment or credentials.
    process.stderr.write('Preview controls harness failed closed.\n');
    process.exitCode = 2;
  });
}
