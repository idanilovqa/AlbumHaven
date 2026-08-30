const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const sanitizerPath = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'sanitize-public-failure-screenshot.cjs');
const sanitizerExists = fs.existsSync(sanitizerPath);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function png({ width = 1, height = 1, metadata = true } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const chunks = [chunk('IHDR', ihdr)];
  if (metadata) chunks.push(chunk('tEXt', Buffer.from('OwnerPath=C:\\Users\\owner\\Music')));
  chunks.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ...chunks]);
}

function trustedProvenance() {
  return {
    trustedSameRepository: true, fixtureMode: 'synthetic', sourceRunId: '32837431728', sourceRunAttempt: '2',
    reportRunId: '32837431728', reportRunAttempt: '2',
  };
}

test('public failure screenshot sanitizer exists', () => {
  assert.equal(sanitizerExists, true, 'Missing public failure screenshot sanitizer');
});

test('sanitizer strips PNG metadata and preserves bounded image content', { skip: !sanitizerExists }, () => {
  const { sanitizePublicFailureScreenshot } = require(sanitizerPath);
  const source = png();
  assert.match(source.toString('latin1'), /OwnerPath/);
  const result = sanitizePublicFailureScreenshot(source, trustedProvenance());
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.sha256, crypto.createHash('sha256').update(result.bytes).digest('hex'));
  assert.doesNotMatch(result.bytes.toString('latin1'), /OwnerPath/);
  assert.match(result.bytes.toString('latin1'), /IHDR/);
  assert.match(result.bytes.toString('latin1'), /IDAT/);
  assert.match(result.bytes.toString('latin1'), /IEND/);
});

test('sanitizer rejects unsafe provenance and run-attempt mismatches', { skip: !sanitizerExists }, () => {
  const { sanitizePublicFailureScreenshot } = require(sanitizerPath);
  assert.throws(() => sanitizePublicFailureScreenshot(png(), { ...trustedProvenance(), trustedSameRepository: false }), /trusted same-repository/i);
  assert.throws(() => sanitizePublicFailureScreenshot(png(), { ...trustedProvenance(), fixtureMode: 'owner-library' }), /synthetic fixture/i);
  assert.throws(() => sanitizePublicFailureScreenshot(png(), { ...trustedProvenance(), sourceRunAttempt: '3' }), /run.*attempt.*mismatch/i);
});

test('sanitizer rejects malformed, corrupt, oversized, and over-dimension PNG inputs', { skip: !sanitizerExists }, () => {
  const { sanitizePublicFailureScreenshot } = require(sanitizerPath);
  assert.throws(() => sanitizePublicFailureScreenshot(Buffer.from('not png'), trustedProvenance()), /PNG signature/i);
  const corrupt = png();
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.throws(() => sanitizePublicFailureScreenshot(corrupt, trustedProvenance()), /CRC|corrupt/i);
  assert.throws(() => sanitizePublicFailureScreenshot(png(), trustedProvenance(), { maxBytes: 20 }), /maximum byte size/i);
  assert.throws(() => sanitizePublicFailureScreenshot(png({ width: 4000 }), trustedProvenance(), { maxWidth: 3840 }), /maximum dimensions/i);
});
