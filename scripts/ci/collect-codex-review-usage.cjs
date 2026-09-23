#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COUNTERS = [
  ['input_tokens', 'inputTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['cache_write_input_tokens', 'cacheWriteInputTokens'],
  ['output_tokens', 'outputTokens'],
  ['reasoning_output_tokens', 'reasoningOutputTokens'],
  ['total_tokens', 'totalTokens'],
];
const SCALAR_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const SERVICE_TIERS = new Set(['auto', 'default', 'priority', 'flex', 'scale']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalarName(value) {
  return typeof value === 'string' && SCALAR_NAME.test(value) ? value : null;
}

function normalizeUsage(value, warnings) {
  if (!object(value)) {
    warnings.add('missing_usage');
    return null;
  }
  return Object.fromEntries(COUNTERS.map(([nativeName, normalizedName]) => {
    const counter = value[nativeName];
    if (counter === null || counter === undefined) {
      warnings.add('missing_usage_counter');
      return [normalizedName, null];
    }
    if (!Number.isSafeInteger(counter) || counter < 0) {
      warnings.add('invalid_usage_counter');
      return [normalizedName, null];
    }
    return [normalizedName, counter];
  }));
}

function rolloutFiles(codexHome, warnings) {
  const files = [];
  function visit(directory) {
    let entries;
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) {
        warnings.add('session_symlink_skipped');
        return;
      }
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      warnings.add('session_logs_unavailable');
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) warnings.add('session_symlink_skipped');
      else if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zst')) warnings.add('compressed_session_unsupported');
    }
  }
  visit(path.join(codexHome, 'sessions'));
  return files;
}

// Keep only native attribution and per-response scalars in memory beyond each parsed line.
function readRollout(file, warnings) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    warnings.add('session_read_failed');
    return { threadId: null, events: [] };
  }
  const result = { threadId: null, events: [] };
  let sessionMetadataSeen = false;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      warnings.add('malformed_jsonl');
      continue;
    }
    if (!object(entry) || typeof entry.type !== 'string') {
      warnings.add('invalid_rollout_entry');
      continue;
    }
    const payload = entry.payload;
    if (entry.type === 'session_meta' && object(payload)) {
      if (!sessionMetadataSeen) {
        result.threadId = scalarName(payload.id);
        sessionMetadataSeen = true;
      }
    } else if (entry.type === 'turn_context' && object(payload)) {
      result.events.push({ type: 'context', turnId: scalarName(payload.turn_id), model: scalarName(payload.model) });
    } else if (entry.type === 'event_msg' && object(payload)) {
      if (payload.type === 'turn_aborted') warnings.add('interrupted_turn');
      if (payload.type === 'thread_settings_applied' && object(payload.thread_settings)) {
        const tier = payload.thread_settings.service_tier;
        result.events.push({
          type: 'settings', threadId: scalarName(payload.thread_id),
          model: scalarName(payload.thread_settings.model),
          serviceTier: SERVICE_TIERS.has(tier) ? tier : null,
          invalidTier: tier !== undefined && tier !== null && !SERVICE_TIERS.has(tier),
        });
      }
    } else if (entry.type === 'token_usage_record') {
      if (!object(payload)) {
        warnings.add('invalid_response_record');
        continue;
      }
      const responseId = scalarName(payload.response_id);
      if (responseId === null) warnings.add('invalid_response_id');
      result.events.push({
        type: 'response', threadId: scalarName(payload.thread_id), turnId: scalarName(payload.turn_id),
        responseId, usage: normalizeUsage(payload.usage, warnings),
      });
    }
  }
  return result;
}

/** Observed native response usage; requested model context is not a billed-model guarantee. */
function collectCodexUsage(codexHome) {
  const warnings = new Set();
  const files = rolloutFiles(codexHome, warnings).map((file) => readRollout(file, warnings));
  const contexts = new Map();
  const candidates = [];
  for (const file of files) {
    const models = new Map();
    let settings = null;
    for (const event of file.events) {
      if (event.type === 'context') {
        models.set(event.turnId, event.model);
        if (file.threadId && event.turnId && event.model) {
          contexts.set(`${file.threadId}\0${event.turnId}`, event.model);
        }
      } else if (event.type === 'settings' && event.threadId === file.threadId && file.threadId) {
        settings = event;
        if (event.invalidTier) warnings.add('invalid_service_tier');
      } else if (event.type === 'response') {
        const owned = event.threadId !== null && event.threadId === file.threadId;
        candidates.push({ ...event, owned,
          model: owned ? models.get(event.turnId) ?? settings?.model ?? null : null,
          serviceTier: owned ? settings?.serviceTier ?? null : null,
        });
      }
    }
  }

  // Prefer the originating thread over a copied ancestor record in another rollout.
  candidates.sort((left, right) => Number(right.owned) - Number(left.owned));
  const records = [];
  const responses = new Map();
  for (const candidate of candidates) {
    const prior = candidate.responseId ? responses.get(candidate.responseId) : null;
    if (prior) {
      if (JSON.stringify(prior.usage) !== JSON.stringify(candidate.usage)) {
        warnings.add('conflicting_response_usage');
        prior.usage = null;
      }
      continue;
    }
    const model = candidate.model ?? contexts.get(`${candidate.threadId}\0${candidate.turnId}`) ?? null;
    if (model === null) warnings.add('missing_model_attribution');
    if (candidate.threadId === null || candidate.turnId === null) warnings.add('missing_response_attribution');
    const record = {
      schemaVersion: 1, reviewer: 'codex', responseId: candidate.responseId, callId: null,
      status: 'success', model, modelAttribution: 'requested', serviceTier: candidate.serviceTier,
      usage: candidate.usage,
    };
    records.push(record);
    if (candidate.responseId) responses.set(candidate.responseId, record);
  }
  if (records.length === 0) warnings.add('no_response_usage_records');
  return {
    records,
    coverage: records.length === 0 ? 'unavailable' : warnings.size > 0 ? 'partial' : 'observed',
    warnings: [...warnings].sort(),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--codex-home', '--output'].includes(name) || options.has(name) || !value || value.startsWith('--')) {
      process.stderr.write('codex_usage_invalid_arguments\n');
      return 1;
    }
    options.set(name, value);
  }
  if (options.size !== 2) {
    process.stderr.write('codex_usage_invalid_arguments\n');
    return 1;
  }
  let report;
  try {
    report = collectCodexUsage(options.get('--codex-home'));
  } catch {
    process.stderr.write('codex_usage_collection_failed\n');
    return 1;
  }
  try {
    fs.mkdirSync(path.dirname(path.resolve(options.get('--output'))), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.get('--output'), `${JSON.stringify(report)}\n`, { mode: 0o600 });
  } catch {
    process.stderr.write('codex_usage_write_failed\n');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { collectCodexUsage, main };
