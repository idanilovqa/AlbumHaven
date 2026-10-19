const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { FullConfigInternal, ipc } = require('playwright/lib/common');
const repoRoot = path.resolve(__dirname, '../..');
const nativePath = path.join(repoRoot, 'playwright.native-acceptance.config.js');
const fixturePath = path.join(repoRoot, 'tests/e2e/fixtures/nativeAcceptanceTest.js');
const source = fs.readFileSync(fixturePath, 'utf8');

function config(manifest) {
  const env = { ...process.env, PLAYWRIGHT_PORT: '6270', ALBUM_HAVEN_HOME_FEEDBACK_MANIFEST: manifest };
  const load = file => {
    const module = { exports: {} }, localRequire = createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: repoRoot,
      require: key => key === './playwright.home-feedback.config.js'
        ? load(path.join(repoRoot, key)) : localRequire(key),
      process: { argv: [process.execPath, 'playwright-cli'], env } }, { filename: file });
    return module.exports;
  };
  return { native: load(nativePath), home: load(path.join(repoRoot, 'playwright.home-feedback.config.js')) };
}
function manifest() {
  return { scenario: 'native-acceptance', version: 1, cases: Object.fromEntries([1, 2, 3, 4, 5].map(n => {
    const key = `NA00${n}`, album = kind => ({ key: `key-${key}-${kind}`, ref: `ref-${key}-${kind}`,
      title: `Native ${key} ${kind}`, artist: `Native ${key} North`, privatePath: 'must-not-escape' });
    return [key, { actor: { username: `native-${key.toLowerCase()}-actor`, password: 'private-passphrase' }, public: {
      caseKey: key, friend: { accountRef: `friend-${key}`, displayName: `Friend ${key}` },
      catalog: { albums: { first: album('First'), second: album('Second') }, tracks: Object.fromEntries(
        ['one', 'two', 'quiet', 'three', 'four', 'still'].map(track => [track, { title: `Native ${key} ${track}`, path: 'private' }])) },
      top: { ref: `top-${key}`, title: `Native ${key} Ordered Top` }, privateExtra: 'must-not-escape',
    } }];
  })) };
}
function harness(options = {}) {
  const attached = [], events = [], read = [], sessions = [], secretFills = [];
  const surface = { shellVisible: true, loginVisible: false, closed: false, url: 'http://127.0.0.1:6270/?surface=home' };
  const makePage = () => {
    const listeners = new Map();
    return { listeners, on(name, fn) { listeners.set(name, fn); }, off(name) { listeners.delete(name); },
      async goto() {}, url: () => surface.url, isClosed: () => surface.closed,
      async screenshot() { events.push('screenshot'); if (options.captureFailure) throw new Error('raw private error'); return Buffer.from('image'); } };
  };
  const page = makePage(), makeContext = target => {
    const listeners = new Map(), ownedPages = [target];
    return { pages: () => ownedPages, on(name, listener) { listeners.set(name, listener); },
      off(name) { listeners.delete(name); },
      addPage() { const added = makePage(); ownedPages.push(added); listeners.get('page')?.(added); return added; } };
  };
  const context = makeContext(page);
  class Page {
    constructor(target) {
      this.page = target; this.shell = { isVisible: async () => surface.shellVisible }; this.login = { isVisible: async () => surface.loginVisible };
      this.username = { fill: async value => secretFills.push(['username', value]) };
      this.password = { fill: async value => secretFills.push(['password', value]) };
      this.signIn = { click: async () => { if (options.authFailure) throw new Error('private credential error'); } };
      this.home = {}; this.sections = {};
    }
  }
  class Actions { constructor(view, input) { this.view = view; Object.assign(this, input); } }
  const sandbox = { Buffer, URL, Set, Map, Object, JSON, Error,
    fs: { readFile: async file => { read.push(file); return JSON.stringify(options.manifest || manifest()); } },
    process: { env: { PLAYWRIGHT_MANAGED_APP: '1', GITHUB_SHA: 'a'.repeat(40), ...options.env } },
    base: { extend: definitions => definitions }, NativeAcceptancePage: Page, NativeAcceptanceActions: Actions,
    expect: () => ({ async toBeVisible() {}, async toBeHidden() {} }),
  };
  const transformed = source.replace(/^import .*;\n/gm, '').replace(/^export \{ expect \};\n/gm, '').replace(/\bexport /g, '');
  vm.runInNewContext(`${transformed}\nthis.fixture = test; this.publicCase = publicNativeCase; this.validate = validateNativeManifest;`, sandbox);
  const mobileBrowserSessions = {
    async create(value) { sessions.push(value); const target = makePage(); return { page: target, context: makeContext(target) }; },
    async closeAll() { events.push('closeAll'); if (options.cleanupFailure) throw new Error('private cleanup path'); },
  };
  const info = { annotations: [], title: 'FTC-NATIVE-ACCEPT-001 sample', status: 'passed', expectedStatus: 'passed',
    project: { use: { baseURL: 'http://127.0.0.1:6270', viewport: { width: 1440, height: 960 } } },
    async attach(name, value) { events.push('attach'); if (options.outcomeFailure && name.endsWith('-outcome.json')) throw new Error('private attachment path'); attached.push({ name, ...value }); } };
  return { sandbox, page, context, info, attached, events, read, sessions, secretFills, surface,
    run: use => sandbox.fixture.native({ page, context, nativeManifest: options.manifest || manifest(), mobileBrowserSessions }, use, info) };
}

