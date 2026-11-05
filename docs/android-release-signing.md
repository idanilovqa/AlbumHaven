# Android release signing and promotion

Pull requests build unsigned APKs only and keep just their SHA-256 checksums as
evidence; the APKs are never uploaded because the repository is public.
Installable APKs come from the
`android-promote` workflow, which promotes one exact commit to one channel
(`stable` or `sandbox`). It deploys nothing: its output is a data artifact that
the outbound-only synchronizer in the private deployments repository verifies
and publishes into `ALBUM_HAVEN_ANDROID_ARTIFACTS_DIR` (see
`docs/android-update-artifacts.md`).

## What a promotion does

1. **Verify** (no secrets). The workflow must run from `main`. The commit must
   be 40 lowercase hex characters, exist in this repository, and have a
   successful `PR Gates` pull-request run for exactly that head whose
   `Cloud Verification Gate` job succeeded. That gate fails for focused,
   `skip_tests`, draft and fork runs, so it is the complete-pipeline proof.
   The pipeline's Android jobs build and test that exact head commit, not the
   pull request's merge with its base, so they verified the sources promotion
   builds.
   Stable also needs the published GitHub release `v<RELEASE_VERSION>` from the
   commit's `version.py`: not a draft or prerelease, published by the repository
   owner, with release notes, a matching `CHANGELOG.md` section, and a tagged
   tree identical to the promoted commit's tree (promote the up-to-date pull
   request head that became the release). The release page is the manifest's
   `releaseNotesUrl`; sandbox uses the commit page.
2. **Allocate.** Version codes are recorded as tags `android/<channel>/<code>`
   pointing at the promoted commit. The next code is one more than the highest
   such tag (or `ANDROID_VERSION_CODE_FLOOR`, when set). The workflow's
   `concurrency` group `android-promote-<channel>` runs one promotion per channel
   at a time, and tag creation fails if the code already exists, so codes never
   repeat or decrease. Stable `versionName` is the Album Haven semver; sandbox is
   `<semver>-sandbox.<first 7 hex of the commit>`.
3. **Build** (no secrets, no Gradle cache). Checks out exactly that commit and
   runs `assemble<Channel>Release` with the allocated version and the channel's
   certificate digest compiled in as the update trust. The unsigned APK is
   encrypted to the signing environment's X25519 key
   (`ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY`) and only that ciphertext is uploaded,
   as `android-unsigned-<channel>-<code>` (1-day retention).
4. **Sign** in the protected environment `android-<channel>`, which waits for
   approval. The job has read-only repository access, never runs the promoted
   source and installs nothing: it decrypts the unsigned APK with the
   environment secret `ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY`, aligns it, signs it
   with the runner image's preinstalled build-tools 36.0.0 `apksigner` using the
   channel keystore from the environment secrets, confirms the single signer,
   package, version and minimum SDK, and writes the Update Manifest v1 and the
   APK encrypted to the synchronizer's key (`android-signed-<channel>-<code>`,
   1-day retention).
5. **Record.** A separate job, the only one with `contents: write` and without
   secrets, creates the version tag and only then uploads the workflow artifact
   `android-promotion-<channel>-<code>` (90-day retention): `promotion.json`
   (repository, workflow, run, pipeline run, version tag and manifest) and
   `<apk>.enc`, the APK encrypted to the synchronizer's X25519 key
   (HKDF-SHA256, AES-256-GCM).
6. **Clean up.** A last job (`actions: write` only) deletes both intermediate
   artifacts, whether or not the promotion succeeded.

No APK, signed or unsigned, is ever uploaded in plaintext. Every action in the
workflow is pinned to a full commit SHA.

Why a workflow artifact, not a GitHub release asset: this repository is public,
and release assets are downloadable by anyone, while the owner requires that
builds are not public. Workflow artifacts of a public repository can be
downloaded by any signed-in GitHub user, so every artifact that holds an APK is
encrypted: the intermediate one to the signing environment, the promotion
artifact to the deployment host. The durable records are the version tags and
the published manifests on the server, not the artifact.

The manifest's `apkUrl` uses `https://albumhaven.org`. A synchronizer target
that serves a sandbox origin rebinds only that URL's origin to its own;
every other field is published unchanged.

## One-time owner setup, in order

1. **Keystores.** On a trusted machine, outside every Git checkout:

   ```powershell
   .\scripts\android\New-AndroidReleaseKeystores.ps1 -OutputDirectory D:\album-haven-signing
   ```

   It prompts for two different passwords (16+ characters), writes
   `album-haven-stable.p12` and `album-haven-sandbox.p12` (RSA 4096, 10,000-day
   certificates, aliases `album-haven-stable`/`album-haven-sandbox`) and their
   public `.cer` files, never overwrites a keystore, and prints only the two
   certificate SHA-256 values.
