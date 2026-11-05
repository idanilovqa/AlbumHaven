const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const promotion = require('../../scripts/ci/android-promotion.cjs');

const COMMIT = 'b5f585f2'.padEnd(40, 'a');
const CERT = 'c'.repeat(64);
const REPOSITORY = 'owner/app';
const temporaryDirectories = [];
test.after(() => temporaryDirectories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function recipient() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, publicBase64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

function decrypt(blob, privateKey) {
  const magic = promotion.ENCRYPTION_MAGIC;
  assert.deepEqual(blob.subarray(0, magic.length), magic);
  const ephemeral = blob.subarray(magic.length, magic.length + 32);
  const nonce = blob.subarray(magic.length + 32, magic.length + 44);
  const header = blob.subarray(0, magic.length + 44);
  const ephemeralKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeral]), format: 'der', type: 'spki' });
  const recipientRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeralKey });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.concat([promotion.ENCRYPTION_INFO, ephemeral, recipientRaw]), 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(header.length, blob.length - 16)), decipher.final()]);
}

function plan(overrides = {}) {
  return {
    repository: REPOSITORY, channel: 'sandbox', commit: COMMIT, versionCode: 7,
    versionName: '0.10.0-sandbox.b5f585f', certificate: CERT, bridgeProtocolMin: 1, bridgeProtocolMax: 1,
    releaseNotesUrl: `https://github.com/${REPOSITORY}/commit/${COMMIT}`, runId: 11, runAttempt: 1,
    ciGate: 'not-required', pipelineRunId: 10, ...overrides,
  };
}

function badging(overrides = {}) {
  return { packageName: 'org.albumhaven.app.sandbox', versionCode: 7, versionName: '0.10.0-sandbox.b5f585f', minSdk: 29, ...overrides };
}

function finalize(overrides = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-promotion-'));
  temporaryDirectories.push(outDir);
  const keys = recipient();
  const apkBytes = Buffer.from('signed apk bytes');
  const result = promotion.finalizePromotion({
    plan: plan(), apkBytes, badging: badging(), signerDigest: CERT,
    recipientPublicKey: keys.publicBase64, outDir, now: new Date('2026-11-04T12:00:00.123Z'), ...overrides,
  });
  return { result, outDir, keys, apkBytes };
}

test('version codes continue from the channel tags, never reuse, and honor the floor', () => {
  const tags = ['android/sandbox/1', 'android/sandbox/4', 'android/stable/9', 'android/sandbox/x', 'android/sandbox/07', 'v0.10.0'];
  assert.equal(promotion.nextVersionCode(tags, 'sandbox'), 5);
  assert.equal(promotion.nextVersionCode(tags, 'stable'), 10);
  assert.equal(promotion.nextVersionCode([], 'stable'), 1);
  assert.equal(promotion.nextVersionCode(tags, 'sandbox', 3), 5);
  assert.equal(promotion.nextVersionCode(tags, 'sandbox', 20), 21);
  assert.throws(() => promotion.nextVersionCode(['android/stable/2100000000'], 'stable'), /exhausted/);
  assert.throws(() => promotion.nextVersionCode([], 'stable', -1), /floor/);
  assert.throws(() => promotion.nextVersionCode([], 'stable', Number.NaN), /floor/);
  assert.throws(() => promotion.nextVersionCode([], 'beta'), /stable or sandbox/);
});

test('version names follow Album Haven semver and the sandbox short-sha suffix', () => {
  assert.equal(promotion.readReleaseVersion('X = 1\nRELEASE_VERSION = "0.10.0"\n'), '0.10.0');
  assert.throws(() => promotion.readReleaseVersion('RELEASE_VERSION = "0.10"\n'), /RELEASE_VERSION/);
  assert.equal(promotion.versionNameFor('stable', '0.10.0', COMMIT), '0.10.0');
  assert.equal(promotion.versionNameFor('sandbox', '0.10.0', COMMIT), '0.10.0-sandbox.b5f585f');
  assert.throws(() => promotion.versionNameFor('sandbox', '0.10.0', 'B5F585F2'), /40 lowercase/);
  assert.equal(promotion.versionTag('sandbox', 7), 'android/sandbox/7');
  assert.equal(promotion.apkName('stable', 3), 'album-haven-stable-3.apk');
});

