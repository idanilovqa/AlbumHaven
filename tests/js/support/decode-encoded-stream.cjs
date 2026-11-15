// Decodes the bytes a stream would send with the shipped decoder build, for conformance tests.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

// The browser builds name a worker package that synchronous decoding never touches.
const moduleRequire = Module.prototype.require;
Module.prototype.require = function requireDecoderDependency(id) {
  return id === '@eshaz/web-worker' ? class {} : moduleRequire.call(this, id);
};

const VENDOR_DIR = path.join(__dirname, '../../../music_app/static/vendor/wasm-audio-decoders');
const BUILDS = {
  mp3: { file: 'mpg123-decoder.min.js', className: 'MPEGDecoder' },
  flac: { file: 'flac-decoder.min.js', className: 'FLACDecoder' },
};

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const build = BUILDS[request.codec];
  const Decoder = require(path.join(VENDOR_DIR, build.file))[build.className];
  const decoder = new Decoder();
  await decoder.ready;
  const bytes = fs.readFileSync(request.bytesPath);
  const left = [];
  const keep = async (output) => {
    if (output?.samplesDecoded) left.push(Float32Array.from(output.channelData[0]));
  };
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    await keep(await decoder.decode(bytes.subarray(offset, offset + 65_536)));
  }
  await keep(await decoder.flush?.());
  decoder.free();
  const frames = left.reduce((total, part) => total + part.length, 0);
  const output = Buffer.alloc(frames * 4);
  let written = 0;
  for (const part of left) {
    Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(output, written);
    written += part.byteLength;
  }
  fs.writeFileSync(request.outputPath, output);
  process.stdout.write(JSON.stringify({ frames }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
