// Classifies a web release (a pull request's commit range) for the installed Android apps and
// enforces the release order between web and APK releases (docs/android-release-signing.md):
//
//   web-only         no bridge use, bridge contract or APK-facing server route changed: deploy the web.
//   existing-bridge  changes web code, routes or records the installed APKs use through capabilities
//                    the latest stable APK already has: test against the latest and previous stable
//                    shell fixtures (tests/js/runtime/android-bridge-compatibility.test.js).
//   native-impact    needs a capability the latest stable APK lacks, changes the bridge protocol range,
//                    or changes a contract or shell source the APK is built from: promote and accept a
//                    sandbox APK, and publish the stable APK before the web relies on it.
//
// The guard fails a candidate whose site cannot run on both supported stable shells: its protocol
// range must include a protocol of each, and every capability it requires must be in both. A
// capability the site only gates on at runtime (`optional`) may ship before its APK, hidden.
// Promoted entries of the stable shell record must match their android/stable/<code> tags.
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { matchesPattern } = require('./performance-change-impact.cjs');
const { readBridgeRange } = require('./android-promotion.cjs');

const BRIDGE_CLIENT = 'music_app/static/js/runtime/android-bridge-client.js';
const STABLE_SHELLS = 'tests/fixtures/android-bridge/stable-shells.json';
const FIXTURE_DIR = 'tests/fixtures/android-bridge';
const BRIDGE_CONTROLLER = 'apps/android-shell/app/src/main/java/org/albumhaven/shell/BridgeController.kt';
const SUPPORTED_SHELLS = Object.freeze(['latest', 'previous']);

// What the APK is built from or speaks: shell and native sources and the shared contract fixtures.
const NATIVE_CONTRACT_PATTERNS = Object.freeze([
  'apps/android-shell/**',
  'packages/native/**',
  `${FIXTURE_DIR}/v*.json`,
  'tests/fixtures/listen-sessions-v1.json',
  'tests/fixtures/playback-protocol-v1.json',
]);

// Shell tests verify an APK but never ship in one.
const SHELL_TEST_PATTERNS = Object.freeze(['apps/android-shell/**/src/test/**', 'apps/android-shell/**/src/androidTest/**',
  'packages/native/**/src/test/**', 'packages/native/**/src/androidTest/**']);

// Web code that talks to the shell, the stable shell record, and the server owners of the routes
// the APK calls itself: playback state, claims, references and PCM, listen sessions, artifacts.
const EXISTING_BRIDGE_PATTERNS = Object.freeze([
  BRIDGE_CLIENT,
  'music_app/static/js/runtime/android-settings.js',
  STABLE_SHELLS,
  'music_app/routes/android_artifacts_asgi.py',
  'music_app/routes/playback_control_asgi.py',
  'music_app/routes/playback_stream_asgi.py',
  'music_app/routes/api_wave_b_asgi_routes.py',
  'music_app/services/android_*',
  'music_app/services/playback_claims_postgres.py',
  'music_app/services/playback_pcm.py',
  'music_app/services/playback_references.py',
  'music_app/services/playback_session_payloads.py',
  'music_app/services/private_route_boundary.py',
]);

// A changed line of browser code that names the bridge, its client or its native adapter.
const BRIDGE_USE = /\b(?:AlbumHavenBridge|ANDROID_[A-Z_]+|[a-z]*Android[A-Za-z]*|android[A-Z][A-Za-z]*)\b/;
const WEB_SCRIPT = /^music_app\/static\/js\/.+\.js$/;
const GENERATED_SCRIPTS = new Set(['music_app/static/js/runtime-bundle.js']);

const ACTIONS = Object.freeze({
  'web-only': 'Deploy the web. No APK release is needed.',
  'existing-bridge': 'Deploy the web after the latest and previous stable shell fixture tests pass. No APK release is needed.',
  'native-impact': 'Promote and accept a sandbox APK. Publish the stable APK and record it in the stable shell record before web code relies on it; until then keep the web gated on the capability.',
});

const isDocumentation = (filePath) => filePath.toLowerCase().endsWith('.md');
const matchesAny = (filePath, patterns) => patterns.some((pattern) => matchesPattern(filePath, pattern));

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** A file at a commit, or null where it does not exist. */
function showFile(git, commit, filePath) {
  try {
    return git(['show', `${commit}:${filePath}`]);
  } catch {
    return null;
  }
}

/** The bridge policy a version of android-bridge-client.js declares, or null before it declared one. */
function readSitePolicy(source) {
  if (source === null) return null;
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: BRIDGE_CLIENT, timeout: 1000 });
  const read = (name) => vm.runInContext(`typeof ${name} === 'undefined' ? undefined : ${name}`, context);
  const min = read('ANDROID_BRIDGE_PROTOCOL_MIN');
  const max = read('ANDROID_BRIDGE_PROTOCOL_MAX');
  const use = read('ANDROID_BRIDGE_CAPABILITY_USE');
  if (min === undefined || max === undefined || use === undefined) return null;
  return { min, max, use: { ...use } };
}