test('bridge range comes from the shell source', () => {
  const source = 'const val PROTOCOL_MIN = 1\n        const val PROTOCOL_MAX = 2\n';
  assert.deepEqual(promotion.readBridgeRange(source), { min: 1, max: 2 });
  assert.throws(() => promotion.readBridgeRange('const val PROTOCOL_MIN = 1'), /PROTOCOL_MAX/);
  assert.throws(() => promotion.readBridgeRange('const val PROTOCOL_MIN = 3\nconst val PROTOCOL_MAX = 2'), /invalid/);
  // The promotion tooling reaches main before the shell does.
  const shell = path.join(root, 'apps/android-shell/app/src/main/java/org/albumhaven/shell/BridgeController.kt');
  if (fs.existsSync(shell)) assert.ok(promotion.readBridgeRange(fs.readFileSync(shell, 'utf8')).min >= 1);
});

function pipelineRun(overrides = {}) {
  return {
    id: 100, run_attempt: 2, path: '.github/workflows/pr-gates.yml', head_sha: COMMIT, event: 'pull_request',
    status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/100',
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, ...overrides,
  };
}

const PIPELINE_JOBS = ['Cloud Verification Gate', 'Android Build, Lint and Unit Tests', 'Android Instrumentation (API 29)'];

function pipelineJobs(conclusions = {}) {
  return PIPELINE_JOBS.map((name) => ({ name, conclusion: Object.hasOwn(conclusions, name) ? conclusions[name] : 'success' }));
}

async function findPipeline(runs, jobs = () => pipelineJobs()) {
  const asked = [];
  const found = await promotion.findCompletePipelineRun({
    repository: REPOSITORY, commit: COMMIT, listRuns: async () => runs,
    listJobs: async (run) => { asked.push([run.id, run.run_attempt]); return jobs(run); },
  });
  return { found, asked };
}

test('promotion requires a successful complete PR Gates pipeline for exactly that commit', async () => {
  assert.deepEqual((await findPipeline([pipelineRun()])).found, { runId: 100, runAttempt: 2, url: 'https://example.test/run/100' });
  for (const patch of [
    { head_sha: 'f'.repeat(40) }, { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'fork/app' } }, { head_repository: { full_name: 'fork/app' } },
  ]) {
    const { found, asked } = await findPipeline([pipelineRun(patch)]);
    assert.equal(found, null, JSON.stringify(patch));
    assert.deepEqual(asked, []);
  }
  const refused = [[], [...pipelineJobs(), { name: 'Cloud Verification Gate', conclusion: 'failure' }]];
  for (const name of PIPELINE_JOBS) {
    refused.push(pipelineJobs().filter((job) => job.name !== name));
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) refused.push(pipelineJobs({ [name]: conclusion }));
  }
  for (const jobs of refused) {
    assert.equal((await findPipeline([pipelineRun()], () => jobs)).found, null, JSON.stringify(jobs));
  }
  const { found, asked } = await findPipeline([pipelineRun({ id: 5 }), pipelineRun({ id: 9 })],
    (run) => pipelineJobs(run.id === 5 ? {} : { 'Android Instrumentation (API 29)': 'skipped' }));
  assert.equal(found.runId, 5);
  assert.deepEqual(asked, [[9, 2], [5, 2]], 'newest runs are checked first');
  await assert.rejects(promotion.findCompletePipelineRun({ repository: REPOSITORY, commit: 'abc', listRuns: async () => [], listJobs: async () => [] }), /40 lowercase/);
});

test('stable requires its complete pipeline; sandbox records one only when it already exists', () => {
  const pipeline = { runId: 100, runAttempt: 2, url: 'https://example.test/run/100' };
  assert.deepEqual(promotion.ciGateFor('stable', pipeline), { ciGate: 'complete-pipeline', pipelineRunId: 100 });
  assert.throws(() => promotion.ciGateFor('stable', null), /no successful complete PR Gates pipeline/);
  assert.deepEqual(promotion.ciGateFor('sandbox', pipeline), { ciGate: 'not-required', pipelineRunId: 100 });
  assert.deepEqual(promotion.ciGateFor('sandbox', null), { ciGate: 'not-required', pipelineRunId: null });
  assert.throws(() => promotion.ciGateFor('beta', pipeline), /stable or sandbox/);
});