test('native config differs only in bounded scenario and credential-safe artifact overrides', () => {
  const { native, home } = config('');
  assert.equal(native.testDir, './tests/e2e/nativeAcceptance');
  assert.equal(native.outputDir, './test-results/playwright-artifacts/native-acceptance');
  assert.equal(native.projects[0].name, 'native-acceptance-chrome');
  assert.equal(native.use.trace, 'off'); assert.equal(native.use.screenshot, 'off');
  for (const key of ['workers', 'retries', 'timeout', 'fullyParallel', 'expect', 'metadata']) {
    assert.equal(JSON.stringify(native[key]), JSON.stringify(home[key]), key);
  }
  assert.equal(native.webServer, undefined); assert.equal(native.metadata.homeFeedbackManifest, '');
  assert.equal(home.use.trace, 'retain-on-failure'); assert.equal(home.use.screenshot, 'only-on-failure');
  assert.equal(native.use.recordVideo, undefined); assert.equal(native.use.recordHar, undefined); assert.equal(native.use.storageState, undefined);
});

test('native worker manifest authority survives config reload and rejects unwrapped execution', async () => {
  const location = { configDir: repoRoot, resolvedConfigFile: nativePath };
  const parent = new FullConfigInternal(location, config('/parent/home-feedback-manifest.json').native, {});
  const serialized = ipc.serializeConfig(parent, false);
  const worker = new FullConfigInternal(location, config('/worker/home-feedback-manifest.json').native, {}, JSON.parse(serialized.metadata));
  const h = harness(); let received;
  await h.sandbox.fixture.nativeManifest[0]({}, async value => { received = value; }, { config: worker.config });
  assert.deepEqual(h.read, ['/parent/home-feedback-manifest.json']); assert.equal(received.scenario, 'native-acceptance');
  const blocked = harness({ env: { PLAYWRIGHT_MANAGED_APP: '' } });
  await assert.rejects(blocked.sandbox.fixture.nativeManifest[0]({}, async () => assert.fail(), { config: worker.config }), /runner-owned/);
  assert.equal(blocked.read.length, 0);
});

test('native manifests reject wrong scenario/version and incomplete or extra case membership', () => {
  const h = harness();
  for (const change of [m => { m.scenario = 'home-feedback'; }, m => { m.version = 2; },
    m => { delete m.cases.NA003; }, m => { m.cases.FB001 = {}; }]) {
    const m = manifest(); change(m); assert.throws(() => h.sandbox.validate(m), /exact scenario version/);
  }
  const data = h.sandbox.publicCase(manifest(), 'NA001');
  const encoded = JSON.stringify(data);
  assert.doesNotMatch(encoded, /password|username|private|NA002|actor-/);
  assert.equal(data.catalog.albums.first.title, 'Native NA001 First');
  assert.throws(() => h.sandbox.publicCase(manifest(), 'FB001'), /Unknown native/);
});

