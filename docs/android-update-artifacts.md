# Android update artifacts

The Android app updates itself from `/artifacts/android/{stable|sandbox}/` on the
origin it is signed in to (`https://albumhaven.org` for Stable, the selected
`https://sandboxN.albumhaven.org` for Sandbox). Nothing under that prefix is
public: a browser, `curl` or a script without the app gets the normal sign-in
refusal, and a signed-in browser gets no manifest or APK without a device key.

Artifacts are produced by the `android-promote` workflow and placed in the
directory by the deployment synchronizer; see `docs/android-release-signing.md`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR` | Directory with `stable/` and `sandbox/`, each holding `manifest.json` and flat `*.apk` files. Unset serves nothing. |
| `ALBUM_HAVEN_ANDROID_STABLE_SIGNING_CERT_SHA256` | Comma-separated hex SHA-256 (either case, keytool's `AB:CD:...` colons allowed) of the DER signing certificates whose Stable app (`org.albumhaven.app`) may attest. Empty refuses Stable. |
| `ALBUM_HAVEN_ANDROID_SANDBOX_SIGNING_CERT_SHA256` | The same for the Sandbox app (`org.albumhaven.app.sandbox`). |
| `ALBUM_HAVEN_ANDROID_SANDBOX_ALLOW_SOFTWARE_ATTESTATION` | `1` lets a sandbox server accept software-backed Sandbox keys, for emulators and debug testing only. Off by default; never applies to Stable. |
| `ALBUM_HAVEN_ANDROID_ATTESTATION_STATUS_FILE` | Optional local copy of Google's attestation status list. When set but unreadable, attestation fails closed. |

Certificate digests are public values, not secrets: they are the same as the
manifest's `signingCertificateSha256`. Download links are signed with a key
derived from the existing authentication HMAC secret; no new secret is needed.
Apply migrations `0106_create_android_artifact_access.sql` and
`0107_add_android_device_key_signer.sql` before starting a version that serves
these routes, and restart the server after changing any of these variables.
Removing a signing-certificate digest, or turning the software flag off, revokes
the device keys it admitted at their next request or download.

## Protocol

All requests below except the download link carry the app's WebView session
cookie; POSTs also carry the session CSRF header. The route action is
`account.self.android_updates`, so any signed-in, active account may use it.

1. `POST /artifacts/android/challenge` `{"protocol":1,"channel","purpose"}` with
   purpose `attest` or `request` returns a 32-byte single-use challenge bound to
   the account, session, channel and purpose, valid for two minutes. Only its
   SHA-256 is stored. Each account may hold sixteen open challenges.
2. `POST /artifacts/android/attest` `{"protocol":1,"channel","challenge","chain"}`.
   The app generates an EC P-256 signing key in Android Keystore (StrongBox when
   present, otherwise TEE) with the challenge as its attestation challenge and
   sends the certificate chain (leaf first, base64 DER). The server requires that
   every certificate is signed by the next one and only certificate authorities
   issue; issuers are within their validity period; no certificate is on the
   status list; the chain ends at a pinned Google hardware attestation root; only
   the leaf carries the attestation extension; its challenge matches; its
   `attestationApplicationId` names exactly the channel's package with an allowed
   signing-certificate digest; its attestation security level is TEE or StrongBox
   and equals its KeyMint security level;
   its hardware-enforced `rootOfTrust` reports `deviceLocked` true and
   `verifiedBootState` Verified; and the key is P-256. The package and signer come
   from the Android framework, so they are believed only on a locked, verified
   boot: an unlocked or rooted device, or a custom ROM, is refused. The public key,
   its security level and the matched signing-certificate digest are stored per
   account and channel, and the response names the key with a `deviceKey` id.
3. `GET /artifacts/android/{channel}/manifest.json` and `POST` to the manifest's
   `apkUrl` carry `X-Album-Haven-Device-Key`, a fresh `request` challenge in
   `X-Album-Haven-Challenge`, and `X-Album-Haven-Signature`: base64 ECDSA-SHA256
   over `album-haven-android-artifact-request-v1`, the method, the path, the
   challenge and the hex SHA-256 of the (empty) body, joined by newlines. Each
   request also rechecks that the key's signing certificate is still allowed and,
   for a software key, that the sandbox flag is still on. The `POST` must have
   an empty body.
4. The `POST` returns `{"path":"/artifacts/android/download/<token>"}`: a
   five-minute HMAC link naming one account, device key, channel and file. The app
   checks it with `HEAD` and hands it to `DownloadManager`, which needs no cookies.
   The link stops working when it expires, the device key is removed or no longer
   allowed by the configuration, or the account is deactivated. The manifest's `apkUrl` remains the immutable logical
   URL.

Refusals are JSON `{"detail","code"}`: `signed_out` (401 from the boundary),
`invalid_request` (400: malformed JSON, channel or chain, or a non-empty exchange body),
`attestation_unavailable` (503: the configured status list is unreadable or the link secret
is missing), `challenge_invalid`, `attestation_required` (the server does not know this key, or
the configuration no longer allows it; the app attests a new one), `signature_invalid`, `attestation_refused` and
`too_many_challenges`. They never echo tokens, challenges or paths. The server's
access log records download links as `/artifacts/android/download/[redacted]`.

## Google roots and revocation

`music_app/services/android_attestation_roots.pem` bundles the roots published at
<https://android.googleapis.com/attestation/root> (linked from the Android key
attestation documentation) and pins them by public key. To update it, fetch that
URL, replace the PEM blocks and run `tests/py/test_android_key_attestation.py`.

Google publishes revoked attestation certificates at
<https://android.googleapis.com/attestation/status>. The server makes no outbound
request; to check revocation, refresh a local copy (for example daily) and set
`ALBUM_HAVEN_ANDROID_ATTESTATION_STATUS_FILE`.

## Limitations

- A device key's chain and boot state are checked once, at attestation; a later
  revocation of its chain, or unlocking the bootloader afterwards, is not
  re-checked (unlocking wipes the device's keys). Remove an account's rows from
  `app.android_device_keys` to force re-attestation. Keys attested before
  migration `0107` have no recorded signer and must attest again.
- Software attestation proves nothing: the AOSP software attestation key is
  public, and software keys report no verified boot. Enable the sandbox flag only
  on test sandboxes.
- A signed-in user who controls an attested device can still save the APK it
  downloads, and a valid download link works from anywhere for five minutes.
  Front-end proxies may log the full link; keep their access logs private or
  short-lived.
