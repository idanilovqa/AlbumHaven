const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REVIEWERS = ['codex', 'pr-agent'];
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const ENVELOPE_FIELDS = ['version', 'keyId', 'wrappedKey', 'iv', 'tag', 'ciphertext'];
const STANDARD_RATES = {
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-5.6': [4, 0.4, 5, 20],
  'gpt-5.6-sol': [4, 0.4, 5, 20],
  'gpt-5.6-terra': [2, 0.2, 2.5, 12],
};
const PRICING_SOURCES = [
  'https://developers.openai.com/api/docs/models/gpt-6-astra',
  'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
];

function invalid() { throw new Error('Invalid private review usage data.'); }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function choice(value, values) {
  if (!values.includes(value)) invalid();
  return value;
}
function identifier(value, model = false) {
  if (value == null) return null;
  const pattern = model ? /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,255}$/ : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}
function count(value, nullable = true) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function normalizeUsage(value) {
  if (value == null) return null;
  object(value);
  const usage = Object.fromEntries(TOKEN_FIELDS.map(field => [field, count(value[field])]));
  const { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: written,
    outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: total } = usage;
  if (input !== null && ((cached !== null && cached > input) || (written !== null && written > input)
    || (cached !== null && written !== null && cached + written > input))) invalid();
  if (output !== null && reasoning !== null && reasoning > output) invalid();
  if (input !== null && output !== null && total !== null && input + output !== total) invalid();
  return Object.values(usage).some(value => value !== null) ? usage : null;
}
function normalizeRecord(value, reviewer) {
  object(value);
  if (value.schemaVersion !== 1 || value.reviewer !== reviewer) invalid();
  const providerCost = value.providerEstimatedCostUsd ?? null;
  if (providerCost !== null && (typeof providerCost !== 'number' || !Number.isFinite(providerCost) || providerCost < 0)) invalid();
  return {
    schemaVersion: 1, reviewer,
    responseId: identifier(value.responseId), callId: identifier(value.callId),
    status: choice(value.status, ['success', 'failure']), model: identifier(value.model, true),
    modelAttribution: choice(value.modelAttribution, ['requested', 'response']),
    serviceTier: identifier(value.serviceTier), usage: normalizeUsage(value.usage),
    providerEstimatedCostUsd: providerCost,
  };
}
function normalizeReport(value) {
  object(value);
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) invalid();
  const source = object(value.context);
  if (typeof source.runId !== 'string' || !/^[1-9][0-9]*$/.test(source.runId)
    || count(source.runAttempt, false) < 1
    || typeof source.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(source.headSha)) invalid();
  const context = {
    runId: source.runId, runAttempt: source.runAttempt, headSha: source.headSha.toLowerCase(),
    reviewer: choice(source.reviewer, REVIEWERS),
  };
  if (source.repository !== undefined) {
    if (typeof source.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) invalid();
    context.repository = source.repository;
  }
  if (source.pullRequestNumber !== undefined) {
    if (count(source.pullRequestNumber, false) < 1) invalid();
    context.pullRequestNumber = source.pullRequestNumber;
  }
  return {
    schemaVersion: 1, context,
    telemetryStatus: choice(value.telemetryStatus, ['available', 'partial', 'unavailable']),
    records: value.records.map(record => normalizeRecord(record, context.reviewer)),
  };
}

function requireRsa(key) {
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) invalid();
  return key;
}
function keyId(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}
function aad(envelope) {
  return Buffer.from(JSON.stringify({ version: envelope.version, keyId: envelope.keyId }));
}
function sealReport(report, publicKeyPem) {
  const sanitized = normalizeReport(report);
  const publicKey = requireRsa(crypto.createPublicKey(publicKeyPem));
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(sanitized));
  try {
    const envelope = { version: 1, keyId: keyId(publicKey) };
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(aad(envelope));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...envelope,
      wrappedKey: crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, dataKey).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally { dataKey.fill(0); plaintext.fill(0); }
}
function base64(value, length) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) invalid();
  return bytes;
}
function openReport(envelope, privateKeyPem) {
  object(envelope);
  if (Object.keys(envelope).length !== ENVELOPE_FIELDS.length
    || !ENVELOPE_FIELDS.every(field => Object.hasOwn(envelope, field))
    || envelope.version !== 1 || typeof envelope.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.keyId)) invalid();
  const privateKey = requireRsa(crypto.createPrivateKey(privateKeyPem));
  if (keyId(crypto.createPublicKey(privateKey)) !== envelope.keyId) invalid();
  const iv = base64(envelope.iv, 12);
  const tag = base64(envelope.tag, 16);
  const ciphertext = base64(envelope.ciphertext);
  const dataKey = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
  base64(envelope.wrappedKey, privateKey.asymmetricKeyDetails.modulusLength / 8));
  let plaintext;
  try {
    if (dataKey.length !== 32) invalid();
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAAD(aad(envelope));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return normalizeReport(JSON.parse(plaintext.toString('utf8')));
  } finally { dataKey.fill(0); if (plaintext) plaintext.fill(0); }
}

