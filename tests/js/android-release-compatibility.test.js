const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const {
  checkRecordAgainstTags,
  checkSupportedShells,
  classifyRelease,
  evaluate,
  readSitePolicy,
  readStableShells,
  summaryMarkdown,
} = require('../../scripts/ci/android-release-compatibility.cjs');

const CLIENT = 'music_app/static/js/runtime/android-bridge-client.js';
const RECORD = 'tests/fixtures/android-bridge/stable-shells.json';
const FIXTURE = 'tests/fixtures/android-bridge/v1.json';
const realClient = fs.readFileSync(path.join(root, CLIENT), 'utf8');
const realRecord = fs.readFileSync(path.join(root, RECORD), 'utf8');
const record = JSON.parse(realRecord);
const policy = readSitePolicy(realClient);
const latest = record.shells.latest.capabilities;

const classify = (paths, extra = {}) => classifyRelease({
  paths, bridgeScripts: [], basePolicy: policy, headPolicy: policy, latestCapabilities: latest, ...extra,
});
const withUse = (use) => ({ ...policy, use: { ...policy.use, ...use } });

test('the site policy and the stable shell record in the repository are readable and valid', () => {
  assert.deepEqual([policy.min, policy.max], [1, 1]);
  assert.equal(policy.use['playback.native.v1'], 'optional');
  assert.deepEqual(readStableShells(realRecord).errors, []);
  assert.equal(readSitePolicy(null), null);
  assert.equal(readSitePolicy('const ANDROID_BRIDGE_PROTOCOL = 1;'), null);
});

test('the site policy is read as data, never by running the bridge client', () => {
  // Code a browser runs at load, such as reading window or state, never reaches the classifier.
  const loadTime = `window.addEventListener('load', () => {});\nstate.player.ready = true;\nthrow new Error('ran');\n`;
  assert.deepEqual(readSitePolicy(`${loadTime}${realClient}`), policy);
  const block = (json) => `const ANDROID_BRIDGE_POLICY = /* android-bridge-policy */ ${json} /* end android-bridge-policy */;`;
  assert.deepEqual(readSitePolicy(block('{"protocolMin": 1, "protocolMax": 2, "capabilities": {"a.v1": "required"}}')),
    { min: 1, max: 2, use: { 'a.v1': 'required' } });
  for (const json of ['{ protocolMin: 1 }', '{"protocolMin": 2, "protocolMax": 1, "capabilities": {}}',
    '{"protocolMin": 1, "protocolMax": 1, "capabilities": {"a.v1": "sometimes"}}', '{"protocolMin": 1, "protocolMax": 1}']) {
    assert.equal(readSitePolicy(block(json)), null, json);
  }
  assert.match(checkSupportedShells(readSitePolicy(block('[]')), record).errors[0], /declares no bridge protocol range/);
});

test('changes that do not touch the bridge, its contracts or APK routes are web-only', () => {
  for (const paths of [
    ['music_app/static/css/gallery-main.css', 'music_app/templates/index.html'],
    ['apps/android-shell/README.md', 'docs/android-release-signing.md'],
    ['apps/android-shell/app/src/test/java/org/albumhaven/shell/BridgeControllerTest.kt',
      'apps/android-shell/app/src/androidTest/java/org/albumhaven/shell/ShellSmokeTest.kt'],
    ['music_app/static/js/runtime-bundle.js', 'music_app/static/js/runtime/library-settings.js'],
    [],
  ]) assert.equal(classify(paths).releaseClass, 'web-only', paths.join());
});

test('bridge web code, APK-facing routes, the stable record and bridge-using lines are existing-bridge', () => {
  for (const filePath of [
    'music_app/static/js/runtime/android-settings.js', CLIENT, RECORD,
    'music_app/routes/playback_control_asgi.py', 'music_app/routes/playback_stream_asgi.py',
    'music_app/routes/api_wave_b_asgi_routes.py', 'music_app/routes/android_artifacts_asgi.py',
    'music_app/services/android_key_attestation.py', 'music_app/services/playback_references.py',
  ]) {
    const result = classify([filePath]);
    assert.equal(result.releaseClass, 'existing-bridge', filePath);
    assert.match(result.action, /latest and previous stable shell fixture tests/);
  }
  const script = 'music_app/static/js/runtime/mobile-navigation.js';
  assert.equal(classify([script], { bridgeScripts: [script] }).releaseClass, 'existing-bridge');
  assert.equal(classify([], { headPolicy: withUse({ 'playback.native.v1': 'required' }) }).releaseClass, 'existing-bridge');
  const { 'playback.webview.v1': _dropped, ...remaining } = policy.use;
  assert.equal(classify([], { headPolicy: { ...policy, use: remaining } }).releaseClass, 'existing-bridge');
});

