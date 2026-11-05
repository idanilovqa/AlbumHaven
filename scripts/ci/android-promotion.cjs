// Shared logic for .github/workflows/android-promote.yml: verifies a commit's complete pipeline
// and stable release, allocates the channel's next version code, carries the unsigned APK to the
// signing job encrypted to the signing environment's key, and turns the signed APK into an Update
// Manifest v1 plus an APK encrypted to the deployment synchronizer's key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHANNELS = Object.freeze({
  stable: Object.freeze({ applicationId: 'org.albumhaven.app', flavor: 'Stable' }),
  sandbox: Object.freeze({ applicationId: 'org.albumhaven.app.sandbox', flavor: 'Sandbox' }),
});
// The canonical artifact host. The synchronizer may bind apkUrl to the origin of the server it
// publishes into (a sandbox's own origin); every other manifest field is published unchanged.
const ARTIFACT_ORIGIN = 'https://albumhaven.org';
const PIPELINE_WORKFLOW = '.github/workflows/pr-gates.yml';
const PROMOTE_WORKFLOW = '.github/workflows/android-promote.yml';
const PIPELINE_GATE_JOB = 'Cloud Verification Gate';
const MIN_ANDROID_API = 29;
const MAX_VERSION_CODE = 2_100_000_000;
const MAX_APK_BYTES = 200 * 1024 * 1024;
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'channel', 'applicationId', 'versionCode', 'versionName', 'sourceCommit',
  'apkUrl', 'apkSize', 'sha256', 'signingCertificateSha256', 'minAndroidApi',
  'bridgeProtocolMin', 'bridgeProtocolMax', 'publishedAt', 'releaseNotesUrl',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const SANDBOX_VERSION = /^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})-sandbox\.([0-9a-f]{7,12})$/;
const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const APK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/;
// Encrypted APK: magic, ephemeral X25519 public key, AES-256-GCM nonce, ciphertext, tag.
const ENCRYPTION_MAGIC = Buffer.from('AHAPKv1\n', 'ascii');
const ENCRYPTION_INFO = Buffer.from('album-haven-android-apk-v1', 'ascii');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function fail(message) {
  throw new Error(message);
}

function requireChannel(channel) {
  if (!Object.hasOwn(CHANNELS, channel)) fail(`Channel must be stable or sandbox, got: ${JSON.stringify(channel)}`);
  return channel;
}

function requireCommit(commit) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) fail('Commit must be exactly 40 lowercase hexadecimal characters');
  return commit;
}

function versionTag(channel, versionCode) {
  return `android/${requireChannel(channel)}/${versionCode}`;
}

function apkName(channel, versionCode) {
  return `album-haven-${requireChannel(channel)}-${versionCode}.apk`;
}

/** The highest version code recorded by a channel's promotion tags, plus one. */
function nextVersionCode(tagNames, channel, floor = 0) {
  requireChannel(channel);
  if (!Number.isSafeInteger(floor) || floor < 0) fail('Version code floor must be a non-negative integer');
  const pattern = new RegExp(`^android/${channel}/([1-9]\\d{0,9})$`);
  const highest = tagNames.reduce((max, name) => {
    const match = pattern.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const next = Math.max(highest, floor) + 1;
  if (next > MAX_VERSION_CODE) fail('Version code space is exhausted');
  return next;
}

function readReleaseVersion(versionPy) {
  const match = /^RELEASE_VERSION = "([^"]+)"[ \t]*\r?$/m.exec(versionPy);
  if (!match || !SEMVER.test(match[1])) fail('version.py has no major.minor.patch RELEASE_VERSION');
  return match[1];
}

function versionNameFor(channel, releaseVersion, commit) {
  requireChannel(channel);
  if (!SEMVER.test(releaseVersion)) fail('Release version must be major.minor.patch');
  return channel === 'stable' ? releaseVersion : `${releaseVersion}-sandbox.${requireCommit(commit).slice(0, 7)}`;
}

/** Stable is Album Haven semver; sandbox appends `-sandbox.<short-sha>` of its own commit. */
function versionNameMatches(name, channel, commit) {
  if (channel === 'stable') return SEMVER.test(name);
  const match = SANDBOX_VERSION.exec(name);
  return Boolean(match) && commit.startsWith(match[1]);
}

function readBridgeRange(bridgeControllerKt) {
  const read = (name) => {
    const match = new RegExp(`const val ${name} = (\\d+)\\b`).exec(bridgeControllerKt);
    return match ? Number(match[1]) : fail(`BridgeController.kt has no ${name}`);
  };
  const min = read('PROTOCOL_MIN');
  const max = read('PROTOCOL_MAX');
  if (min < 1 || max < min || max > 1000) fail('Bridge protocol range is invalid');
  return { min, max };
}