function release(overrides = {}) {
  return {
    tag_name: 'v0.10.0', draft: false, prerelease: false, author: { login: 'owner' }, body: '- Notes',
    html_url: 'https://github.com/owner/app/releases/tag/v0.10.0', ...overrides,
  };
}

test('stable promotion requires the authorized release whose tree and notes match', () => {
  const tree = 'd'.repeat(40);
  const good = { release: release(), releaseVersion: '0.10.0', owner: 'owner', sourceTree: tree, releaseTree: tree, changelog: '# Changelog\n\n## 0.10.0 - 2026-10-25\n\n- Notes\n' };
  assert.deepEqual(promotion.checkStableRelease(good), { errors: [], releaseNotesUrl: 'https://github.com/owner/app/releases/tag/v0.10.0' });
  for (const [patch, message] of [
    [{ release: null }, /No published/], [{ release: release({ tag_name: 'v0.9.50' }) }, /does not match/],
    [{ release: release({ draft: true }) }, /draft/], [{ release: release({ prerelease: true }) }, /prerelease/],
    [{ release: release({ author: { login: 'someone' } }) }, /repository owner/], [{ release: release({ body: '  ' }) }, /no release notes/],
    [{ release: release({ html_url: 'http://example.test/notes' }) }, /release-notes URL/], [{ releaseTree: 'e'.repeat(40) }, /tree differs/],
    [{ releaseTree: '' }, /tree differs/], [{ changelog: '## 0.9.50 - 2026-10-08\n' }, /CHANGELOG/],
  ]) {
    const result = promotion.checkStableRelease({ ...good, ...patch });
    assert.ok(result.errors.some((error) => message.test(error)), `${JSON.stringify(patch)}: ${result.errors}`);
    assert.equal(result.releaseNotesUrl, undefined);
  }
});

test('badging and signer output are parsed strictly', () => {
  const text = "package: name='org.albumhaven.app' versionCode='3' versionName='0.10.0' platformBuildVersionName='16'\nminSdkVersion:'29'\n";
  assert.deepEqual(promotion.parseBadging(text), { packageName: 'org.albumhaven.app', versionCode: 3, versionName: '0.10.0', minSdk: 29 });
  assert.throws(() => promotion.parseBadging("package: name='x'\n"), /badging/);
  const signer = `Signer #1 certificate DN: CN=Album Haven\nSigner #1 certificate SHA-256 digest: ${CERT}\nSigner #1 certificate SHA-1 digest: ${'a'.repeat(40)}\n`;
  assert.equal(promotion.parseSignerDigest(signer), CERT);
  assert.throws(() => promotion.parseSignerDigest(`${signer}Signer #2 certificate SHA-256 digest: ${'b'.repeat(64)}\n`), /more than one signer/);
  assert.throws(() => promotion.parseSignerDigest('DOES NOT VERIFY\n'), /single signer/);
});

test('finalize writes an Update Manifest v1 and an APK only the synchronizer can decrypt', () => {
  const { result, outDir, keys, apkBytes } = finalize();
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'promotion.json'), 'utf8'));
  assert.deepEqual(written, result);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['album-haven-sandbox-7.apk.enc', 'promotion.json']);
  assert.deepEqual(Object.keys(result.manifest), promotion.MANIFEST_KEYS);
  assert.deepEqual(result.manifest, {
    schemaVersion: 1, channel: 'sandbox', applicationId: 'org.albumhaven.app.sandbox', versionCode: 7,
    versionName: '0.10.0-sandbox.b5f585f', sourceCommit: COMMIT,
    apkUrl: 'https://albumhaven.org/artifacts/android/sandbox/album-haven-sandbox-7.apk',
    apkSize: apkBytes.length, sha256: crypto.createHash('sha256').update(apkBytes).digest('hex'),
    signingCertificateSha256: CERT, minAndroidApi: 29, bridgeProtocolMin: 1, bridgeProtocolMax: 1,
    publishedAt: '2026-11-04T12:00:00Z', releaseNotesUrl: `https://github.com/${REPOSITORY}/commit/${COMMIT}`,
  });
  assert.deepEqual({ ...result, manifest: undefined }, {
    schemaVersion: 1, repository: REPOSITORY, workflow: '.github/workflows/android-promote.yml', runId: 11, runAttempt: 1,
    ciGate: 'not-required', pipelineRunId: 10, versionTag: 'android/sandbox/7', encryptedApk: 'album-haven-sandbox-7.apk.enc', manifest: undefined,
  });
  const blob = fs.readFileSync(path.join(outDir, 'album-haven-sandbox-7.apk.enc'));
  assert.equal(blob.includes(apkBytes), false, 'the APK is never uploaded in plaintext');
  assert.deepEqual(decrypt(blob, keys.privateKey), apkBytes);
  assert.throws(() => decrypt(blob, recipient().privateKey));
  assert.equal(finalize({ plan: plan({ pipelineRunId: null }) }).result.pipelineRunId, null, 'a sandbox test build needs no pipeline');
});

