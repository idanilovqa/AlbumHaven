const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const helperPath = path.resolve(__dirname, '../../scripts/ci/private-review-usage.cjs');
let recipient;
function helper() {
  assert.ok(fs.existsSync(helperPath), 'private review usage helper must exist');
  return require(helperPath);
}
function keys() {
  recipient ||= crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return recipient;
}
function record(overrides = {}) {
  return {
    schemaVersion: 1, reviewer: 'codex', responseId: 'resp_1', callId: 'call_1',
    status: 'success', model: 'gpt-6-astra', modelAttribution: 'requested',
    serviceTier: null,
    usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 100,
      outputTokens: 100, reasoningOutputTokens: 80, totalTokens: 1100 },
    providerEstimatedCostUsd: null, ...overrides,
  };
}
function report(overrides = {}) {
  return {
    schemaVersion: 1,
    context: { runId: '34280919801', runAttempt: 1, headSha: 'a'.repeat(40),
      reviewer: 'codex', repository: 'idanilovqa/AlbumHaven', pullRequestNumber: 1 },
    telemetryStatus: 'available', records: [record()], ...overrides,
  };
}
function group(summary, reviewer = 'codex', model = 'gpt-6-astra') {
  return summary.groups.find(row => row.reviewer === reviewer && row.model === model);
}
function tempDirectory(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'album-haven-private-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function cli(args) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

test('sealed usage contains only crypto fields and strips sensitive extra payload', () => {
  const { sealReport, openReport } = helper();
  const sensitive = report({ prompt: 'TOP_SECRET_PROMPT', localPath: 'PRIVATE_MEDIA_PATH' });
  sensitive.context.user = 'PRIVATE_OWNER';
  sensitive.records[0].responseContent = 'PRIVATE_RESPONSE';
  sensitive.records[0].usage.arbitraryPayload = 'PRIVATE_TOKEN';
  const envelope = sealReport(sensitive, keys().publicKey);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'keyId', 'tag', 'version', 'wrappedKey']);
  assert.equal(envelope.version, 1);
  assert.match(envelope.keyId, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
  assert.deepEqual(openReport(envelope, keys().privateKey), report());
  const serialized = JSON.stringify(envelope);
  for (const marker of ['TOP_SECRET_PROMPT', 'PRIVATE_MEDIA_PATH', 'gpt-6-astra', 'inputTokens']) {
    assert.ok(!serialized.includes(marker));
  }
});

test('sealing uses fresh data keys and nonces with a stable recipient identifier', () => {
  const { sealReport } = helper();
  const first = sealReport(report(), keys().publicKey);
  const second = sealReport(report(), keys().publicKey);
  assert.equal(first.keyId, second.keyId);
  for (const field of ['wrappedKey', 'iv', 'tag', 'ciphertext']) assert.notEqual(first[field], second[field]);
});

test('every encrypted field is authenticated and wrong recipient keys are rejected', () => {
  const { sealReport, openReport } = helper();
  const envelope = sealReport(report(), keys().publicKey);
  for (const field of ['wrappedKey', 'iv', 'tag', 'ciphertext']) {
    const bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] ^= 1;
    assert.throws(() => openReport({ ...envelope, [field]: bytes.toString('base64') }, keys().privateKey));
  }
  for (const changed of [{ version: 2 }, { keyId: 'b'.repeat(64) }, { plaintextTokens: 1100 }, { iv: 'not base64!' }]) {
    assert.throws(() => openReport({ ...envelope, ...changed }, keys().privateKey));
  }
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => openReport(envelope, other.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => sealReport(report(), ec.publicKey.export({ type: 'spki', format: 'pem' })));
});

test('invalid counters and mismatched record ownership fail closed', () => {
  const { sealReport, summarizeReports } = helper();
  const invalidRecords = [
    record({ reviewer: 'pr-agent' }), record({ status: 'pending' }),
    record({ model: 'PRIVATE\nPROMPT' }), record({ providerEstimatedCostUsd: -1 }),
    ...[
      { inputTokens: -1 }, { inputTokens: '1000' }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { cachedInputTokens: 1001 }, { cacheWriteInputTokens: 900 },
      { reasoningOutputTokens: 101 }, { totalTokens: 1200 },
    ].map(change => record({ usage: { ...record().usage, ...change } })),
  ];
  for (const invalid of invalidRecords) {
    const input = report({ records: [invalid] });
    assert.throws(() => sealReport(input, keys().publicKey), /invalid/i);
    assert.throws(() => summarizeReports([input]), /invalid/i);
  }
});

