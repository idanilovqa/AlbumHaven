# Bundled audio decoders

The Android app decodes streamed audio with the same libraries as the web player's pinned builds
(music_app/static/vendor/wasm-audio-decoders/NOTICE.md).

| Library | Commit | License |
|---|---|---|
| mpg123 (`libahmpg123.so`, its own shared library) | `08247b317163175e62035893af3ff9e71a5dfefd` | LGPL-2.1, `mpg123-LGPL-2.1.txt` |
| libFLAC (in `libahdecoders.so`) | `1507800de4b70e21be71f38caa0d9079d0bc6e45` | BSD-3-Clause, `libFLAC-BSD-3-Clause.txt` |

Sources: <https://www.mpg123.de/> (mirror <https://github.com/madebr/mpg123>) and <https://github.com/xiph/flac>.
The unmodified library sources are in `apps/android-shell/playback-engine/src/main/cpp/third_party`.