function rawPrivateKey(privateKey) {
  return privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
}

test('the unsigned APK reaches the signing job readable only with the signing environment key', () => {
  const keys = recipient();
  const apkBytes = Buffer.from('unsigned apk bytes');
  const blob = promotion.encryptForRecipient(apkBytes, keys.publicBase64);
  assert.equal(blob.includes(apkBytes), false);
  assert.deepEqual(decrypt(blob, keys.privateKey), apkBytes, 'the format the synchronizer also reads');
  assert.deepEqual(promotion.decryptForRecipient(blob, rawPrivateKey(keys.privateKey)), apkBytes);

  assert.throws(() => promotion.decryptForRecipient(blob, rawPrivateKey(recipient().privateKey)), /not for this key or was altered/);
  const altered = Buffer.from(blob);
  altered[altered.length - 20] ^= 1;
  assert.throws(() => promotion.decryptForRecipient(altered, rawPrivateKey(keys.privateKey)), /not for this key or was altered/);
  assert.throws(() => promotion.decryptForRecipient(Buffer.from('plain apk'), rawPrivateKey(keys.privateKey)), /Not an encrypted/);
  assert.throws(() => promotion.decryptForRecipient(blob, ''), /Recipient private key must be 32 bytes of base64/);
  assert.throws(() => promotion.encryptForRecipient(apkBytes, undefined), /Recipient public key must be 32 bytes of base64/);
});

test('the workflow CLI encrypts, decrypts and generates recipient keys without printing private keys', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-promotion-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name) => path.join(dir, name);
  const printed = [];
  t.mock.method(process.stdout, 'write', (text) => { printed.push(String(text)); return true; });

  promotion.cli(['keygen', `--private-key=${file('signer.key')}`], {});
  t.mock.restoreAll();
  const publicKey = printed.join('').trim();
  const privateKey = fs.readFileSync(file('signer.key'), 'utf8').trim();
  assert.match(publicKey, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(printed.join('').includes(privateKey), false);
  assert.throws(() => promotion.cli(['keygen', `--private-key=${file('signer.key')}`], {}), /EEXIST/, 'never overwrites a key');

  fs.writeFileSync(file('app.apk'), 'unsigned apk bytes');
  promotion.cli(['encrypt', `--in=${file('app.apk')}`, `--out=${file('app.apk.enc')}`], { ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY: publicKey });
  promotion.cli(['decrypt', `--in=${file('app.apk.enc')}`, `--out=${file('out.apk')}`], { ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY: privateKey });
  assert.equal(fs.readFileSync(file('out.apk'), 'utf8'), 'unsigned apk bytes');
  assert.throws(() => promotion.cli(['encrypt', `--in=${file('app.apk')}`, `--out=${file('x')}`], {}), /Recipient public key/);
  assert.throws(() => promotion.cli(['sign'], {}), /Usage/);
});

function stable() {
  return {
    plan: plan({ channel: 'stable', versionName: '0.10.0', ciGate: 'complete-pipeline' }),
    badging: badging({ packageName: 'org.albumhaven.app', versionName: '0.10.0' }),
  };
}