test('shell sources, shared contracts, protocol changes and capabilities the stable APK lacks are native-impact', () => {
  for (const filePath of [
    'apps/android-shell/app/src/main/java/org/albumhaven/shell/BridgeController.kt',
    'apps/android-shell/app/src/main/res/values/strings.xml',
    'packages/native/native-media/android/Engine.kt',
    'tests/fixtures/android-bridge/v1.json', 'tests/fixtures/android-bridge/v2.json',
    'tests/fixtures/listen-sessions-v1.json', 'tests/fixtures/playback-protocol-v1.json',
  ]) {
    const result = classify(['music_app/static/js/runtime/android-settings.js', filePath]);
    assert.equal(result.releaseClass, 'native-impact', filePath);
    assert.deepEqual(result.reasons, [`${filePath} is APK source or a shared bridge contract`]);
    assert.match(result.action, /Promote and accept a sandbox APK/);
  }
  const lyrics = classify([CLIENT], { headPolicy: withUse({ 'playback.lyrics.v1': 'optional' }) });
  assert.equal(lyrics.releaseClass, 'native-impact');
  assert.deepEqual(lyrics.reasons, ['the site uses playback.lyrics.v1 (optional), which the latest stable APK lacks']);
  const protocol = classify([CLIENT], { headPolicy: { ...policy, max: 2 } });
  assert.deepEqual(protocol.reasons, ['the site bridge protocol range changed to 1-2']);
});

test('the guard requires both supported stable shells to run the site', () => {
  // The interim WebView player predates the stable shells; sandbox selection exists only in sandbox shells.
  const legacy = ['playback.webview.v1', 'sandbox.select.v1']
    .map((name) => `The latest stable shell lacks ${name}; the site gates it at runtime`);
  assert.deepEqual(checkSupportedShells(policy, record), { errors: [], notes: legacy });
  const previousLacks = structuredClone(record);
  previousLacks.shells.previous.capabilities = latest.filter((name) => name !== 'updates.manual.v1');
  assert.deepEqual(checkSupportedShells(withUse({ 'updates.manual.v1': 'required' }), previousLacks).errors, [
    'The site requires updates.manual.v1, which the previous stable shell lacks: publish that APK first or gate the feature at runtime',
  ]);
  const gated = checkSupportedShells(withUse({ 'playback.lyrics.v1': 'optional' }), record);
  assert.deepEqual(gated.errors, []);
  assert.deepEqual(gated.notes, [...legacy, 'The latest stable shell lacks playback.lyrics.v1; the site gates it at runtime']);
  assert.equal(checkSupportedShells({ ...policy, min: 2, max: 2 }, record).errors.length, 2);
  const newer = structuredClone(record);
  newer.shells.latest = { ...newer.shells.latest, bridgeProtocolMin: 1, bridgeProtocolMax: 2, fixture: 'v2.json' };
  assert.deepEqual(checkSupportedShells({ ...policy, min: 1, max: 2 }, newer).errors, []);
  assert.match(checkSupportedShells(null, record).errors[0], /declares no bridge protocol range/);
});

test('the stable shell record must be well formed', () => {
  const bad = (change) => {
    const copy = structuredClone(record);
    change(copy);
    return readStableShells(JSON.stringify(copy)).errors;
  };
  assert.deepEqual(readStableShells('{').errors, [`${RECORD} is not JSON`]);
  assert.equal(bad((copy) => { copy.channel = 'sandbox'; }).length, 1);
  assert.equal(bad((copy) => { delete copy.shells.previous; }).length, 1);
  assert.equal(bad((copy) => { copy.shells.latest.fixture = 'v2.json'; }).length, 1);
  assert.equal(bad((copy) => { copy.shells.latest.versionCode = 3; }).length, 1);
  assert.equal(bad((copy) => { copy.shells.latest.sourceCommit = 'a'.repeat(40); }).length, 1);
  assert.equal(bad((copy) => { copy.shells.latest.bridgeProtocolMin = 2; }).length, 1);
  assert.deepEqual(bad((copy) => { Object.assign(copy.shells.latest, { versionCode: 3, sourceCommit: 'a'.repeat(40) }); }), []);
});

const COMMIT = 'c'.repeat(40);
const CONTROLLER = 'const val PROTOCOL_MIN = 1\nconst val PROTOCOL_MAX = 1\n';

