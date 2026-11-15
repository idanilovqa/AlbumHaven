# Bundled audio decoders

These unmodified builds decode streamed audio in every client.

| File | Package | Version | Wrapper license | Decoder library |
|---|---|---|---|---|
| `mpg123-decoder.min.js` | `mpg123-decoder` | 1.0.3 | MIT | mpg123, LGPL-2.1 |
| `flac-decoder.min.js` | `@wasm-audio-decoders/flac` | 0.2.11 | MIT | libFLAC, BSD-3-Clause |

Source: <https://github.com/eshaz/wasm-audio-decoders> and <https://www.mpg123.de/>.
The full license for mpg123 is in `LICENSE-LGPL-2.1.txt`.
Each file loads separately, so it can be replaced with a compatible build.
Only the trailing source map comment was removed.