test('summary deduplicates responses across reports without adding cached or reasoning tokens', () => {
  const { summarizeReports } = helper();
  const duplicate = record({ callId: 'different_callback_id' });
  const summary = summarizeReports([report(), report({ records: [duplicate] })]);
  const row = group(summary);
  assert.equal(row.responses.observed, 1);
  assert.equal(row.responses.withUsage, 1);
  assert.equal(row.tokens.inputTokens.knownTotal, 1000);
  assert.equal(row.tokens.outputTokens.knownTotal, 100);
  assert.equal(row.tokens.reasoningOutputTokens.knownTotal, 80);
  assert.ok(Math.abs(row.estimatedCostUsd - 0.01345) < 1e-12);
  assert.equal(row.costStatus, 'estimate');
  assert.deepEqual(row.modelAttributions, ['requested']);
  assert.equal(summary.coverage.billingComplete, false);
  assert.equal(summary.pricing.asOf, '2026-09-08');
  assert.deepEqual(summary.pricing.sources, [
    'https://developers.openai.com/api/docs/models/gpt-6-astra',
    'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  ]);
});

for (const [model, rates] of [
  ['gpt-6-astra', [10, 1, 12.5, 50]],
  ['gpt-5.6', [4, 0.4, 5, 20]],
  ['gpt-5.6-sol', [4, 0.4, 5, 20]],
  ['gpt-5.6-terra', [2, 0.2, 2.5, 12]],
]) {
  test(`standard estimate uses the dated ${model} rates and strict per-response long-input boundary`, () => {
    const { summarizeReports } = helper();
    for (const inputTokens of [272000, 272001]) {
      const input = record({ model, usage: { inputTokens, cachedInputTokens: 200,
        cacheWriteInputTokens: 100, outputTokens: 1000, reasoningOutputTokens: 500,
        totalTokens: inputTokens + 1000 } });
      const row = group(summarizeReports([report({ records: [input] })]), 'codex', model);
      const [ordinary, cached, written, output] = rates;
      const expected = ((inputTokens - 300) * ordinary + 200 * cached + 100 * written)
        * (inputTokens > 272000 ? 2 : 1) / 1e6
        + 1000 * output * (inputTokens > 272000 ? 1.5 : 1) / 1e6;
      assert.ok(Math.abs(row.estimatedCostUsd - expected) < 1e-12);
    }
    const short = record({ model, usage: { inputTokens: 200000, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 200000 } });
    const records = [short, { ...short, responseId: 'resp_2', callId: 'call_2' }];
    const row = group(summarizeReports([report({ records })]), 'codex', model);
    assert.ok(Math.abs(row.estimatedCostUsd - 400000 * rates[0] / 1e6) < 1e-12);
  });
}

test('unknown failures and incomplete counters retain explicit gaps instead of zero costs', () => {
  const { summarizeReports } = helper();
  const failure = record({ responseId: null, callId: 'failed_1', status: 'failure', usage: null });
  const summary = summarizeReports([report({ telemetryStatus: 'partial', records: [record(), failure] })]);
  const row = group(summary);
  assert.deepEqual(row.responses, { observed: 2, withUsage: 1, unknownUsage: 1, success: 1, failure: 1 });
  assert.deepEqual(row.tokens.inputTokens, { knownTotal: 1000, knownResponses: 1, unknownResponses: 1 });
  assert.equal(row.estimatedCostUsd, null);
  assert.ok(Math.abs(row.knownEstimatedCostUsd - 0.01345) < 1e-12);
  assert.equal(row.costStatus, 'unknown');
  assert.equal(row.telemetryStatus, 'partial');
  for (const overrides of [
    { model: 'unknown-model' }, { model: 'constructor' }, { serviceTier: 'priority' },
    { usage: { ...record().usage, cachedInputTokens: null } },
    { usage: { ...record().usage, cacheWriteInputTokens: null } },
    { usage: { ...record().usage, outputTokens: null } },
  ]) {
    const input = record(overrides);
    assert.equal(group(summarizeReports([report({ records: [input] })]), 'codex', input.model).estimatedCostUsd, null);
  }
});

test('missing and empty reviewer reports remain explicit unknown coverage', () => {
  const { summarizeReports } = helper();
  const summary = summarizeReports([report({ telemetryStatus: 'unavailable', records: [] })]);
  assert.deepEqual(summary.coverage.missingReviewers, ['pr-agent']);
  for (const row of summary.groups) {
    assert.equal(row.estimatedCostUsd, null);
    assert.equal(row.knownEstimatedCostUsd, null);
    assert.equal(row.tokens.inputTokens.knownTotal, null);
  }
  assert.equal(group(summary, 'pr-agent', null).telemetryStatus, 'missing');
  assert.equal(group(summary, 'codex', null).telemetryStatus, 'unavailable');
  assert.deepEqual(summarizeReports([]).coverage.missingReviewers, ['codex', 'pr-agent']);
});

test('all-null token objects remain unknown usage after normalization and summarization', () => {
  const { sealReport, openReport, summarizeReports } = helper();
  const unknown = record({ usage: Object.fromEntries(Object.keys(record().usage).map(field => [field, null])),
    providerEstimatedCostUsd: 0 });
  const input = report({ records: [unknown] });
  const opened = openReport(sealReport(input, keys().publicKey), keys().privateKey);
  assert.equal(opened.records[0].usage, null);
  const row = group(summarizeReports([input]));
  assert.equal(row.responses.withUsage, 0);
  assert.equal(row.responses.unknownUsage, 1);
  assert.equal(row.estimatedCostUsd, null);
});

test('failed responses retain actual counters while every cost estimate remains unknown', () => {
  const { summarizeReports } = helper();
  for (const usage of [Object.fromEntries(Object.keys(record().usage).map(field => [field, 0])), record().usage]) {
    const failed = record({ status: 'failure', usage, providerEstimatedCostUsd: 0 });
    const row = group(summarizeReports([report({ records: [failed] })]));
    assert.equal(row.estimatedCostUsd, null);
    assert.equal(row.costStatus, 'unknown');
    assert.deepEqual(row.estimateSources, []);
    assert.equal(row.tokens.inputTokens.knownTotal, usage.inputTokens);
  }
});

test('native cost estimates require a successful response with usage and retain their source', () => {
  const { summarizeReports } = helper();
  const native = record({ reviewer: 'pr-agent', model: 'gpt-5.6', modelAttribution: 'response',
    usage: { ...record().usage, cacheWriteInputTokens: null }, providerEstimatedCostUsd: 0.021 });
  const input = report({ context: { ...report().context, reviewer: 'pr-agent' }, records: [native] });
  const row = group(summarizeReports([input]), 'pr-agent', 'gpt-5.6');
  assert.equal(row.estimatedCostUsd, 0.021);
  assert.deepEqual(row.estimateSources, ['provider']);
  assert.equal(row.tokens.cacheWriteInputTokens.knownTotal, null);
  for (const changes of [{ status: 'failure', usage: null }, { status: 'failure' }, { usage: null }]) {
    const invalidEstimate = { ...native, ...changes, providerEstimatedCostUsd: 0 };
    const unknown = group(summarizeReports([{ ...input, records: [invalidEstimate] }]), 'pr-agent', 'gpt-5.6');
    assert.equal(unknown.estimatedCostUsd, null);
    assert.deepEqual(unknown.estimateSources, []);
  }
  const standard = group(summarizeReports([report()]));
  assert.deepEqual(standard.estimateSources, ['standard-catalog']);
  assert.equal(standard.standardRateAssumedResponses, 1);
});

test('different models and reviewers remain separate while conflicting identities are rejected', () => {
  const { summarizeReports } = helper();
  const prAgent = report({ context: { ...report().context, reviewer: 'pr-agent' },
    records: [record({ reviewer: 'pr-agent', model: 'gpt-5.6', modelAttribution: 'response' })] });
  const summary = summarizeReports([report(), prAgent]);
  assert.equal(summary.groups.length, 2);
  assert.equal(group(summary, 'pr-agent', 'gpt-5.6').responses.observed, 1);
  for (const context of [{ runId: 'other' }, { runAttempt: 2 }, { headSha: 'b'.repeat(40) }]) {
    assert.throws(() => summarizeReports([report(), report({ context: { ...report().context, ...context } })]));
  }
  assert.throws(() => summarizeReports([report(), report({ records: [record({
    usage: { ...record().usage, outputTokens: 101, totalTokens: 1101 },
  })] })]), /conflict/i);
});

test('a failed call and its successful retry can share a call ID without hiding unknown usage', () => {
  const { summarizeReports } = helper();
  const failed = record({ responseId: null, status: 'failure', usage: null });
  const success = record({ responseId: null });
  const input = report({ telemetryStatus: 'partial', records: [failed, success, { ...success }] });
  const row = group(summarizeReports([input]));
  assert.equal(row.responses.observed, 2);
  assert.equal(row.responses.success, 1);
  assert.equal(row.responses.failure, 1);
  assert.equal(row.estimatedCostUsd, null);
  assert.ok(Math.abs(row.knownEstimatedCostUsd - 0.01345) < 1e-12);
  assert.throws(() => summarizeReports([report({ records: [success,
    { ...success, usage: { ...success.usage, outputTokens: 101, totalTokens: 1101 } }] })]), /conflict/i);
});

test('keygen never prints keys or overwrites an existing private key', t => {
  helper();
  const root = tempDirectory(t);
  const privatePath = path.join(root, 'owner.pem');
  const publicPath = path.join(root, 'recipient.pem');
  const args = ['keygen', '--private-key', privatePath, '--public-key', publicPath];
  const first = cli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.equal(first.stderr, '');
  const before = fs.readFileSync(privatePath);
  assert.equal(crypto.createPrivateKey(before).asymmetricKeyType, 'rsa');
  const second = cli(args);
  assert.notEqual(second.status, 0);
  assert.deepEqual(fs.readFileSync(privatePath), before);
  assert.ok(!second.stderr.includes('BEGIN PRIVATE KEY'));
});

test('offline CLI seals nested artifacts and writes only local private summaries', t => {
  const { sealReport } = helper();
  const root = tempDirectory(t);
  const input = path.join(root, 'input.json');
  const publicPath = path.join(root, 'recipient.pem');
  const privatePath = path.join(root, 'owner.pem');
  const artifactRoot = path.join(root, 'artifacts');
  const nested = path.join(artifactRoot, 'codex');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(input, JSON.stringify(report()));
  fs.writeFileSync(publicPath, keys().publicKey);
  fs.writeFileSync(privatePath, keys().privateKey, { mode: 0o600 });
  const encrypted = path.join(nested, 'usage.json');
  const sealed = cli(['seal', '--input', input, '--public-key', publicPath, '--output', encrypted]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(sealed.stdout, '');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(encrypted))).length, 6);
  const prefix = path.join(root, 'run');
  const result = cli(['report', '--input-dir', artifactRoot, '--private-key', privatePath, '--output-prefix', prefix]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const summary = JSON.parse(fs.readFileSync(`${prefix}.private.json`, 'utf8'));
  assert.equal(group(summary).responses.observed, 1);
  const markdown = fs.readFileSync(`${prefix}.private.md`, 'utf8');
  assert.match(markdown, /observed/i);
  assert.match(markdown, /requested.*bill/i);
  assert.match(markdown, /not.*invoice/i);
  assert.match(markdown, /pr-agent/);
  assert.match(markdown, /known subtotal/i);
  assert.match(markdown, /https:\/\/developers\.openai\.com\/api\/docs\/models\/gpt-6-astra/);
  const broken = JSON.parse(fs.readFileSync(encrypted, 'utf8'));
  broken.ciphertext = sealReport(report(), keys().publicKey).ciphertext;
  fs.writeFileSync(encrypted, JSON.stringify(broken));
  const failedPrefix = path.join(root, 'failed');
  const failed = cli(['report', '--input-dir', artifactRoot, '--private-key', privatePath, '--output-prefix', failedPrefix]);
  assert.notEqual(failed.status, 0);
  assert.ok(!fs.existsSync(`${failedPrefix}.private.json`));
  assert.ok(!fs.existsSync(`${failedPrefix}.private.md`));
});