function readStableShells(text) {
  const errors = [];
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    return { record: null, errors: [`${STABLE_SHELLS} is not JSON`] };
  }
  if (record?.schemaVersion !== 1 || record.channel !== 'stable') errors.push(`${STABLE_SHELLS} must be schema 1 for the stable channel`);
  for (const role of SUPPORTED_SHELLS) {
    const shell = record?.shells?.[role];
    const valid = shell
      && Number.isInteger(shell.bridgeProtocolMin) && Number.isInteger(shell.bridgeProtocolMax)
      && shell.bridgeProtocolMin >= 1 && shell.bridgeProtocolMin <= shell.bridgeProtocolMax
      && Array.isArray(shell.capabilities) && shell.capabilities.every((name) => typeof name === 'string')
      && (shell.versionCode === null ? shell.sourceCommit === null
        : Number.isInteger(shell.versionCode) && shell.versionCode > 0 && /^[0-9a-f]{40}$/.test(String(shell.sourceCommit)))
      && shell.fixture === `v${shell.bridgeProtocolMax}.json`;
    if (!valid) errors.push(`${STABLE_SHELLS} has an invalid ${role} shell`);
  }
  return { record: errors.length ? null : record, errors };
}

/** Changed paths of the range and, for browser scripts, whether a changed line names the bridge. */
function readChanges(git, base, head) {
  const mergeBase = git(['merge-base', base, head]).trim();
  const paths = git(['diff', '--name-only', '--no-renames', mergeBase, head]).split(/\r?\n/).filter(Boolean);
  const bridgeScripts = paths.filter((filePath) => WEB_SCRIPT.test(filePath) && !GENERATED_SCRIPTS.has(filePath)
    && git(['diff', '--unified=0', '--no-renames', mergeBase, head, '--', filePath]).split(/\r?\n/)
      .some((line) => /^[+-](?![+-])/.test(line) && BRIDGE_USE.test(line)));
  return { mergeBase, paths, bridgeScripts };
}

/**
 * The release class of a change. [basePolicy] and [headPolicy] are the site bridge policies before
 * and after; [latestCapabilities] are what the latest stable shell advertises.
 */
function classifyRelease({ paths, bridgeScripts, basePolicy, headPolicy, latestCapabilities }) {
  const native = [];
  const existing = [];
  const functional = paths.filter((filePath) => !isDocumentation(filePath) && !matchesAny(filePath, SHELL_TEST_PATTERNS));
  for (const filePath of functional) {
    if (matchesAny(filePath, NATIVE_CONTRACT_PATTERNS)) native.push(`${filePath} is APK source or a shared bridge contract`);
    else if (matchesAny(filePath, EXISTING_BRIDGE_PATTERNS)) existing.push(`${filePath} is used by installed APKs`);
  }
  for (const filePath of bridgeScripts) {
    if (!matchesAny(filePath, EXISTING_BRIDGE_PATTERNS)) existing.push(`${filePath} changes bridge use`);
  }
  if (headPolicy) {
    if (basePolicy && (basePolicy.min !== headPolicy.min || basePolicy.max !== headPolicy.max)) {
      native.push(`the site bridge protocol range changed to ${headPolicy.min}-${headPolicy.max}`);
    }
    for (const [capability, use] of Object.entries(headPolicy.use)) {
      if (basePolicy?.use?.[capability] === use) continue;
      if (latestCapabilities.includes(capability)) existing.push(`the site now uses ${capability} as ${use}`);
      else native.push(`the site uses ${capability} (${use}), which the latest stable APK lacks`);
    }
    for (const capability of Object.keys(basePolicy?.use ?? {})) {
      if (!Object.hasOwn(headPolicy.use, capability)) existing.push(`the site no longer uses ${capability}`);
    }
  }
  const releaseClass = native.length ? 'native-impact' : existing.length ? 'existing-bridge' : 'web-only';
  return { releaseClass, reasons: native.length ? native : existing, action: ACTIONS[releaseClass] };
}

/** The candidate site must run on the latest and the previous stable shell. */
function checkSupportedShells(policy, record) {
  const errors = [];
  const notes = [];
  if (!policy) return { errors: [`${BRIDGE_CLIENT} declares no bridge protocol range or capability table`], notes };
  for (const role of SUPPORTED_SHELLS) {
    const shell = record.shells[role];
    if (Math.min(policy.max, shell.bridgeProtocolMax) < Math.max(policy.min, shell.bridgeProtocolMin)) {
      errors.push(`The site speaks bridge ${policy.min}-${policy.max}, which the ${role} stable shell (${shell.bridgeProtocolMin}-${shell.bridgeProtocolMax}) cannot negotiate`);
    }
    for (const [capability, use] of Object.entries(policy.use)) {
      if (shell.capabilities.includes(capability)) continue;
      if (use === 'required') {
        errors.push(`The site requires ${capability}, which the ${role} stable shell lacks: publish that APK first or gate the feature at runtime`);
      } else if (role === 'latest') {
        notes.push(`The latest stable shell lacks ${capability}; the site gates it at runtime`);
      }
    }
  }
  return { errors, notes };
}