function estimate(record) {
  if (!record.usage || record.status !== 'success') return null;
  if (record.providerEstimatedCostUsd !== null) {
    return { amount: record.providerEstimatedCostUsd, source: 'provider', standardAssumed: false };
  }
  const rates = Object.hasOwn(STANDARD_RATES, record.model) ? STANDARD_RATES[record.model] : null;
  if (!rates || ![null, 'default', 'standard'].includes(record.serviceTier)) return null;
  const { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: written,
    outputTokens: output } = record.usage;
  if ([input, cached, written, output].includes(null)) return null;
  const long = input > 272000;
  return {
    amount: (((input - cached - written) * rates[0] + cached * rates[1] + written * rates[2])
      * (long ? 2 : 1) + output * rates[3] * (long ? 1.5 : 1)) / 1e6,
    source: 'standard-catalog', standardAssumed: record.serviceTier === null,
  };
}
function tokenTotal(records, field) {
  const known = records.map(record => record.usage?.[field] ?? null).filter(value => value !== null);
  const total = known.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) invalid();
  return { knownTotal: known.length ? total : null, knownResponses: known.length,
    unknownResponses: records.length - known.length };
}
function summarizeGroup(reviewer, model, records, telemetryStatus) {
  const estimates = records.map(estimate);
  const known = estimates.filter(Boolean);
  const sum = known.reduce((total, value) => total + value.amount, 0);
  if (!Number.isFinite(sum)) invalid();
  const complete = records.length > 0 && known.length === records.length;
  const withUsage = records.filter(record => record.usage !== null).length;
  return {
    reviewer, model, modelAttributions: [...new Set(records.map(record => record.modelAttribution))].sort(),
    telemetryStatus,
    responses: { observed: records.length, withUsage, unknownUsage: records.length - withUsage,
      success: records.filter(record => record.status === 'success').length,
      failure: records.filter(record => record.status === 'failure').length },
    tokens: Object.fromEntries(TOKEN_FIELDS.map(field => [field, tokenTotal(records, field)])),
    estimatedCostUsd: complete ? sum : null, costStatus: complete ? 'estimate' : 'unknown',
    knownEstimatedCostUsd: known.length ? sum : null,
    estimateSources: [...new Set(known.map(value => value.source))].sort(),
    standardRateAssumedResponses: known.filter(value => value.standardAssumed).length,
  };
}
function summarizeReports(reports) {
  if (!Array.isArray(reports)) invalid();
  const normalized = reports.map(normalizeReport);
  let context = null;
  const seen = new Map();
  const records = [];
  for (const report of normalized) {
    const { reviewer, ...candidate } = report.context;
    if (context === null) context = { ...candidate };
    for (const field of ['runId', 'runAttempt', 'headSha', 'repository', 'pullRequestNumber']) {
      if (context[field] !== undefined && candidate[field] !== undefined && context[field] !== candidate[field]) {
        throw new Error('Conflicting private review run context.');
      }
      if (context[field] === undefined && candidate[field] !== undefined) context[field] = candidate[field];
    }
    for (const record of report.records) {
      const identity = record.responseId ? `${reviewer}:response:${record.responseId}`
        : record.callId ? `${reviewer}:call:${record.callId}:${record.status}` : null;
      const semantic = { ...record, callId: record.responseId ? null : record.callId };
      const serialized = JSON.stringify(semantic);
      if (identity && seen.has(identity)) {
        if (seen.get(identity) !== serialized) throw new Error('Conflicting private review response records.');
        continue;
      }
      if (identity) seen.set(identity, serialized);
      records.push(record);
    }
  }
  const groups = [];
  const missingReviewers = [];
  for (const reviewer of REVIEWERS) {
    const containers = normalized.filter(report => report.context.reviewer === reviewer);
    const owned = records.filter(record => record.reviewer === reviewer);
    let status;
    if (!containers.length) { status = 'missing'; missingReviewers.push(reviewer); }
    else if (containers.every(report => report.telemetryStatus === 'unavailable')) status = 'unavailable';
    else if (containers.some(report => report.telemetryStatus !== 'available')) status = 'partial';
    else status = 'available';
    const models = owned.length ? [...new Set(owned.map(record => record.model))].sort() : [null];
    for (const model of models) groups.push(summarizeGroup(reviewer, model,
      owned.filter(record => record.model === model), status));
  }
  return {
    schemaVersion: 1, context,
    pricing: { asOf: '2026-09-08', currency: 'USD', unit: 'per million tokens', sources: [...PRICING_SOURCES],
      rateOrder: ['uncachedInput', 'cachedInput', 'cacheWriteInput', 'output'],
      rates: Object.fromEntries(Object.entries(STANDARD_RATES).map(([model, rates]) => [model, [...rates]])),
      longInputThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5 },
    coverage: { expectedReviewers: [...REVIEWERS], missingReviewers, billingComplete: false },
    groups,
    notes: [
      'Observed responses only; telemetry is not billing-complete and may omit retries or cancelled calls.',
      'Requested model attribution is not a guarantee of the billed model.',
      'Costs are estimates, not an invoice. Provider estimates are labeled separately from the dated standard catalog.',
      'Catalog estimates assume standard pricing when service tier is absent; unsupported named tiers remain unknown.',
      'Cached and cache-write tokens are included in input; reasoning tokens are included in output. Do not add them again.',
      'Missing counters and reviewer reports remain unknown. Known token totals cover only responses with that counter.',
      'Known estimated cost is a subtotal of successful responses with estimable cost; failed calls retain unknown cost even when counters exist.',
    ],
  };
}

