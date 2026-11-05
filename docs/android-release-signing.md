# Android release signing and promotion

Pull requests build unsigned evidence APKs only. Installable APKs come from the
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
   certificate digest compiled in as the update trust.
4. **Sign** in the protected environment `android-<channel>`, which waits for
   approval. This job never runs the promoted source: it aligns the unsigned APK,
   signs it with `apksigner` using the channel keystore from the environment
   secrets, confirms the single signer, package, version and minimum SDK,
   writes the Update Manifest v1 and creates the version tag.
5. **Record.** Uploads the workflow artifact `android-promotion-<channel>-<code>`
   (90-day retention): `promotion.json` (repository, workflow, run, pipeline run,
   version tag and manifest) and `<apk>.enc`, the APK encrypted to the
   synchronizer's X25519 key (HKDF-SHA256, AES-256-GCM). The plaintext signed APK
   is never uploaded.

Why a workflow artifact, not a GitHub release asset: this repository is public,
and release assets are downloadable by anyone, while the owner requires that
builds are not public. Workflow artifacts are immutable once uploaded and need
a GitHub token to download; encryption keeps the APK readable only by the
deployment host. The durable records are the version tags and the published
manifests on the server, not the artifact.

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
4. **Repository variables** (Settings > Secrets and variables > Actions >
   Variables; these are public values):
   - `ANDROID_STABLE_SIGNING_CERT_SHA256`, `ANDROID_SANDBOX_SIGNING_CERT_SHA256`
   - `ANDROID_ARTIFACT_RECIPIENT_PUBLIC_KEY`
   - optional `ANDROID_VERSION_CODE_FLOOR`, the highest version code already
     installed anywhere from earlier manual test builds.
5. **Environments** `android-stable` and `android-sandbox` (Settings >
   Environments): required reviewer the owner, deployment branches `main` only,
   and these environment secrets, set without printing them:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\album-haven-signing\album-haven-stable.p12')) |
       gh secret set ANDROID_KEYSTORE_BASE64 --env android-stable --repo idanilovqa/AlbumHaven
   gh secret set ANDROID_KEYSTORE_PASSWORD --env android-stable --repo idanilovqa/AlbumHaven
   ```

   (`gh secret set` without `--body` prompts for the password.) Repeat with the
   sandbox keystore for `android-sandbox`.
6. **Tag protection.** Add a tag ruleset for `android/**` that blocks updates
   and deletions, so allocated codes stay recorded.
7. **Server trust.** Set `ALBUM_HAVEN_ANDROID_STABLE_SIGNING_CERT_SHA256` and
   `ALBUM_HAVEN_ANDROID_SANDBOX_SIGNING_CERT_SHA256` on the servers to the same
   digests, and configure the synchronizer with them.

## Promoting

```powershell
gh workflow run android-promote.yml --repo idanilovqa/AlbumHaven -f commit=<40-hex sha> -f channel=sandbox
```

Approve the `android-<channel>` deployment when the sign job waits. Promote and
accept sandbox before stable.

## Rollback

Roll forward only: promote the last good commit again. It receives a higher
version code, and devices update to it. Android packages are never downgraded.
