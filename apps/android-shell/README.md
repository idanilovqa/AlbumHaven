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
version.

The bridge needs an Android System WebView with `WEB_MESSAGE_LISTENER`. Older
providers, including the stock API-29 emulator image, get the Update required
screen and never load the site.
