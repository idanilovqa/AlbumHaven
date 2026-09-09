#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const CODES = new Map([
  ['insufficient_quota', 'provider_quota_reported'], ['invalid_api_key', 'authentication_failed'],
  ['authentication_error', 'authentication_failed'], ['rate_limit_exceeded', 'rate_limited'],
  ['context_length_exceeded', 'context_limit'], ['connection_error', 'transport_failure'],
]);
function nativeMessageCategory(message) {
  if (/^(?:Quota exceeded\. Check your plan and billing details\.|You exceeded your current quota, please check your plan and billing details\.)/.test(message)) return 'provider_quota_reported';
  if (/^Incorrect API key provided:/.test(message)) return 'authentication_failed';
  if (/^(?:Rate limit reached for |rate limit exceeded:)/.test(message)) return 'rate_limited';
  if (/^(?:Your input exceeds the context window of this model\.|This model's maximum context length is |Codex ran out of room in the model's context window\.)/.test(message)) return 'context_limit';
  if (/^(?:Connection failed:|Error while reading the server response:|stream disconnected before completion:)/.test(message)
      || message === 'request timed out'
      || /^error sending request for url \([^\r\n]+\)$/.test(message)) return 'transport_failure';
  return 'unknown';
}
function firstJsonObject(text) {
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      const suffix = text.slice(index + 1).trim();
      if (suffix && !/^,\s*(?:url|cf-ray|request id|auth error(?: code)?):[^\r\n]*$/.test(suffix)) {
        throw new Error('Unrecognized provider error suffix.');
      }
      return JSON.parse(text.slice(0, index + 1));
    }
  }
  throw new Error('Incomplete provider error object.');
}
function category(error, depth = 0) {
  if (depth > 4) return 'unknown';
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'unknown';
  if (error.code !== undefined) return CODES.get(error.code) || 'unknown';
  const message = error.message;
  if (typeof message !== 'string' || message.length > 65536) return 'unknown';
  const native = nativeMessageCategory(message);
  if (native !== 'unknown') return native;
  const status = message.match(/^(?:unexpected status |exceeded retry limit, last status: )(\d{3})\b([\s\S]*)$/);
  if (status) {
    // The pinned formatter may extract the provider message, or retain a JSON
    // body followed by URL/request metadata. Metadata is never printed.
    const body = status[2].replace(/^[^:]*:\s*/, '').trim();
    const extracted = nativeMessageCategory(body);
    if (extracted !== 'unknown') return extracted;
    if (body.startsWith('{')) {
      try { return category(firstJsonObject(body).error, depth + 1); }
      catch { return 'unknown'; }
    }
    if (body.includes('{')) return 'unknown';
    if (/^(?:401|403)$/.test(status[1])) return 'authentication_failed';
    if (status[1] === '429') return 'rate_limited';
    return 'unknown';
  }
  return 'unknown';
}
function classifyOutput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CAPTURE_BYTES) return 'unknown';
  const observed = new Set();
  for (const line of text.split(/\r?\n/)) {
    // JSON mode never prints human role sections or unescaped message fences.
    if (/^(?:user|assistant|codex|thinking|exec)$/.test(line) || /^\s*```/.test(line)) return 'unknown';
    if (!line.startsWith('{')) continue; // Official action preamble/stack footer.
    let event;
    try { event = JSON.parse(line); } catch { return 'unknown'; }
    // Only native error events are diagnostic authority. Agent/tool messages
    // stay nested in item events; never parse their arbitrary text recursively.
    if (event?.type === 'error') observed.add(category(event));
    if (event?.type === 'turn.failed') observed.add(category(event.error));
  }
  return observed.size === 1 ? [...observed][0] : 'unknown';
}
function withJsonOutput(value) {
  const args = typeof value === 'string' && value.trim() === '' ? [] : JSON.parse(value);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('Invalid Codex argument array.');
  }
  return JSON.stringify(args.includes('--json') ? args : [...args, '--json']);
}
function classifyFile(input) {
  let descriptor;
  try {
    const filename = path.resolve(input);
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(filename) !== filename
        || before.size > MAX_CAPTURE_BYTES) return 'unknown';
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) return 'unknown';
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) return 'unknown';
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) || fs.fstatSync(descriptor).size !== stat.size) return 'unknown';
    return classifyOutput(bytes.toString('utf8'));
  } catch { return 'unknown'; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
if (require.main === module) {
  if (process.argv.length === 4 && process.argv[2] === '--json-args') {
    try { process.stdout.write(withJsonOutput(process.argv[3])); }
    catch { process.exitCode = 1; }
  } else {
  let result = 'unknown';
  try {
    if (process.argv.length === 4 && process.argv[2] === '--input') result = classifyFile(process.argv[3]);
  } catch { /* Public diagnostics never contain filesystem or provider errors. */ }
  process.stdout.write(result + '\n');
  }
}
module.exports = { classifyOutput, classifyFile, withJsonOutput, MAX_CAPTURE_BYTES };