test('native normal credentials stay inside sign-in and success artifacts precede session cleanup', async () => {
  const h = harness();
  await h.run(async actions => {
    assert.equal(actions.credentials, undefined); assert.equal(actions.data.actor, undefined);
    await actions.signIn(); await actions.capture('own-preferences');
  });
  assert.deepEqual(h.secretFills, [['username', 'native-na001-actor'], ['password', 'private-passphrase']]);
  assert.equal(h.attached.length, 2); assert.ok(h.events.indexOf('screenshot') < h.events.indexOf('closeAll'));
  assert.ok(h.events.indexOf('closeAll') < h.events.lastIndexOf('attach'));
  const outcome = JSON.parse(h.attached[1].body);
  assert.equal(outcome.assertionsCompleted, true); assert.equal(outcome.screenshot, 'captured');
  assert.doesNotMatch(h.attached[1].body, /password|username|path|stack|cookie|http/);
});

test('native failure before authentication withholds screenshots and sanitizes authentication errors', async () => {
  const h = harness({ authFailure: true });
  await assert.rejects(h.run(actions => actions.signIn()), /^Error: Native acceptance normal sign-in failed\.$/);
  assert.equal(h.events.includes('screenshot'), false);
  assert.equal(JSON.parse(h.attached[0].body).screenshot, 'withheld'); assert.ok(h.events.includes('closeAll'));
});

test('native pageerrors fail generically, capture safely and never attach raw errors', async () => {
  const h = harness();
  await assert.rejects(h.run(async actions => {
    await actions.signIn(); await actions.capture('own-preferences');
    h.page.listeners.get('pageerror')(new Error('private path and credentials'));
  }), /unexpected browser errors/);
  const outcome = JSON.parse(h.attached.at(-1).body);
  assert.equal(outcome.unexpectedErrorCount, 1); assert.equal(outcome.assertionsCompleted, false);
  assert.doesNotMatch(h.attached.at(-1).body, /private path|credentials/); assert.ok(h.events.includes('closeAll'));
});

test('native mandatory screenshot cannot silently pass when absent or unavailable', async () => {
  for (const captureFailure of [false, true]) {
    const h = harness({ captureFailure });
    await assert.rejects(h.run(async actions => { await actions.signIn(); if (captureFailure) await actions.capture('own-preferences'); }),
      /missing mandatory|capture is unavailable/);
    assert.equal(JSON.parse(h.attached.at(-1).body).assertionsCompleted, false);
    assert.ok(h.events.includes('closeAll'));
  }
});