function hasChangelogSection(changelog, releaseVersion) {
  const escaped = releaseVersion.replaceAll('.', '\\.');
  return new RegExp(`^##\\s+${escaped}\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, 'm').test(changelog);
}

/**
 * Stable promotion needs the published Album Haven release for the commit's own version: tag
 * `v<version>`, not a draft or prerelease, published by the repository owner, with release
 * notes, whose tagged tree is exactly the promoted commit's tree.
 */
function checkStableRelease({ release, releaseVersion, owner, sourceTree, releaseTree, changelog }) {
  const errors = [];
  if (!release) return { errors: [`No published Album Haven release v${releaseVersion}`] };
  if (release.tag_name !== `v${releaseVersion}`) errors.push(`Release tag ${release.tag_name} does not match v${releaseVersion}`);
  if (release.draft) errors.push('Release is a draft');
  if (release.prerelease) errors.push('Release is a prerelease');
  if (release.author?.login !== owner) errors.push('Release was not published by the repository owner');
  if (!String(release.body || '').trim()) errors.push('Release has no release notes');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/[^/?#]+$/.test(String(release.html_url || ''))) {
    errors.push('Release has no release-notes URL');
  }
  if (!COMMIT.test(String(sourceTree)) || sourceTree !== releaseTree) {
    errors.push('Promoted commit tree differs from the release tag tree');
  }
  if (!hasChangelogSection(changelog, releaseVersion)) errors.push(`CHANGELOG.md has no ${releaseVersion} section`);
  return { errors, releaseNotesUrl: errors.length ? undefined : release.html_url };
}

/**
 * A commit's complete pipeline: a successful PR Gates run for exactly that head in this
 * repository whose Cloud Verification Gate job succeeded. The gate fails in focused, skipped-test,
 * draft and fork runs, so a green gate is the authoritative full-pipeline conclusion.
 */
async function findCompletePipelineRun({ listRuns, listJobs, repository, commit }) {
  requireCommit(commit);
  const runs = (await listRuns()).filter((run) => run.path === PIPELINE_WORKFLOW
    && run.head_sha === commit
    && run.event === 'pull_request'
    && run.status === 'completed'
    && run.conclusion === 'success'
    && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository);
  runs.sort((left, right) => right.id - left.id);
  for (const run of runs) {
    const jobs = await listJobs(run);
    const gate = jobs.filter((job) => job.name === PIPELINE_GATE_JOB);
    if (gate.length === 1 && gate[0].conclusion === 'success') {
      return { runId: run.id, runAttempt: run.run_attempt, url: run.html_url };
    }
  }
  return null;
}

/** `aapt2 dump badging` facts the manifest and the version allocation must agree with. */
function parseBadging(text) {
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(text);
  const minSdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'/m.exec(text);
  if (!pkg || !minSdk) fail('APK badging lacks package, version or minimum SDK');
  return { packageName: pkg[1], versionCode: Number(pkg[2]), versionName: pkg[3], minSdk: Number(minSdk[1]) };
}

/** The single signer's certificate digest from `apksigner verify --print-certs`. */
function parseSignerDigest(text) {
  if (/^Signer #2\b/m.test(text)) fail('APK has more than one signer');
  const digests = [...text.matchAll(/^Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})\s*$/gm)];
  if (digests.length !== 1) fail('APK has no single signer certificate digest');
  return digests[0][1];
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Every rule the Android updater (UpdateManifest.kt) applies, so CI never emits what it refuses. */
function validateManifest(manifest, channel) {
  const errors = [];
  const keys = Object.keys(manifest || {});
  if (keys.length !== MANIFEST_KEYS.length || !MANIFEST_KEYS.every((key) => keys.includes(key))) {
    return ['Manifest keys differ from Update Manifest v1'];
  }
  const integer = (key, min, max) => Number.isInteger(manifest[key]) && manifest[key] >= min && manifest[key] <= max;
  const text = (key) => typeof manifest[key] === 'string';
  const { applicationId } = CHANNELS[requireChannel(channel)];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (manifest.channel !== channel) errors.push('wrong channel');
  if (manifest.applicationId !== applicationId) errors.push('wrong applicationId');
  if (!integer('versionCode', 1, MAX_VERSION_CODE)) errors.push('invalid versionCode');
  if (!text('sourceCommit') || !COMMIT.test(manifest.sourceCommit)) errors.push('invalid sourceCommit');
  if (!text('versionName') || !versionNameMatches(manifest.versionName, channel, String(manifest.sourceCommit))) {
    errors.push('versionName does not match channel rules');
  }
  const expectedPath = `/artifacts/android/${channel}/`;
  let url = null;
  try {
    url = new URL(manifest.apkUrl);
  } catch { /* reported below */ }
  const name = url ? url.pathname.slice(expectedPath.length) : '';
  if (!url || url.origin !== ARTIFACT_ORIGIN || url.search || url.hash || url.username
    || !url.pathname.startsWith(expectedPath) || !APK_NAME.test(name) || manifest.apkUrl !== `${ARTIFACT_ORIGIN}${expectedPath}${name}`) {
    errors.push('apkUrl must be an APK in this channel on the artifact origin');
  }
  if (!integer('apkSize', 1, MAX_APK_BYTES)) errors.push('invalid apkSize');
  if (!text('sha256') || !SHA256_HEX.test(manifest.sha256)) errors.push('invalid sha256');
  if (!text('signingCertificateSha256') || !SHA256_HEX.test(manifest.signingCertificateSha256)) {
    errors.push('invalid signingCertificateSha256');
  }
  if (!integer('minAndroidApi', MIN_ANDROID_API, 1000)) errors.push('invalid minAndroidApi');
  if (!integer('bridgeProtocolMin', 1, 1000) || !integer('bridgeProtocolMax', manifest.bridgeProtocolMin, 1000)) {
    errors.push('invalid bridge protocol range');
  }
  if (!text('publishedAt') || !PUBLISHED_AT.test(manifest.publishedAt) || Number.isNaN(Date.parse(manifest.publishedAt))) {
    errors.push('invalid publishedAt');
  }
  if (!text('releaseNotesUrl') || !isHttpsUrl(manifest.releaseNotesUrl)) errors.push('invalid releaseNotesUrl');
  return errors;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 32 raw key bytes from their canonical base64, as repository variables and secrets hold them. */
function rawX25519Key(base64, role) {
  const text = String(base64 || '').trim();
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== text) fail(`Recipient ${role} key must be 32 bytes of base64`);
  return raw;
}

function x25519PublicKey(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function apkKey(privateKey, publicKey, ephemeralRaw, recipientRaw) {
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0),
    Buffer.concat([ENCRYPTION_INFO, ephemeralRaw, recipientRaw]), 32));
}

/**
 * Encrypts to an X25519 recipient key; only its private key can recover the APK. The build job
 * encrypts the unsigned APK to the signing environment's key, the sign job the signed APK to the
 * deployment synchronizer's.
 */
function encryptForRecipient(plaintext, recipientPublicKeyBase64) {
  const recipientRaw = rawX25519Key(recipientPublicKeyBase64, 'public');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const key = apkKey(ephemeral.privateKey, x25519PublicKey(recipientRaw), ephemeralRaw, recipientRaw);
  const nonce = crypto.randomBytes(12);
  const header = Buffer.concat([ENCRYPTION_MAGIC, ephemeralRaw, nonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

/** Recovers what [encryptForRecipient] encrypted to this private key; anything else fails. */
function decryptForRecipient(blob, recipientPrivateKeyBase64) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawX25519Key(recipientPrivateKeyBase64, 'private')]), format: 'der', type: 'pkcs8',
  });
  const headerLength = ENCRYPTION_MAGIC.length + 32 + 12;
  if (blob.length < headerLength + 16 || !blob.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    fail('Not an encrypted Album Haven APK');
  }
  const ephemeralRaw = blob.subarray(ENCRYPTION_MAGIC.length, ENCRYPTION_MAGIC.length + 32);
  const header = blob.subarray(0, headerLength);
  const key = apkKey(privateKey, x25519PublicKey(ephemeralRaw), ephemeralRaw, rawPublicKey(crypto.createPublicKey(privateKey)));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(-12));
  decipher.setAAD(header);
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  try {
    return Buffer.concat([decipher.update(blob.subarray(headerLength, blob.length - 16)), decipher.final()]);
  } catch {
    return fail('Encrypted APK is not for this key or was altered');
  }
}

/** A new recipient key pair: the private key goes to [privateKeyPath] only, never to the output. */
function generateRecipientKey(privateKeyPath) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  fs.writeFileSync(privateKeyPath, `${raw.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  return rawPublicKey(publicKey).toString('base64');
}

/**
 * Checks the signed APK against the allocated plan and writes the promotion artifact:
 * promotion.json (provenance plus the manifest, plaintext data) and the encrypted APK.
 */
function finalizePromotion({ plan, apkBytes, badging, signerDigest, recipientPublicKey, outDir, now = new Date() }) {
  const channel = requireChannel(plan.channel);
  const errors = [];
  if (!SHA256_HEX.test(String(plan.certificate))) errors.push('Expected signing certificate is not configured');
  if (signerDigest !== plan.certificate) errors.push('APK is not signed by the channel certificate');
  if (badging.packageName !== CHANNELS[channel].applicationId) errors.push('APK package does not match the channel');
  if (badging.versionCode !== plan.versionCode || badging.versionName !== plan.versionName) {
    errors.push('APK version does not match the allocated version');
  }
  if (badging.minSdk !== MIN_ANDROID_API) errors.push(`APK minimum SDK must be ${MIN_ANDROID_API}`);
  if (apkBytes.length < 1 || apkBytes.length > MAX_APK_BYTES) errors.push('APK size is out of bounds');
  if (errors.length) fail(errors.join('\n'));

  const name = apkName(channel, plan.versionCode);
  const manifest = {
    schemaVersion: 1,
    channel,
    applicationId: CHANNELS[channel].applicationId,
    versionCode: plan.versionCode,
    versionName: plan.versionName,
    sourceCommit: plan.commit,
    apkUrl: `${ARTIFACT_ORIGIN}/artifacts/android/${channel}/${name}`,
    apkSize: apkBytes.length,
    sha256: sha256Hex(apkBytes),
    signingCertificateSha256: signerDigest,
    minAndroidApi: badging.minSdk,
    bridgeProtocolMin: plan.bridgeProtocolMin,
    bridgeProtocolMax: plan.bridgeProtocolMax,
    publishedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    releaseNotesUrl: plan.releaseNotesUrl,
  };
  const manifestErrors = validateManifest(manifest, channel);
  if (manifestErrors.length) fail(manifestErrors.join('\n'));
  const promotion = {
    schemaVersion: 1,
    repository: plan.repository,
    workflow: PROMOTE_WORKFLOW,
    runId: plan.runId,
    runAttempt: plan.runAttempt,
    pipelineRunId: plan.pipelineRunId,
    versionTag: versionTag(channel, plan.versionCode),
    encryptedApk: `${name}.enc`,
    manifest,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, promotion.encryptedApk), encryptForRecipient(apkBytes, recipientPublicKey));
  fs.writeFileSync(path.join(outDir, 'promotion.json'), `${JSON.stringify(promotion, null, 2)}\n`);
  return promotion;
}

function cli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const options = Object.fromEntries(rest.map((arg) => {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    return match ? [match[1], match[2]] : fail(`Unexpected argument: ${arg}`);
  }));
  if (command === 'encrypt') {
    fs.writeFileSync(options.out, encryptForRecipient(fs.readFileSync(options.in), env.ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY));
    return;
  }
  if (command === 'decrypt') {
    fs.writeFileSync(options.out, decryptForRecipient(fs.readFileSync(options.in), env.ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY),
      { mode: 0o600 });
    return;
  }
  if (command === 'keygen') {
    process.stdout.write(`${generateRecipientKey(options['private-key'])}\n`);
    return;
  }
  if (command !== 'finalize') {
    fail('Usage: android-promotion.cjs finalize --plan=FILE --apk=FILE --badging=FILE --certs=FILE --out=DIR'
      + ' | encrypt --in=FILE --out=FILE | decrypt --in=FILE --out=FILE | keygen --private-key=FILE');
  }
  const promotion = finalizePromotion({
    plan: JSON.parse(fs.readFileSync(options.plan, 'utf8')),
    apkBytes: fs.readFileSync(options.apk),
    badging: parseBadging(fs.readFileSync(options.badging, 'utf8')),
    signerDigest: parseSignerDigest(fs.readFileSync(options.certs, 'utf8')),
    recipientPublicKey: env.ANDROID_ARTIFACT_RECIPIENT_PUBLIC_KEY,
    outDir: options.out,
  });
  process.stdout.write(`${JSON.stringify({ versionTag: promotion.versionTag, manifest: promotion.manifest }, null, 2)}\n`);
}

if (require.main === module) cli();

module.exports = {
  CHANNELS,
  ENCRYPTION_INFO,
  ENCRYPTION_MAGIC,
  MANIFEST_KEYS,
  apkName,
  checkStableRelease,
  cli,
  decryptForRecipient,
  encryptForRecipient,
  finalizePromotion,
  findCompletePipelineRun,
  nextVersionCode,
  parseBadging,
  parseSignerDigest,
  readBridgeRange,
  readReleaseVersion,
  requireChannel,
  requireCommit,
  validateManifest,
  versionNameFor,
  versionTag,
};