test('a stable promotion records its complete pipeline', () => {
  const { result } = finalize(stable());
  assert.deepEqual([result.ciGate, result.pipelineRunId, result.versionTag], ['complete-pipeline', 10, 'android/stable/7']);
});

test('finalize refuses an APK that does not match the plan, channel or certificate', () => {
  for (const [overrides, message] of [
    [{ signerDigest: 'd'.repeat(64) }, /not signed by the channel certificate/],
    [{ plan: plan({ certificate: '' }) }, /not configured/],
    [{ badging: badging({ packageName: 'org.albumhaven.app' }) }, /package/],
    [{ badging: badging({ versionCode: 6 }) }, /allocated version/],
    [{ badging: badging({ versionName: '0.10.0' }) }, /allocated version/],
    [{ badging: badging({ minSdk: 26 }) }, /minimum SDK/],
    [{ apkBytes: Buffer.alloc(0) }, /size/],
    [{ recipientPublicKey: 'not-a-key' }, /Recipient public key/],
    [{ plan: plan({ releaseNotesUrl: 'http://insecure.test/' }) }, /releaseNotesUrl/],
    [{ plan: plan({ versionName: '0.10.0-sandbox.1234567' }) }, /allocated version|versionName/],
    [{ plan: plan({ ciGate: 'complete-pipeline' }) }, /CI gate/],
    [{ ...stable(), plan: plan({ ...stable().plan, pipelineRunId: null }) }, /CI gate/],
    [{ ...stable(), plan: plan({ ...stable().plan, ciGate: 'not-required' }) }, /CI gate/],
    [{ plan: plan({ ciGate: undefined }) }, /CI gate/],
    [{ plan: plan({ pipelineRunId: 0 }) }, /CI gate/],
    [{ plan: plan({ pipelineRunId: '10' }) }, /CI gate/],
    [{ plan: plan({ pipelineRunId: undefined }) }, /CI gate/],
  ]) assert.throws(() => finalize(overrides), message, JSON.stringify(Object.keys(overrides)));
});

test('manifest validation mirrors the Android updater rules', () => {
  const { manifest } = finalize().result;
  assert.deepEqual(promotion.validateManifest(manifest, 'sandbox'), []);
  assert.ok(promotion.validateManifest(manifest, 'stable').length > 0);
  for (const patch of [
    { extra: 1 }, { schemaVersion: 2 }, { versionCode: 0 }, { versionCode: '7' }, { sourceCommit: 'abc' },
    { versionName: '0.10.0' }, { apkUrl: 'https://evil.test/artifacts/android/sandbox/a.apk' },
    { apkUrl: 'https://albumhaven.org/artifacts/android/stable/a.apk' }, { apkUrl: 'https://albumhaven.org/artifacts/android/sandbox/a.apk?x=1' },
    { apkUrl: 'https://albumhaven.org/artifacts/android/sandbox/../a.apk' }, { apkSize: 200 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) }, { minAndroidApi: 28 }, { bridgeProtocolMax: 0 }, { publishedAt: '2026-11-04 12:00:00' },
  ]) assert.ok(promotion.validateManifest({ ...manifest, ...patch }, 'sandbox').length > 0, JSON.stringify(patch));
  const { apkUrl, ...missing } = manifest;
  assert.ok(apkUrl && promotion.validateManifest(missing, 'sandbox').length > 0);
});

