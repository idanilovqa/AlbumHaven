const crypto = require('node:crypto');

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const RETAINED_ANCILLARY_CHUNKS = new Set(['tRNS']);
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxWidth: 3840,
  maxHeight: 3840,
  maxPixels: 3840 * 2160,
  maxChunks: 4096,
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_LIMITS)) assertPositiveLimit(limits[name], name);
  return limits;
}

function assertTrustedProvenance(provenance) {
  if (!provenance || provenance.trustedSameRepository !== true) {
    throw new Error('Public screenshots require trusted same-repository provenance');
  }
  if (provenance.fixtureMode !== 'synthetic') {
    throw new Error('Public screenshots require synthetic fixture provenance');
  }
  const sourceRunId = String(provenance.sourceRunId || '');
  const sourceRunAttempt = String(provenance.sourceRunAttempt || '');
  const reportRunId = String(provenance.reportRunId || '');
  const reportRunAttempt = String(provenance.reportRunAttempt || '');
  if (![sourceRunId, sourceRunAttempt, reportRunId, reportRunAttempt].every((value) => /^\d+$/.test(value))) {
    throw new Error('Screenshot provenance requires numeric run and attempt identities');
  }
  if (sourceRunId !== reportRunId || sourceRunAttempt !== reportRunAttempt) {
    throw new Error('Screenshot run and attempt mismatch');
  }
}

function assertValidIhdr(data, limits) {
  if (data.length !== 13) throw new Error('PNG IHDR must contain exactly 13 bytes');
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (width === 0 || height === 0) throw new Error('PNG dimensions must be nonzero');
  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw new Error('PNG exceeds maximum dimensions');
  }
  if (width * height > limits.maxPixels) throw new Error('PNG exceeds maximum pixel count');

  const bitDepth = data[8];
  const colorType = data[9];
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  if (!validDepths.get(colorType)?.has(bitDepth)) throw new Error('PNG IHDR has an invalid bit-depth/color-type combination');
  if (data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) {
    throw new Error('PNG IHDR uses unsupported compression, filter, or interlace settings');
  }
  return { width, height, colorType };
}

function assertChunkType(typeBytes) {
  if (typeBytes.length !== 4 || !/^[A-Za-z]{4}$/.test(typeBytes.toString('ascii')) || (typeBytes[2] & 0x20) !== 0) {
    throw new Error('PNG contains an invalid chunk type');
  }
}

function sanitizePublicFailureScreenshot(input, provenance, limitOverrides = {}) {
  assertTrustedProvenance(provenance);
  const limits = resolveLimits(limitOverrides);
  if (!Buffer.isBuffer(input)) throw new TypeError('PNG screenshot input must be a Buffer');
  if (input.length > limits.maxBytes) throw new Error('PNG exceeds maximum byte size');
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature');
  }

  const retained = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let ihdr = null;
  let paletteEntries = 0;
  let sawPalette = false;
  let sawTransparency = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;

  while (offset < input.length) {
    if (input.length - offset < 12) throw new Error('PNG chunk is truncated or corrupt');
    chunkCount += 1;
    if (chunkCount > limits.maxChunks) throw new Error('PNG exceeds maximum chunk count');

    const length = input.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > input.length) throw new Error('PNG chunk length exceeds input bounds');
    const typeBytes = input.subarray(offset + 4, offset + 8);
    assertChunkType(typeBytes);
    const type = typeBytes.toString('ascii');
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (expectedCrc !== actualCrc) throw new Error(`PNG CRC mismatch in ${type} chunk`);

    const isCritical = (typeBytes[0] & 0x20) === 0;
    if (isCritical && !CRITICAL_CHUNKS.has(type)) throw new Error(`PNG contains unknown critical chunk ${type}`);
    if (!ihdr && type !== 'IHDR') throw new Error('PNG IHDR must be the first chunk');
    if (sawIend) throw new Error('PNG contains trailing bytes after IEND');

    if (type === 'IHDR') {
      if (ihdr) throw new Error('PNG must contain exactly one IHDR chunk');
      if (chunkCount !== 1) throw new Error('PNG IHDR must be the first chunk');
      ihdr = assertValidIhdr(data, limits);
    } else if (type === 'PLTE') {
      if (sawPalette || sawIdat) throw new Error('PNG PLTE chunk is duplicated or out of order');
      if (ihdr.colorType === 0 || ihdr.colorType === 4 || length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error('PNG PLTE chunk is invalid for the image color type');
      }
      sawPalette = true;
      paletteEntries = length / 3;
    } else if (type === 'tRNS') {
      if (sawTransparency || sawIdat) throw new Error('PNG tRNS chunk is duplicated or out of order');
      const validLength = (ihdr.colorType === 0 && length === 2)
        || (ihdr.colorType === 2 && length === 6)
        || (ihdr.colorType === 3 && sawPalette && length > 0 && length <= paletteEntries);
      if (!validLength) throw new Error('PNG tRNS chunk is invalid for the image color type');
      sawTransparency = true;
    } else if (type === 'IDAT') {
      if (idatEnded) throw new Error('PNG IDAT chunks must be consecutive');
      if (ihdr.colorType === 3 && !sawPalette) throw new Error('Indexed-color PNG requires PLTE before IDAT');
      sawIdat = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !sawIdat) throw new Error('PNG IEND is invalid or precedes image data');
      sawIend = true;
    } else if (sawIdat) {
      idatEnded = true;
    }

    if (sawIdat && type !== 'IDAT' && type !== 'IEND') idatEnded = true;
    if (CRITICAL_CHUNKS.has(type) || RETAINED_ANCILLARY_CHUNKS.has(type)) {
      retained.push(input.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }

  if (!ihdr) throw new Error('PNG must contain exactly one IHDR chunk');
  if (!sawIdat) throw new Error('PNG must contain at least one IDAT chunk');
  if (!sawIend) throw new Error('PNG must contain exactly one IEND chunk');
  if (offset !== input.length) throw new Error('PNG contains trailing bytes after IEND');

  const bytes = Buffer.concat(retained);
  return {
    bytes,
    width: ihdr.width,
    height: ihdr.height,
    contentType: 'image/png',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

module.exports = { sanitizePublicFailureScreenshot };