2. **Backups.** Before anything else, keep at least two offline copies of each
   `.p12` (for example two encrypted USB drives in different places) and store
   each password in the password manager. A lost stable key means installed apps
   can never be updated again (Android refuses a different signer); a leaked key
   lets someone else sign updates. The keys stay separate: never sign stable with
   the sandbox key.
3. **Synchronizer key.** On the deployment host, generate the artifact recipient
   key with the synchronizer's `keygen` command and keep its printed public key.
4. **Signer key.** On a trusted machine, generate the key the build job
   encrypts the unsigned APK to. It writes the private key, base64 of the raw
   32-byte X25519 key, to a new file only and prints the public key:

   ```powershell
   node scripts/ci/android-promotion.cjs keygen --private-key=D:\album-haven-signing\android-signer.key
   ```

5. **Repository variables** (Settings > Secrets and variables > Actions >
   Variables; these are public values):
   - `ANDROID_STABLE_SIGNING_CERT_SHA256`, `ANDROID_SANDBOX_SIGNING_CERT_SHA256`
   - `ANDROID_ARTIFACT_RECIPIENT_PUBLIC_KEY`
   - `ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY`, the public key the signer `keygen`
     printed (44 base64 characters)
   - optional `ANDROID_VERSION_CODE_FLOOR`, the highest version code already
     installed anywhere from earlier manual test builds.
6. **Environments** `android-stable` and `android-sandbox` (Settings >
   Environments): required reviewer the owner, deployment branches `main` only,
   and these environment secrets, set without printing them:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\album-haven-signing\album-haven-stable.p12')) |
       gh secret set ANDROID_KEYSTORE_BASE64 --env android-stable --repo idanilovqa/AlbumHaven
   gh secret set ANDROID_KEYSTORE_PASSWORD --env android-stable --repo idanilovqa/AlbumHaven
   Get-Content -Raw D:\album-haven-signing\android-signer.key |
       gh secret set ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY --env android-stable --repo idanilovqa/AlbumHaven
   ```

   (`gh secret set` without `--body` prompts for the password.) Repeat with the
   sandbox keystore and the same signer key for `android-sandbox`, then delete
   `android-signer.key` (a lost signer key is replaced by generating a new pair).
7. **Tag protection.** Add a tag ruleset for `android/**` that blocks updates
   and deletions, so allocated codes stay recorded.
8. **Server trust.** Set `ALBUM_HAVEN_ANDROID_STABLE_SIGNING_CERT_SHA256` and
   `ALBUM_HAVEN_ANDROID_SANDBOX_SIGNING_CERT_SHA256` on the servers to the same
   digests, and configure the synchronizer with them.

## Promoting

```powershell
gh workflow run android-promote.yml --repo idanilovqa/AlbumHaven -f commit=<40-hex sha> -f channel=sandbox
```

Approve the `android-<channel>` deployment when the sign job waits. Promote and
accept sandbox before stable.

## Web and APK release order

Production web releases support the latest and the immediately previous stable
APK. `tests/fixtures/android-bridge/stable-shells.json` records both: version
code, source commit, bridge protocol range and stable capabilities. Sandbox may
require its latest promoted APK.

The JavaScript job of every pull request runs
`scripts/ci/android-release-compatibility.cjs`, which records one class in the
job summary:

| Class | Meaning | Release |
| --- | --- | --- |
| `web-only` | No bridge use, bridge contract or APK route changed. | Deploy the web. |
| `existing-bridge` | Bridge web code, the stable record or a route the APK calls changed, using capabilities the latest stable APK has. | Deploy the web after the latest and previous stable fixture tests pass. |
| `native-impact` | Shell or native source, a shared contract fixture or the bridge protocol range changed, or the site uses a capability the latest stable APK lacks. | Promote and accept a sandbox APK; publish stable before the web relies on it. |

The same step fails the pull request when the latest or the previous stable APK
cannot run the site: no shared bridge protocol, or a capability the site marks
`required` in the `capabilities` of the bridge policy (the JSON block between
the `android-bridge-policy` markers in `android-bridge-client.js`, which the
step reads as data) is
missing from either. A capability marked `optional` may ship first; the site
hides that feature until the shell advertises it. A shell missing a required
capability refuses the handshake and shows its Update required screen.

To make web code depend on a new capability:

1. Add the capability to the shell and gate the web feature on it (`optional`).
2. Promote and accept a sandbox APK, then promote and publish stable.
3. Record that promotion in `stable-shells.json`: the new APK becomes `latest`
   and the old `latest` becomes `previous`. CI checks each promoted entry
   against its `android/stable/<code>` tag, that commit's fixture capabilities
   and its bridge range, and fails while the record still describes unpromoted
   shells after a stable tag exists.
4. Only once both recorded shells have the capability may the site mark it
   `required`.

A new bridge protocol adds `tests/fixtures/android-bridge/v<N>.json`. The site
keeps the previous stable protocol in its range until that APK leaves the
record.

## Rollback

Roll forward only: promote the last good commit again. It receives a higher
version code, and devices update to it. Android packages are never downgraded.