function jobBlock(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job exists`);
  const next = workflow.slice(start + 3).search(/^ {2}[a-z_]+:\r?$/m);
  return workflow.slice(start, next < 0 ? undefined : start + 3 + next);
}

test('android-promote is a dispatch-only, per-channel locked workflow with isolated signing', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/android-promote.yml'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(workflow, /^concurrency:\n {2}group: android-promote-\$\{\{ inputs\.channel \}\}\n {2}cancel-in-progress: false$/m);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(workflow, /options:\n {10}- sandbox\n {10}- stable\n/);

  const verify = jobBlock(workflow, 'verify');
  assert.match(verify, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(verify, /findCompletePipelineRun/);
  assert.match(verify, /const gate = promotion\.ciGateFor\(channel, pipeline\);/);
  assert.match(verify, /\.\.\.gate,\n/);
  // A sandbox commit needs no pipeline but must be on a branch here: a fork's pull request head is
  // fetchable from this repository too, so the check reads only branch history and never fetches
  // the commit on demand.
  const branch = verify.slice(verify.indexOf('- name: Require a branch of this repository to contain a sandbox commit'));
  assert.match(branch, /^ {8}if: \$\{\{ inputs\.channel == 'sandbox' \}\}\n/m);
  assert.match(branch, /fetch --quiet --no-tags --filter=tree:0 origin '\+refs\/heads\/\*:refs\/heads\/\*'\n {10}# [^\n]+\n {10}export GIT_NO_LAZY_FETCH=1\n/);
  assert.match(branch, /for-each-ref --contains "\$COMMIT" --count=1 --format='%\(refname:short\)' refs\/heads\)"\n {10}test -n "\$branch" \|\| refuse\n/);
  assert.match(branch, /cat-file -e "\$COMMIT\^\{commit\}" 2>\/dev\/null \|\| refuse\n/);
  assert.ok(verify.indexOf('Require a branch') < verify.indexOf('ciGateFor'), 'the branch check runs before allocation');
  assert.match(verify, /checkStableRelease/);
  assert.match(verify, /listMatchingRefs/);
  assert.doesNotMatch(verify, /secrets\.|environment:/);

  const build = jobBlock(workflow, 'build');
  assert.match(build, /ref: \$\{\{ inputs\.commit \}\}/);
  assert.match(build, /test "\$\(git rev-parse HEAD\)" = "\$COMMIT"/);
  assert.match(build, /cache-disabled: true/);
  assert.doesNotMatch(build, /secrets\.|environment:|contents: write/);
  assert.match(build, /retention-days: 1\n/);
  // The public repository's artifacts are downloadable by any signed-in user: the unsigned APK
  // leaves the build only encrypted to the signing environment, and is deleted from disk first.
  assert.match(build, /ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY: \$\{\{ vars\.ANDROID_SIGNER_RECIPIENT_PUBLIC_KEY \}\}/);
  assert.match(build, /android-promotion\.cjs encrypt "--in=\$apk" "--out=\$RUNNER_TEMP\/unsigned\/unsigned\.apk\.enc"\n {10}rm -f "\$apk"/);
  assert.match(build, /path: \$\{\{ runner\.temp \}\}\/unsigned\/unsigned\.apk\.enc\n/);
  for (const path of workflow.match(/^ {10}path: [^\n]+/gm)) assert.doesNotMatch(path, /\.apk$/, path);

  const sign = jobBlock(workflow, 'sign');
  assert.match(sign, /environment: android-\$\{\{ inputs\.channel \}\}/);
  assert.match(sign, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.doesNotMatch(sign, /ref: \$\{\{ inputs\.commit \}\}|gradlew/, 'signing never runs the promoted source');
  assert.doesNotMatch(sign, /setup-android|sdkmanager|setup-node|github-script|createRef/,
    'signing installs no SDK, runs no third-party action and writes nothing to the repository');
  assert.match(sign, /ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY: \$\{\{ secrets\.ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY \}\}/);
  assert.match(sign, /android-promotion\.cjs decrypt/);
  assert.match(sign, /tools="\$ANDROID_HOME\/build-tools\/36\.0\.0"/);
  assert.match(sign, /^ {4}runs-on: ubuntu-24\.04$/m, 'the preinstalled build-tools come from a pinned image');
  assert.match(sign, /--ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEYSTORE_PASSWORD/);
  assert.match(sign, /trap 'rm -f "\$keystore"' EXIT/);
  assert.match(sign, /rm -f "\$RUNNER_TEMP\/unsigned\.apk"/);
  assert.match(sign, /rm -f "\$RUNNER_TEMP\/signed\.apk"/);
  assert.match(sign, /name: android-signed-\$\{\{ inputs\.channel \}\}-\$\{\{ needs\.verify\.outputs\.version_code \}\}/);

  const record = jobBlock(workflow, 'record');
  assert.match(record, /permissions:\n {6}contents: write\n {4}steps:/);
  assert.doesNotMatch(record, /secrets\.|environment:|checkout/);
  assert.ok(record.indexOf('createRef') < record.indexOf('name: Upload the promotion artifact'), 'tag before the artifact');
  assert.match(record, /refs\/tags\/android\/\$\{plan\.channel\}\/\$\{plan\.versionCode\}/);
  assert.match(record, /name: android-promotion-\$\{\{ inputs\.channel \}\}-\$\{\{ needs\.verify\.outputs\.version_code \}\}/);
  assert.match(record, /retention-days: 90/);

  const cleanup = jobBlock(workflow, 'cleanup');
  assert.match(cleanup, /if: \$\{\{ always\(\) \}\}/);
  assert.match(cleanup, /permissions:\n {6}actions: write\n {4}steps:/);
  assert.match(cleanup, /"android-unsigned-\$\{\{ inputs\.channel \}\}-\$\{\{ needs\.verify\.outputs\.version_code \}\}"/);
  assert.match(cleanup, /"android-signed-\$\{\{ inputs\.channel \}\}-\$\{\{ needs\.verify\.outputs\.version_code \}\}"/);
  assert.match(cleanup, /deleteArtifact/);
  assert.doesNotMatch(cleanup, /secrets\.|checkout/);

  assert.equal((workflow.match(/contents: write/g) || []).length, 1, 'only the record job writes');
  assert.deepEqual(workflow.match(/secrets\.[A-Z0-9_]+/g).sort(), ['secrets.ANDROID_KEYSTORE_BASE64',
    'secrets.ANDROID_KEYSTORE_PASSWORD', 'secrets.ANDROID_SIGNER_RECIPIENT_PRIVATE_KEY'], 'only the signing job reads secrets');
  assert.doesNotMatch(workflow, /echo[^\n]*(?:KEYSTORE|PASSWORD|PRIVATE_KEY)/);
  // A moved tag cannot change what runs next to the signing key: every action is a full commit.
  for (const uses of workflow.match(/uses: [^\n]+/g)) assert.match(uses, /^uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, uses);
});

test('the test_build label only asks main to promote a same-repository pull request head to sandbox', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/android-test-build.yml'), 'utf8').replaceAll('\r\n', '\n');
  // pull_request, never pull_request_target: forks get no write token, and this run cannot reach
  // the signing environment, whose deployment branch is main only.
  assert.match(workflow, /^on:\n {2}pull_request:\n {4}types:\n {6}- labeled\n {6}- synchronize\n {6}- reopened\n\n/m);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|workflow_call|unlabeled/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^concurrency:\n {2}group: android-test-build-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
  const dispatch = jobBlock(workflow, 'dispatch');
  assert.match(dispatch, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository\n/);
  assert.match(dispatch, /&& github\.event\.pull_request\.state == 'open'\n/);
  assert.match(dispatch, /github\.event\.action == 'labeled' && github\.event\.label\.name == 'test_build'\n/);
  assert.match(dispatch, /github\.event\.action != 'labeled' && contains\(github\.event\.pull_request\.labels\.\*\.name, 'test_build'\)\)\n/);
  assert.match(dispatch, /permissions:\n {6}actions: write\n {4}steps:/);
  assert.match(dispatch, /COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/);
  assert.match(dispatch, /workflow_id: 'android-promote\.yml',\n {14}ref: 'main',\n {14}inputs: \{ commit, channel: 'sandbox' \},/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|checkout|contents: write|stable/);
  const uses = workflow.match(/uses: [^\n]+/g);
  assert.deepEqual(uses, ['uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7.1.0']);
});

test('PR Gates ignores the test_build label', () => {
  const { applyPipelineSkips, classifyPipelineLabels } = require('../../scripts/ci/classify-pr-review-scope.cjs');
  const trusted = { repository: REPOSITORY, headRepository: REPOSITORY };
  for (const labels of [[], ['skip_tests'], ['run_reviews'], ['skip_reviews', 'skip_tests']]) {
    const withLabel = [...labels, 'test_build'];
    assert.deepEqual(classifyPipelineLabels(withLabel, undefined, 'labeled', COMMIT), classifyPipelineLabels(labels, undefined, 'labeled', COMMIT));
    assert.deepEqual(applyPipelineSkips({ mode: 'full' }, { ...trusted, labels: withLabel }), applyPipelineSkips({ mode: 'full' }, { ...trusted, labels }));
  }
});
