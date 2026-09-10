const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const collectorPath = path.resolve(__dirname, '../../scripts/ci/collect-codex-review-usage.cjs');
const { collectCodexUsage } = require(collectorPath);

function fixtureHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-codex-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('album-haven-codex-usage-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeRollout(home, name, lines) {
  const directory = path.join(home, 'sessions', '2026', '09', '08');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-${name}.jsonl`),
    lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
}

function metadata(threadId, sessionId = threadId) {
  return { type: 'session_meta', payload: { id: threadId, session_id: sessionId, cli_version: '0.153.4' } };
}

function context(turnId, model = 'gpt-5.6-sol') {
  return { type: 'turn_context', payload: { turn_id: turnId, model } };
}

function settings(threadId, model, serviceTier = null) {
  return { type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_id: threadId,
    thread_settings: { model, service_tier: serviceTier },
  } };
}

function usage(total = 120) {
  return {
    input_tokens: total - 20, cached_input_tokens: 30, cache_write_input_tokens: 0,
    output_tokens: 20, reasoning_output_tokens: 12, total_tokens: total,
  };
}

function response(responseId, threadId = 'root', turnId = 'turn-1', tokens = usage()) {
  return { timestamp: '2026-09-08T12:00:00.000Z', type: 'token_usage_record', payload: {
    thread_id: threadId, session_id: 'root', turn_id: turnId, root_turn_id: 'turn-1',
    response_id: responseId, usage: tokens,
    turn_token_usage: usage(9999), thread_token_usage: usage(99999),
  } };
}

function normalized(responseId, model = 'gpt-5.6-sol', serviceTier = null, total = 120) {
  return {
    schemaVersion: 1, reviewer: 'codex', responseId, callId: null, status: 'success',
    model, modelAttribution: 'requested', serviceTier,
    usage: { inputTokens: total - 20, cachedInputTokens: 30, cacheWriteInputTokens: 0,
      outputTokens: 20, reasoningOutputTokens: 12, totalTokens: total },
  };
}

test('collects per-response usage across child sessions without counting cumulative snapshots or duplicates', (t) => {
  const home = fixtureHome(t);
  const first = response('resp-first');
  writeRollout(home, 'root', [metadata('root'), context('turn-1'), first,
    response('resp-second', 'root', 'turn-1', usage(80)),
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(999999) } } }]);
  writeRollout(home, 'child', [metadata('child', 'root'), context('child-turn', 'gpt-5.6-luna'),
    first, response('resp-child', 'child', 'child-turn', usage(60))]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'observed');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.records.sort((a, b) => a.responseId.localeCompare(b.responseId)), [
    normalized('resp-child', 'gpt-5.6-luna', null, 60), normalized('resp-first'),
    normalized('resp-second', 'gpt-5.6-sol', null, 80),
  ]);
  assert.equal(report.records.reduce((sum, row) => sum + row.usage.totalTokens, 0), 260);
});

test('attributes requested model and tier using thread-owned snapshots and turn context', (t) => {
  const home = fixtureHome(t);
  writeRollout(home, 'models', [metadata('root'), settings('root', 'gpt-5.6-sol', 'priority'),
    context('turn-1'), response('resp-old'),
    settings('unrelated-thread', 'secret-parent-model', 'flex'), response('resp-still-old'),
    settings('root', 'gpt-6-astra', 'default'), context('turn-2', 'gpt-6-astra'),
    response('resp-new', 'root', 'turn-2')]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'observed');
  assert.deepEqual(report.records, [normalized('resp-old', 'gpt-5.6-sol', 'priority'),
    normalized('resp-still-old', 'gpt-5.6-sol', 'priority'),
    normalized('resp-new', 'gpt-6-astra', 'default')]);
});

test('keeps missing and invalid native counters unknown and marks partial coverage', (t) => {
  const home = fixtureHome(t);
  const invalid = usage();
  invalid.input_tokens = -1;
  invalid.output_tokens = Number.MAX_SAFE_INTEGER + 1;
  delete invalid.cached_input_tokens;
  writeRollout(home, 'gaps', [metadata('root'), context('turn-1'),
    response('resp-valid'), response('resp-missing', 'root', 'turn-1', null),
    response('resp-invalid', 'root', 'turn-1', invalid)]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'partial');
  assert.equal(report.records[1].usage, null);
  assert.equal(report.records[2].usage.inputTokens, null);
  assert.equal(report.records[2].usage.cachedInputTokens, null);
  assert.equal(report.records[2].usage.outputTokens, null);
  assert.ok(report.warnings.includes('missing_usage'));
  assert.ok(report.warnings.includes('invalid_usage_counter'));
  assert.ok(report.warnings.includes('missing_usage_counter'));
});

test('flags malformed JSON, missing attribution and task aborts without inventing failed API calls', (t) => {
  const home = fixtureHome(t);
  writeRollout(home, 'partial', [metadata('root'), response('resp-unattributed'),
    '{"privateTranscript":"DO-NOT-REPORT-ME"',
    { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'private reason' } }]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'partial');
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].model, null);
  assert.equal(report.records[0].status, 'success');
  assert.ok(report.warnings.includes('malformed_jsonl'));
  assert.ok(report.warnings.includes('missing_model_attribution'));
  assert.ok(report.warnings.includes('interrupted_turn'));
  assert.doesNotMatch(JSON.stringify(report), /DO-NOT-REPORT|private reason/);
});

test('never treats missing session logs or cumulative-only histories as zero measured usage', (t) => {
  const home = fixtureHome(t);
  const absent = collectCodexUsage(home);
  assert.equal(absent.coverage, 'unavailable');
  assert.deepEqual(absent.records, []);
  assert.ok(absent.warnings.includes('session_logs_unavailable'));
  writeRollout(home, 'legacy', [metadata('root'), context('turn-1'),
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage() } } }]);
  const legacy = collectCodexUsage(home);
  assert.equal(legacy.coverage, 'unavailable');
  assert.deepEqual(legacy.records, []);
  assert.ok(legacy.warnings.includes('no_response_usage_records'));
});

test('reports conflicting duplicate response usage as a gap instead of silently double counting', (t) => {
  const home = fixtureHome(t);
  writeRollout(home, 'duplicates', [metadata('root'), context('turn-1'),
    response('resp-conflict'), response('resp-conflict', 'root', 'turn-1', usage(130))]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'partial');
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].usage, null);
  assert.ok(report.warnings.includes('conflicting_response_usage'));
});

test('exports only the normalized scalar allowlist and removes malformed scalar fields', (t) => {
  const home = fixtureHome(t);
  const entry = response('resp-safe');
  entry.payload.api_key = 'sk-private-token';
  entry.payload.prompt = 'secret prompt';
  entry.payload.usage.secret = 'secret response';
  entry.payload.usage_metadata = { amount: '9000', metadata: { content: 'secret billing data' } };
  writeRollout(home, 'privacy', [metadata('root'), context('turn-1'), entry,
    context('turn-2', 'C:\\private\\model'), response('C:\\private\\response', 'root', 'turn-2')]);
  const report = collectCodexUsage(home);
  assert.deepEqual(report.records[0], normalized('resp-safe'));
  assert.equal(report.records[1].responseId, null);
  assert.equal(report.records[1].model, null);
  assert.equal(report.coverage, 'partial');
  assert.doesNotMatch(JSON.stringify(report), /sk-private|secret|private|usage_metadata|9000/);
  assert.ok(report.warnings.every((warning) => /^[a-z_]+$/.test(warning)));
});

test('CLI writes the private report to disk without printing usage or filesystem errors', (t) => {
  const home = fixtureHome(t);
  writeRollout(home, 'cli', [metadata('root'), context('turn-1'), response('resp-cli')]);
  const output = path.join(home, 'private', 'reports', 'private-usage.json');
  const result = spawnSync(process.execPath, [collectorPath, '--codex-home', home, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')).records, [normalized('resp-cli')]);
  const failed = spawnSync(process.execPath, [collectorPath, '--codex-home', home, '--output', home], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /^codex_usage_write_failed\r?\n$/);
  assert.ok(!failed.stderr.includes(home));
});

test('retains measured zero counters and the first physical session owner through copied metadata', (t) => {
  const home = fixtureHome(t);
  const zero = Object.fromEntries(Object.keys(usage()).map((key) => [key, 0]));
  writeRollout(home, 'child-owner', [metadata('child', 'root'), metadata('root'),
    settings('child', 'gpt-5.6-luna', 'priority'), context('child-turn', 'gpt-5.6-luna'),
    response('resp-zero', 'child', 'child-turn', zero)]);
  const report = collectCodexUsage(home);
  assert.equal(report.coverage, 'observed');
  assert.deepEqual(report.warnings, []);
  assert.equal(report.records[0].serviceTier, 'priority');
  assert.equal(report.records[0].model, 'gpt-5.6-luna');
  assert.ok(Object.values(report.records[0].usage).every((counter) => counter === 0));
});