function markdown(summary) {
  const token = (row, field) => {
    const value = row.tokens[field];
    return `${value.knownTotal ?? 'unknown'}${value.unknownResponses ? ` (${value.unknownResponses} unknown)` : ''}`;
  };
  const lines = ['# Private PR review usage', '',
    ...(summary.context ? [`Run ${summary.context.runId}, attempt ${summary.context.runAttempt}, head ${summary.context.headSha}.`, ''] : []),
    ...summary.notes.map(note => `- ${note}`), '',
    `Pricing date: ${summary.pricing.asOf}. USD estimates apply to observed responses only.`, '',
    '| Reviewer / model | Telemetry | Observed / with usage / unknown | Failures | Input (includes cache) | Cached input | Cache writes | Output (includes reasoning) | Reasoning | Estimated USD | Known subtotal USD | Estimate source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of summary.groups) {
    lines.push(`| ${row.reviewer} / ${row.model ?? 'unknown'} | ${row.telemetryStatus} | ${row.responses.observed} / ${row.responses.withUsage} / ${row.responses.unknownUsage} | ${row.responses.failure} | ${token(row, 'inputTokens')} | ${token(row, 'cachedInputTokens')} | ${token(row, 'cacheWriteInputTokens')} | ${token(row, 'outputTokens')} | ${token(row, 'reasoningOutputTokens')} | ${row.estimatedCostUsd === null ? 'unknown' : row.estimatedCostUsd.toFixed(8)} | ${row.knownEstimatedCostUsd === null ? 'unknown' : row.knownEstimatedCostUsd.toFixed(8)} | ${row.estimateSources.join(', ') || 'unknown'} |`);
  }
  lines.push('', 'Standard catalog rates per million tokens (uncached input / cached input / cache writes / output):', '');
  for (const [model, rates] of Object.entries(STANDARD_RATES)) lines.push(`- ${model}: ${rates.join(' / ')} USD.`);
  lines.push('', ...PRICING_SOURCES.map(url => `- [Official model pricing](${url})`));
  lines.push('', 'Requests above 272,000 input tokens use twice the input rates and 1.5 times the output rate, calculated separately for each response.', '');
  return lines.join('\n');
}
function artifactFiles(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) invalid();
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) invalid();
    if (entry.isDirectory()) return artifactFiles(filename);
    return entry.isFile() && entry.name.endsWith('.json') ? [filename] : [];
  });
}
function main(argv) {
  const [command, ...args] = argv;
  const allowed = { keygen: ['--private-key', '--public-key'], seal: ['--input', '--public-key', '--output'],
    report: ['--input-dir', '--private-key', '--output-prefix'] }[command];
  if (!allowed || args.length !== allowed.length * 2) invalid();
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index]) || Object.hasOwn(options, args[index]) || !args[index + 1]) invalid();
    options[args[index]] = args[index + 1];
  }
  if (command === 'keygen') {
    const privatePath = options['--private-key'];
    const publicPath = options['--public-key'];
    if (path.resolve(privatePath) === path.resolve(publicPath) || fs.existsSync(privatePath) || fs.existsSync(publicPath)) invalid();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    fs.writeFileSync(privatePath, keys.privateKey, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(publicPath, keys.publicKey, { flag: 'wx', mode: 0o644 });
  } else if (command === 'seal') {
    const report = JSON.parse(fs.readFileSync(options['--input'], 'utf8'));
    const envelope = sealReport(report, fs.readFileSync(options['--public-key'], 'utf8'));
    fs.writeFileSync(options['--output'], `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  } else {
    const privateKey = fs.readFileSync(options['--private-key'], 'utf8');
    const reports = artifactFiles(options['--input-dir']).map(filename =>
      openReport(JSON.parse(fs.readFileSync(filename, 'utf8')), privateKey));
    const summary = summarizeReports(reports);
    const prefix = options['--output-prefix'];
    fs.writeFileSync(`${prefix}.private.json`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(`${prefix}.private.md`, markdown(summary), { mode: 0o600 });
  }
}

module.exports = { sealReport, openReport, summarizeReports };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('Private review usage command failed; check input, recipient key, and output paths.\n'); process.exitCode = 1; }
}
