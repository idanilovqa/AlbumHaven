# Album Haven Android shell

A minimal Kotlin WebView client for the existing responsive site. Stable loads
only `https://albumhaven.org`; Sandbox selects one `https://sandboxN.albumhaven.org`
origin from inside Settings. Both can be installed side by side.

Requires JDK 17 and Android SDK platform 36.

```bash
./gradlew testStableDebugUnitTest testSandboxDebugUnitTest
./gradlew assembleStableDebug assembleSandboxDebug
```

Debug builds can target a local server with
`-PalbumHavenDevOrigin=http://localhost:5000`. Release builds ignore it.
Instrumented tests expect `-PalbumHavenDevOrigin=http://127.0.0.1:18765`.

Settings > Android app checks for, downloads, verifies and installs updates
from `/artifacts/android/{stable|sandbox}/manifest.json` (Update Manifest v1) on
the origin the app is signed in to: `https://albumhaven.org` for Stable, the
selected sandbox for Sandbox. Artifacts are not public. The app sends its WebView
session and proves itself with an Android Keystore key attested by the device's
hardware (see `docs/android-update-artifacts.md`). Release builds trust the
certificate given by `-PalbumHavenStableCertificateSha256` or
`-PalbumHavenSandboxCertificateSha256` (SHA-256 of the DER signing certificate,
lowercase hex) and offer no updates without one; debug builds trust the debug
signing key. `-PalbumHavenVersionCode` and `-PalbumHavenVersionName` override the
version. Pull requests build unsigned APKs but upload only their checksums,
never the APKs; signed releases come only from
the `android-promote` workflow (see `docs/android-release-signing.md`).

The bridge needs an Android System WebView with `WEB_MESSAGE_LISTENER`. Older
providers, including the stock API-29 emulator image, get the Update required
screen without an action and never load the site.

A site the app cannot run (no shared bridge protocol, or a capability it names in
the handshake's `requiredCapabilities` that this build lacks) is refused and
covered by the Update required screen. Its Check for update checks for an APK
whose bridge range includes the site's; Download update downloads the one it
finds, and Update hands it to Android as Settings does. Release ordering is in
`docs/android-release-signing.md`.

Downloads never carry the WebView session, because Android's Download Manager
keeps its requests in its own database. For a same-origin download the app asks
the page for a five-minute link (`downloads.link.v1`), which the page requests
from `POST /downloads/links` with its own session, and enqueues that link alone;
a path the server refuses shows "Download unavailable". Files the page builds
itself, such as Log History exports, reach the app as base64 chunks
(`files.save.v1`, at most 10 MB) and are written to Downloads through MediaStore.