/**
 * Promoted records must be exactly what android-promote recorded: the tag's commit, that commit's
 * stable capabilities and bridge range. The latest record must not predate the newest stable tag.
 */
function checkRecordAgainstTags(git, record) {
  const errors = [];
  const notes = [];
  const tags = git(['tag', '--list', 'android/stable/*']).split(/\r?\n/).filter(Boolean);
  const codes = tags.map((tag) => /^android\/stable\/([1-9]\d{0,9})$/.exec(tag)).filter(Boolean).map((match) => Number(match[1]));
  const newest = codes.length ? Math.max(...codes) : null;
  for (const role of SUPPORTED_SHELLS) {
    const shell = record.shells[role];
    if (shell.versionCode === null) {
      if (newest !== null) errors.push(`The ${role} stable shell record is unpromoted, but android/stable/${newest} exists: record the promoted APKs`);
      continue;
    }
    const tag = `android/stable/${shell.versionCode}`;
    let commit = '';
    try {
      commit = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim();
    } catch { /* reported below */ }
    if (commit !== shell.sourceCommit) {
      errors.push(`The ${role} stable shell record names ${tag} at ${shell.sourceCommit}, but the tag ${commit ? `is ${commit}` : 'does not exist'}`);
      continue;
    }
    const fixture = showFile(git, commit, `${FIXTURE_DIR}/${shell.fixture}`);
    const controller = showFile(git, commit, BRIDGE_CONTROLLER);
    const promoted = fixture && JSON.parse(fixture).capabilities?.stable;
    const range = controller && readBridgeRange(controller);
    if (!promoted || [...promoted].sort().join() !== [...shell.capabilities].sort().join()) {
      errors.push(`The ${role} stable shell record's capabilities differ from ${tag}'s ${FIXTURE_DIR}/${shell.fixture}`);
    }
    if (!range || range.min !== shell.bridgeProtocolMin || range.max !== shell.bridgeProtocolMax) {
      errors.push(`The ${role} stable shell record's bridge range differs from ${tag}'s BridgeController`);
    }
  }
  const latest = record.shells.latest.versionCode;
  if (newest !== null && latest !== null && newest > latest) {
    notes.push(`android/stable/${newest} is newer than the recorded latest stable shell (${latest}); update ${STABLE_SHELLS}`);
  }
  return { errors, notes };
}

function evaluate({ git = defaultGit, base, head }) {
  const changes = readChanges(git, base, head);
  const stable = readStableShells(showFile(git, head, STABLE_SHELLS) ?? '');
  const headPolicy = readSitePolicy(showFile(git, head, BRIDGE_CLIENT));
  const basePolicy = readSitePolicy(showFile(git, changes.mergeBase, BRIDGE_CLIENT));
  const classification = classifyRelease({
    ...changes,
    basePolicy,
    headPolicy,
    latestCapabilities: stable.record?.shells.latest.capabilities ?? [],
  });
  const errors = [...stable.errors];
  const notes = [];
  if (stable.record) {
    for (const check of [checkSupportedShells(headPolicy, stable.record), checkRecordAgainstTags(git, stable.record)]) {
      errors.push(...check.errors);
      notes.push(...check.notes);
    }
  }
  return { ...classification, base, head, errors, notes };
}

function summaryMarkdown(result) {
  const lines = [
    '## Android release compatibility',
    '',
    `Release class: **${result.releaseClass}**`,
    '',
    result.action,
  ];
  if (result.reasons.length) lines.push('', ...result.reasons.map((reason) => `- ${reason}`));
  if (result.notes.length) lines.push('', '**Notes**', '', ...result.notes.map((note) => `- ${note}`));
  if (result.errors.length) lines.push('', '**Release-order guard failed**', '', ...result.errors.map((error) => `- ${error}`));
  else lines.push('', 'Release-order guard passed: the site runs on the latest and previous stable shells.');
  return `${lines.join('\n')}\n`;
}

function cli(argv = process.argv.slice(2), env = process.env) {
  const options = Object.fromEntries(argv.map((arg) => {
    const match = /^--(base|head)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unexpected argument: ${arg}`);
    return [match[1], match[2]];
  }));
  const base = options.base || env.PR_BASE_SHA;
  const head = options.head || env.PR_HEAD_SHA || 'HEAD';
  if (!base) throw new Error('Usage: android-release-compatibility.cjs --base=<commit> [--head=<commit>]');
  const result = evaluate({ base, head });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `release_class=${result.releaseClass}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(result));
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`::error::${error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) cli();

module.exports = {
  EXISTING_BRIDGE_PATTERNS,
  NATIVE_CONTRACT_PATTERNS,
  checkRecordAgainstTags,
  checkSupportedShells,
  classifyRelease,
  evaluate,
  readSitePolicy,
  readStableShells,
  summaryMarkdown,
};
