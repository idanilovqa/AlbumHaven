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
from `/artifacts/android/{stable|sandbox}/manifest.json` on `https://albumhaven.org`
(Update Manifest v1). Release builds trust the certificate given by
`-PalbumHavenStableCertificateSha256` or `-PalbumHavenSandboxCertificateSha256`
(SHA-256 of the DER signing certificate, lowercase hex) and offer no updates
without one; debug builds trust the debug signing key. A debug build may read
artifacts from a sandbox with `-PalbumHavenArtifactOrigin=https://sandboxN.albumhaven.org`.
`-PalbumHavenVersionCode` and `-PalbumHavenVersionName` override the version.
The server serves those artifacts from `ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR`.

The bridge needs an Android System WebView with `WEB_MESSAGE_LISTENER`. Older
providers, including the stock API-29 emulator image, get the Update required
screen and never load the site.