test('fresh mobile session has explicit touch settings, guarded ownership and no recording exports', async () => {
  const h = harness(); h.info.title = 'FTC-NATIVE-ACCEPT-005 sample';
  await h.run(async native => {
    const mobile = await native.mobileSession(); await mobile.signIn();
    await mobile.capture('artist-sheet'); await mobile.capture('returned-parent');
  });
  assert.equal(JSON.stringify(h.sessions), JSON.stringify([{ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }]));
  assert.ok(h.events.includes('closeAll'));
  assert.doesNotMatch(source, /\.tracing\.|recordVideo\s*:|recordHar\s*:|storageState\s*\(/);
  assert.match(source, /mobileBrowserSessions\.create/);
});

test('native scenario dispatch is closed and selected before seed or production startup', () => {
  const launcher = fs.readFileSync(path.join(repoRoot, 'tests/e2e/support/homeFeedbackApp.py'), 'utf8');
  assert.match(launcher, /choices=\("home-feedback", "native-acceptance"\), default="home-feedback"/);
  assert.ok(launcher.indexOf('if args.scenario == "native-acceptance"') < launcher.indexOf('prepare_isolated_database(setup_url, runtime_url)'));
  assert.ok(launcher.indexOf('fixture = seed_data(setup_url)') < launcher.indexOf('from music_app import create_asgi_app'));
  assert.doesNotMatch(launcher, /importlib|__import__|app\.config.*scenario/);
  const spec = fs.readFileSync(path.join(repoRoot, 'tests/e2e/nativeAcceptance/nativeAcceptance.spec.js'), 'utf8');
  const cases = [...spec.matchAll(/test\('([^']+)'/g)].map(match => match[1]);
  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/ci/functional-shards.json'), 'utf8'));
  const enrolled = contract.shards.flatMap(row => row.invocations).find(row => row.config === 'playwright.native-acceptance.config.js');
  assert.deepEqual(cases, enrolled.cases.map(row => row.case));
  assert.equal((spec.match(/@area:native-acceptance/g) || []).length, 5);
});

test('native authenticated assertion failure preserves original error and fresh-session pageerrors fail', async () => {
  const h = harness(), original = new Error('synthetic assertion');
  await assert.rejects(h.run(async actions => { await actions.signIn(); throw original; }), error => error === original);
  assert.equal(h.attached[0].name, 'NA001-failure-1.png'); assert.ok(h.events.includes('closeAll'));
  const mobile = harness(); mobile.info.title = 'FTC-NATIVE-ACCEPT-005 sample';
  await assert.rejects(mobile.run(async native => {
    const actions = await native.mobileSession(); await actions.signIn();
    await actions.capture('artist-sheet'); await actions.capture('returned-parent');
    actions.view.page.listeners.get('pageerror')(new Error('do not serialize'));
  }), /unexpected browser errors/);
  assert.equal(JSON.parse(mobile.attached.at(-1).body).unexpectedErrorCount, 1);
  assert.ok(mobile.events.includes('closeAll'));
});

for (const [name, changed, expectedCapture] of [
  ['hidden product shell', { shellVisible: false }, 'withheld'],
  ['reappeared sign-in', { loginVisible: true }, 'withheld'],
  ['foreign origin', { url: 'https://foreign.example.test/' }, 'withheld'],
  ['closed page', { closed: true }, 'unavailable'],
]) {
  test(`native post-auth failure refuses screenshots for ${name}`, async () => {
    const h = harness(), original = new Error('synthetic primary assertion');
    await assert.rejects(h.run(async actions => {
      await actions.signIn(); Object.assign(h.surface, changed); throw original;
    }), error => error === original);
    assert.equal(h.events.includes('screenshot'), false);
    assert.equal(h.attached.length, 1);
    const outcome = JSON.parse(h.attached[0].body);
    assert.equal(outcome.screenshot, expectedCapture); assert.equal(outcome.assertionsCompleted, false);
    assert.doesNotMatch(h.attached[0].body, /private|foreign\.example|synthetic primary|password|stack/);
    assert.ok(h.events.includes('closeAll'));
  });
}

for (const options of [{ outcomeFailure: true }, { cleanupFailure: true }, { outcomeFailure: true, cleanupFailure: true }]) {
  test(`native preserves primary identity when secondary teardown fails ${JSON.stringify(options)}`, async () => {
    const h = harness(options), original = new Error('synthetic primary assertion');
    await assert.rejects(h.run(async actions => { await actions.signIn(); throw original; }), error => error === original);
    assert.ok(h.events.includes('screenshot')); assert.ok(h.events.includes('closeAll'));
    assert.deepEqual(h.info.annotations.map(row => row.type), [
      ...(options.cleanupFailure ? ['native-session-cleanup'] : []),
      ...(options.outcomeFailure ? ['native-outcome-attachment'] : []),
    ]);
    assert.doesNotMatch(JSON.stringify(h.info.annotations), /private|path|stack|synthetic primary/);
    if (!options.outcomeFailure) assert.equal(JSON.parse(h.attached.at(-1).body).assertionsCompleted, false);
  });
}

test('native cleanup-only or attachment-only failure cannot pass', async () => {
  for (const options of [{ cleanupFailure: true }, { outcomeFailure: true }]) {
    const h = harness(options);
    await assert.rejects(h.run(async actions => { await actions.signIn(); await actions.capture('own-preferences'); }),
      /Native owned-session cleanup failed|Native outcome attachment failed/);
    assert.ok(h.events.includes('closeAll')); assert.equal(h.info.annotations.length, 1);
    if (!options.outcomeFailure) assert.equal(JSON.parse(h.attached.at(-1).body).assertionsCompleted, false);
  }
});

test('native observes pageerrors from later context page events and detaches their listeners', async () => {
  const h = harness(); let added;
  await assert.rejects(h.run(async actions => {
    await actions.signIn(); await actions.capture('own-preferences');
    added = h.context.addPage();
    added.listeners.get('pageerror')(new Error('private new-page error'));
  }), /unexpected browser errors/);
  assert.equal(JSON.parse(h.attached.at(-1).body).unexpectedErrorCount, 1);
  assert.equal(added.listeners.has('pageerror'), false);
  assert.ok(h.events.includes('closeAll'));
});