function fakeGit({ tags = [], tagCommit = COMMIT, fixture = { capabilities: { stable: latest } }, controller = CONTROLLER } = {}) {
  return (args) => {
    if (args[0] === 'tag') return tags.join('\n');
    if (args[0] === 'rev-parse') {
      if (!tags.includes(args[3].replace(/^refs\/tags\/|\^\{commit\}$/g, ''))) throw new Error('no tag');
      return `${tagCommit}\n`;
    }
    if (args[0] === 'show') {
      if (args[1].endsWith('v1.json')) return JSON.stringify(fixture);
      if (args[1].endsWith('BridgeController.kt')) return controller;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function promoted(latestCode = 3, previousCode = 2) {
  const copy = structuredClone(record);
  Object.assign(copy.shells.latest, { versionCode: latestCode, sourceCommit: COMMIT });
  Object.assign(copy.shells.previous, { versionCode: previousCode, sourceCommit: COMMIT });
  return copy;
}

test('promoted stable shell records must match their android-promote tags', () => {
  assert.deepEqual(checkRecordAgainstTags(fakeGit(), record), { errors: [], notes: [] });
  assert.deepEqual(checkRecordAgainstTags(fakeGit({ tags: ['android/stable/1'] }), record).errors, [
    'The latest stable shell record is unpromoted, but android/stable/1 exists: record the promoted APKs',
    'The previous stable shell record is unpromoted, but android/stable/1 exists: record the promoted APKs',
  ]);
  const tags = ['android/stable/2', 'android/stable/3', 'android/sandbox/9'];
  assert.deepEqual(checkRecordAgainstTags(fakeGit({ tags }), promoted()), { errors: [], notes: [] });
  assert.deepEqual(checkRecordAgainstTags(fakeGit({ tags: [...tags, 'android/stable/4'] }), promoted()).notes, [
    `android/stable/4 is newer than the recorded latest stable shell (3); update ${RECORD}`,
  ]);
  assert.match(checkRecordAgainstTags(fakeGit({ tags: ['android/stable/3'] }), promoted()).errors[0],
    /previous stable shell record names android\/stable\/2 at c{40}, but the tag does not exist/);
  assert.match(checkRecordAgainstTags(fakeGit({ tags, tagCommit: 'd'.repeat(40) }), promoted()).errors[0], /but the tag is d{40}/);
  const fewer = { capabilities: { stable: latest.slice(1) } };
  assert.equal(checkRecordAgainstTags(fakeGit({ tags, fixture: fewer }), promoted()).errors.length, 2);
  // A tag whose fixture is not JSON is a guard error, not a crash.
  const broken = fakeGit({ tags });
  const unreadable = checkRecordAgainstTags((args) => (args[0] === 'show' && args[1].endsWith('v1.json') ? '{' : broken(args)), promoted());
  assert.deepEqual(unreadable.errors, ['latest', 'previous'].map((role) =>
    `The ${role} stable shell record's capabilities differ from android/stable/${role === 'latest' ? 3 : 2}'s ${FIXTURE}`));
  const range = checkRecordAgainstTags(fakeGit({ tags, controller: CONTROLLER.replace('MAX = 1', 'MAX = 2') }), promoted());
  assert.match(range.errors[0], /bridge range differs from android\/stable\/3's BridgeController/);
});

function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'CI']);
  git(['config', 'core.autocrlf', 'false']);
  const write = (filePath, text) => {
    fs.mkdirSync(path.join(dir, path.dirname(filePath)), { recursive: true });
    fs.writeFileSync(path.join(dir, filePath), text);
  };
  const commit = (message) => {
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  return { git, write, commit };
}

test('a pull request range is classified and guarded from its own commits', (t) => {
  const repo = repository(t);
  repo.write(CLIENT, realClient);
  repo.write(RECORD, realRecord);
  repo.write('music_app/static/js/runtime/mobile-navigation.js', 'function open() {}\n');
  const base = repo.commit('base');

  repo.write('music_app/static/css/site.css', 'a { color: red; }\n');
  const webOnly = evaluate({ git: repo.git, base, head: repo.commit('css') });
  assert.equal(webOnly.releaseClass, 'web-only');
  assert.deepEqual(webOnly.errors, []);

  repo.write('music_app/static/js/runtime/mobile-navigation.js', 'function open() { if (isAndroidShell()) return; }\n');
  const bridgeUse = evaluate({ git: repo.git, base, head: repo.commit('bridge use') });
  assert.equal(bridgeUse.releaseClass, 'existing-bridge');
  assert.deepEqual(bridgeUse.reasons, ['music_app/static/js/runtime/mobile-navigation.js changes bridge use']);

  const using = (use) => realClient.replace('"updates.manual.v1": "optional"', `"updates.manual.v1": "optional",\n    "playback.lyrics.v1": "${use}"`);
  repo.write(CLIENT, using('required'));
  const required = evaluate({ git: repo.git, base, head: repo.commit('require lyrics') });
  assert.equal(required.releaseClass, 'native-impact');
  assert.equal(required.errors.length, 2);
  assert.match(summaryMarkdown(required), /Release class: \*\*native-impact\*\*[\s\S]*Release-order guard failed/);

  repo.write(CLIENT, using('optional'));
  const gated = evaluate({ git: repo.git, base, head: repo.commit('gate lyrics') });
  assert.equal(gated.releaseClass, 'native-impact');
  assert.deepEqual(gated.errors, []);
  assert.match(summaryMarkdown(gated), /Release-order guard passed/);
});

test('the JavaScript job classifies every pull request and enforces the release order after its tests', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pr-gates.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('  test_js:'), workflow.indexOf('  test_components:'));
  assert.match(job, /fetch-depth: 0/);
  const step = job.slice(job.indexOf('- name: Classify Android release and enforce release order'));
  assert.ok(job.indexOf('npm run test:js:all') < job.indexOf('Classify Android release'));
  assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(step, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(step, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(step, /run: node scripts\/ci\/android-release-compatibility\.cjs/);
});
