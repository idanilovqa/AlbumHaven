const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const inheritedDatabaseSelectors = new Map([
  'ALBUM_HAVEN_APP_DATABASE_URL',
  'ALBUM_HAVEN_FAKE_E2E_DATABASE_URL',
  'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL',
].map((name) => [name, process.env[name]]));
for (const name of inheritedDatabaseSelectors.keys()) delete process.env[name];
const defaultConfig = require('../../playwright.config.js');
const performanceConfig = require('../../playwright.performance.config.cjs');
const originalInventoryDiscovery = process.env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY;
process.env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY = '1';
process.argv.push('--list');
const syntheticLargeLibraryConfig = require('../../playwright.synthetic-large-library.config.cjs');
process.argv.pop();
if (originalInventoryDiscovery === undefined) {
  delete process.env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY;
} else {
  process.env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY = originalInventoryDiscovery;
}
const scanPerformanceConfig = require('../../playwright.scan-performance.config.cjs');
for (const [name, value] of inheritedDatabaseSelectors) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const {
  DEFAULT_PLAYWRIGHT_PYTHON,
  resolvePlaywrightPython,
} = require('../../scripts/playwright-python.cjs');

function relativeSegments(targetPath) {
  return path.relative(path.join(__dirname, '..', '..'), targetPath).split(path.sep);
}

test('functional Playwright retains full failure traces for actionable CI diagnostics', () => {
  assert.equal(defaultConfig.use.trace, 'retain-on-failure');
  assert.equal(defaultConfig.use.screenshot, 'off');
});

test('performance Playwright retains low-overhead failure traces without perturbing timings', () => {
  const expectedTrace = {
    mode: 'retain-on-failure',
    screenshots: false,
    snapshots: false,
    sources: true,
  };
  for (const config of [performanceConfig, syntheticLargeLibraryConfig, scanPerformanceConfig]) {
    assert.deepEqual(config.use.trace, expectedTrace);
    assert.equal(config.use.screenshot, 'off');
  }
  const utilityConfigSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'playwright.utility-problematic-files.config.cjs'),
    'utf8',
  );
  assert.match(utilityConfigSource, /trace:\s*PERFORMANCE_FAILURE_TRACE/);
});

test('component Playwright passes the verified Chrome executable through launch options', () => {
  const configPath = require.resolve('../../playwright.component.config.js');
  const originalChrome = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE = '/verified/chrome-for-testing';
  delete require.cache[configPath];
  try {
    const config = require(configPath);
    assert.equal(config.use.launchOptions?.executablePath, '/verified/chrome-for-testing');
    assert.equal(config.use.executablePath, undefined);
  } finally {
    delete require.cache[configPath];
    if (originalChrome === undefined) delete process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
    else process.env.PLAYWRIGHT_CHROME_EXECUTABLE = originalChrome;
  }
});

function loadConfigHeadless(configPath, { headed = false } = {}) {
  const repoRoot = path.join(__dirname, '..', '..');
  const script = [
    `process.argv = [process.execPath, 'playwright-cli', '--list'${headed ? ", '--headed'" : ''}];`,
    `const config = require(${JSON.stringify(configPath)});`,
    'process.stdout.write(JSON.stringify(config.use.headless));',
  ].join(' ');
  const env = { ...process.env };
  delete env.PLAYWRIGHT_HEADLESS;
  delete env.PLAYWRIGHT_SERVE_REAL_APP;
  env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY = '1';
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function loadConfigBrowser(configPath, browser = '', options = {}) {
  const repoRoot = path.join(__dirname, '..', '..');
  const browserArg = browser ? `, '--browser=${browser}'` : '';
  const injectedBrowserUse = options.injectedBrowserUse
    ? [
      "const runtimeFlags = require('./scripts/playwright-runtime-flags.cjs');",
      `runtimeFlags.resolveBrowserProjectUse = () => (${JSON.stringify(options.injectedBrowserUse)});`,
    ].join(' ')
    : '';
  const script = [
    `process.argv = [process.execPath, 'playwright-cli', '--list'${browserArg}];`,
    injectedBrowserUse,
    `const config = require(${JSON.stringify(configPath)});`,
    'process.stdout.write(JSON.stringify({',
    '  projects: config.projects.map((project) => ({',
    '    name: project.name,',
    '    browserName: project.use.browserName,',
    '    channel: project.use.channel ?? null,',
    '    launchOptions: project.use.launchOptions ?? null,',
    '  })),',
    '  snapshotPathTemplate: config.snapshotPathTemplate ?? null,',
    '  timeout: config.timeout,',
    '  workers: config.workers,',
    '}));',
  ].join(' ');
  const env = { ...process.env };
  delete env.PLAYWRIGHT_BROWSER;
  delete env.PLAYWRIGHT_CHROME_EXECUTABLE;
  delete env.PLAYWRIGHT_SERVE_REAL_APP;
  env.ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY = '1';
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${configPath} (${browser || 'default'}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const browserContractConfigs = [
  './playwright.config.js',
  './playwright.lastfm-auto-timezone.config.js',
  './playwright.cover-rescan.config.js',
  './playwright.non-album-rescan.config.js',
  './playwright.performance.config.cjs',
  './playwright.scan-performance.config.cjs',
  './playwright.synthetic-large-library.config.cjs',
  './playwright.utility-problematic-files.config.cjs',
];

const performanceLaunchConfigs = [
  './playwright.performance.config.cjs',
  './playwright.scan-performance.config.cjs',
  './playwright.synthetic-large-library.config.cjs',
  './playwright.utility-problematic-files.config.cjs',
];

test('every Playwright config defaults to headless and preserves explicit headed mode', () => {
  for (const configPath of [
    './playwright.config.js',
    './playwright.lastfm-auto-timezone.config.js',
    './playwright.cover-rescan.config.js',
    './playwright.non-album-rescan.config.js',
    './playwright.performance.config.cjs',
    './playwright.scan-performance.config.cjs',
    './playwright.synthetic-large-library.config.cjs',
  ]) {
    assert.equal(loadConfigHeadless(configPath), true, `${configPath} should default headless`);
    assert.equal(
      loadConfigHeadless(configPath, { headed: true }),
      false,
      `${configPath} should preserve --headed`,
    );
  }
});

test('functional and approved performance configs default to Playwright-managed Chromium without a channel', () => {
  for (const configPath of browserContractConfigs) {
    const loaded = loadConfigBrowser(configPath);

    assert.equal(loaded.workers, 1, `${configPath} worker contract changed`);
    assert.equal(loaded.timeout, 240000, `${configPath} timeout contract changed`);
    assert.equal(loaded.projects.length, 1, configPath);
    for (const project of loaded.projects) {
      assert.equal(project.browserName, 'chromium', `${configPath} ${project.name}`);
      assert.equal(project.channel, null, `${configPath} ${project.name} should use bundled Chromium`);
    }
  }
});

test('functional and approved performance configs map explicit branded browser selections to channels', () => {
  for (const configPath of browserContractConfigs) {
    const chrome = loadConfigBrowser(configPath, 'chrome').projects[0];
    const edge = loadConfigBrowser(configPath, 'edge').projects[0];
    const chromium = loadConfigBrowser(configPath, 'chromium').projects[0];

    assert.deepEqual(
      { browserName: chrome.browserName, channel: chrome.channel },
      { browserName: 'chromium', channel: 'chrome' },
      `${configPath} Chrome mapping`,
    );
    assert.deepEqual(
      { browserName: edge.browserName, channel: edge.channel },
      { browserName: 'chromium', channel: 'msedge' },
      `${configPath} Edge mapping`,
    );
    assert.deepEqual(
      { browserName: chromium.browserName, channel: chromium.channel },
      { browserName: 'chromium', channel: null },
      `${configPath} managed Chromium mapping`,
    );
  }
});

test('performance configs preserve inherited browser launch options while adding memory measurement', () => {
  const inheritedBrowserUse = {
    browserName: 'chromium',
    launchOptions: {
      executablePath: '/verified/chrome-for-testing',
      args: ['--inherited-browser-argument'],
    },
  };

  for (const configPath of performanceLaunchConfigs) {
    const loaded = loadConfigBrowser(configPath, 'chrome', {
      injectedBrowserUse: inheritedBrowserUse,
    });
    const project = loaded.projects[0];

    assert.equal(project.browserName, 'chromium', configPath);
    assert.equal(project.channel, null, `${configPath} channel drift`);
    assert.equal(
      project.launchOptions.executablePath,
      inheritedBrowserUse.launchOptions.executablePath,
      `${configPath} pinned executable`,
    );
    assert.deepEqual(project.launchOptions.args, [
      '--inherited-browser-argument',
      '--enable-features=PerformanceMeasureMemory',
    ], `${configPath} launch arguments`);
  }
});

test('functional browser rendering uses software compositing on every host', () => {
  const project = defaultConfig.projects.find((candidate) => candidate.name === 'functional');
  assert.ok(project, 'expected the functional project');
  assert.ok(
    project.use.launchOptions.args.includes('--disable-gpu'),
    'functional screenshots must not inherit host GPU compositing',
  );
});

test('visual snapshot paths remain browser-specific while semantic project names stay stable', () => {
  for (const configPath of browserContractConfigs) {
    const snapshots = new Set();
    const projectNames = new Set();
    for (const browser of ['chromium', 'chrome', 'edge']) {
      const loaded = loadConfigBrowser(configPath, browser);

      assert.match(
        loaded.snapshotPathTemplate || '',
        new RegExp(`(?:^|[\\\\/.-])${browser}(?:[\\\\/.-]|$)`),
        `${configPath} snapshots must include the selected browser key`,
      );
      snapshots.add(loaded.snapshotPathTemplate);
      projectNames.add(loaded.projects[0].name);
    }
    assert.equal(snapshots.size, 3, `${configPath} browser snapshots must not collide`);
    assert.equal(projectNames.size, 1, `${configPath} project names should remain semantic`);
  }
});

test('scan performance Playwright config defaults to headless', () => {
  assert.equal(scanPerformanceConfig.use.headless, true);
});

test('scan performance config appends JSON output only for a runner-owned output path', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const loadReporters = (jsonOutputFile) => {
    const env = { ...process.env };
    if (jsonOutputFile) env.PLAYWRIGHT_JSON_OUTPUT_FILE = jsonOutputFile;
    else delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
    const result = spawnSync(process.execPath, ['-e', [
      "const config = require('./playwright.scan-performance.config.cjs');",
      'process.stdout.write(JSON.stringify(config.reporter));',
    ].join(' ')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const outputFile = path.join(repoRoot, 'test-results', 'playwright-performance-targets', 'scan-page', 'attempt-1', 'report.json');
  const withoutJson = loadReporters('');
  const withJson = loadReporters(outputFile);

  assert.equal(withoutJson.length, 3);
  assert.deepEqual(withoutJson.map((reporter) => reporter[0] === 'list' ? 'list' : path.basename(reporter[0])), [
    'list',
    'playwright-performance-reporter.cjs',
    'playwright-final-result-reporter.cjs',
  ]);
  assert.deepEqual(withJson.at(-1), ['json', { outputFile }]);
  assert.equal(withJson.length, 4);
});

test('all isolated app launch paths share the same default and override Python resolver', () => {
  assert.equal(resolvePlaywrightPython({}), DEFAULT_PLAYWRIGHT_PYTHON);
  assert.equal(resolvePlaywrightPython({ PLAYWRIGHT_PYTHON: 'custom-python.exe' }), 'custom-python.exe');
  const effectivePython = resolvePlaywrightPython(process.env);
  const effectivePythonPattern = new RegExp(effectivePython.replace(/\\/g, '\\\\'));
  assert.match(defaultConfig.webServer.command, effectivePythonPattern);
  assert.match(performanceConfig.webServer.command, effectivePythonPattern);
});

test('scan performance config keeps direct webServer fallback but disables it for runner-managed launch', () => {
  assert.ok(scanPerformanceConfig.webServer);
  assert.match(scanPerformanceConfig.webServer.command, /scanPerformanceApp\.py/);

  const repoRoot = path.join(__dirname, '..', '..');
  const result = spawnSync(process.execPath, ['-e', [
    "const config = require('./playwright.scan-performance.config.cjs');",
    'process.stdout.write(JSON.stringify(Boolean(config.webServer)));',
  ].join(' ')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_MANAGED_SCAN_APP: '1',
    },
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), false);
});

test('runner-managed isolated app disables Playwright webServer in every applicable config', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const fixtureRoot = path.join(repoRoot, 'test-results', 'fixture-contract');
  for (const configPath of [
    './playwright.config.js',
    './playwright.lastfm-auto-timezone.config.js',
    './playwright.cover-rescan.config.js',
    './playwright.non-album-rescan.config.js',
    './playwright.performance.config.cjs',
    './playwright.synthetic-large-library.config.cjs',
  ]) {
    const result = spawnSync(process.execPath, ['-e', [
      `const config = require(${JSON.stringify(configPath)});`,
      'process.stdout.write(JSON.stringify(Boolean(config.webServer)));',
    ].join(' ')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_MANAGED_APP: '1',
        PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
        ...(configPath.includes('synthetic-large-library') ? {
          ALBUM_HAVEN_APP_DATABASE_URL:
            'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
          ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
            'postgresql://album_haven_app_contract@localhost/album_haven_ci_contract',
          ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
          ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
          ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
        } : {}),
      },
      windowsHide: true,
    });

    assert.equal(result.status, 0, `${configPath}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout), false, configPath);
  }
});

test('default Playwright config preserves explicit isolated database and provider overrides', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const script = [
    "const config = require('./playwright.config.js');",
    'process.stdout.write(JSON.stringify({ metadata: config.metadata, env: config.webServer.env }));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_PORT: '4183',
      PLAYWRIGHT_PROVIDER_PORT: '5199',
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@db.example:5432/album_haven_fake_e2e',
      ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
        'postgresql://album_haven_app@db.example:5432/album_haven_fake_e2e',
      LASTFM_API_KEY: 'owner-api-key',
      LASTFM_API_SECRET: 'owner-api-secret',
      LASTFM_API_ROOT: 'https://owner-lastfm.example/2.0/',
      LASTFM_API_ENABLED: '1',
      LASTFM_SESSION_KEY: 'owner-session-key',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.equal(loaded.metadata.providerBaseURL, 'http://127.0.0.1:5199');
  assert.equal(
    loaded.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
    'postgresql://album_haven_migrator@db.example:5432/album_haven_fake_e2e',
  );
  assert.equal(
    loaded.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL,
    'postgresql://album_haven_app@db.example:5432/album_haven_fake_e2e',
  );
  assert.equal(loaded.env.PLAYWRIGHT_PROVIDER_PORT, '5199');
  assert.equal(loaded.env.LASTFM_API_KEY, '');
  assert.equal(loaded.env.LASTFM_API_SECRET, '');
  assert.equal(loaded.env.LASTFM_API_ROOT, '');
  assert.equal(loaded.env.LASTFM_API_ENABLED, '');
  assert.equal(loaded.env.LASTFM_SESSION_KEY, '');
});

test('default Playwright outputDir does not overlap retained performance history', () => {
  const historyDir = path.join(__dirname, '..', '..', 'test-results', 'playwrightPerformanceHistory');
  const outputDir = defaultConfig.outputDir;

  assert.ok(outputDir, 'expected default config to define outputDir');
  assert.equal(relativeSegments(outputDir).slice(0, 2).join('/'), 'test-results/playwright-artifacts');
  assert.notEqual(path.resolve(outputDir), path.resolve(historyDir));
  assert.ok(
    !path.resolve(historyDir).startsWith(path.resolve(outputDir) + path.sep),
    'retained history must not live under the transient Playwright outputDir',
  );
});

test('synthetic-large Playwright outputDir does not overlap retained performance history', () => {
  const historyDir = path.join(__dirname, '..', '..', 'test-results', 'playwrightPerformanceHistory');
  const outputDir = syntheticLargeLibraryConfig.outputDir;

  assert.ok(outputDir, 'expected local real-data config to define outputDir');
  assert.equal(relativeSegments(outputDir).slice(0, 2).join('/'), 'test-results/playwright-artifacts');
  assert.notEqual(path.resolve(outputDir), path.resolve(historyDir));
  assert.ok(
    !path.resolve(historyDir).startsWith(path.resolve(outputDir) + path.sep),
    'retained history must not live under the transient Playwright outputDir',
  );
});

test('isolated performance Playwright outputDir does not overlap retained performance history', () => {
  const historyDir = path.join(__dirname, '..', '..', 'test-results', 'playwrightPerformanceHistory');
  const outputDir = performanceConfig.outputDir;

  assert.ok(outputDir, 'expected isolated performance config to define outputDir');
  assert.equal(relativeSegments(outputDir).slice(0, 2).join('/'), 'test-results/playwright-artifacts');
  assert.notEqual(path.resolve(outputDir), path.resolve(historyDir));
  assert.ok(
    !path.resolve(historyDir).startsWith(path.resolve(outputDir) + path.sep),
    'retained history must not live under the transient Playwright outputDir',
  );
});

test('synthetic-large Playwright config forces a single worker so benchmark specs never run in parallel', () => {
  assert.equal(syntheticLargeLibraryConfig.workers, 1);
  assert.equal(syntheticLargeLibraryConfig.fullyParallel, false);
});

test('default Playwright config stays pointed at the functional specs directory', () => {
  assert.equal(
    relativeSegments(defaultConfig.testDir).join('/'),
    'tests/e2e/specs',
  );
});

test('FTC-NON-ALBUM-013 has a dedicated restart-isolated config and is absent from the default suite', () => {
  const configPath = path.join(__dirname, '..', '..', 'playwright.non-album-rescan.config.js');
  assert.ok(fs.existsSync(configPath), 'expected a dedicated non-album rescan config');

  const isolatedConfig = require(configPath);
  const isolatedProject = isolatedConfig.projects[0];
  const defaultProject = defaultConfig.projects[0];
  const targetTitle = 'FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details';
  const playwrightFullTitle = `nonAlbumRarity.spec.js › ${targetTitle}`;

  assert.equal(isolatedProject.name, 'non-album-rescan');
  assert.equal(isolatedProject.testMatch.test('nonAlbumRarity.spec.js'), true);
  assert.equal(isolatedProject.testMatch.test('searchTreeCorrectness.spec.js'), false);
  assert.equal(isolatedProject.grep.test(targetTitle), true);
  assert.equal(isolatedProject.grep.test(playwrightFullTitle), true);
  assert.equal(isolatedProject.grep.test('FTC-NON-ALBUM-012 preserves a rarity edit'), false);
  assert.equal(defaultProject.grepInvert.test(targetTitle), true);
  assert.equal(defaultProject.grepInvert.test(playwrightFullTitle), true);
  assert.equal(
    defaultProject.grepInvert.test('FTC-NON-ALBUM-012 preserves a rarity edit'),
    false,
    'the default suite must exclude only the restart-owning non-album case',
  );
});

test('isolated performance Playwright config stays pointed at the performance specs directory', () => {
  assert.equal(
    relativeSegments(performanceConfig.testDir).join('/'),
    'tests/e2e/performance',
  );
});

for (const [label, config] of [
  ['default', defaultConfig],
  ['performance', performanceConfig],
]) {
  test(`${label} Playwright config launches the isolated Postgres app on managed support ports`, () => {
    assert.equal(config.workers, 1);
    assert.equal(config.fullyParallel, false);
    assert.equal(config.timeout, 240000);
    assert.equal(config.use.baseURL, 'http://127.0.0.1:4173');
    assert.equal(config.metadata.providerBaseURL, 'http://127.0.0.1:4175');
    assert.deepEqual(
      config.projects.map((project) => project.name),
      label === 'default'
        ? ['functional']
        : ['idle-memory'],
    );
    assert.ok(config.webServer, `expected ${label} config to define a managed web server`);
    assert.match(config.webServer.command, /isolatedLibraryApp\.py/);
    assert.doesNotMatch(config.webServer.command, /fakeLibraryApp\.py/);
    assert.match(config.webServer.command, /--port 4173\b/);
    assert.match(config.webServer.command, /--provider-port 4175\b/);
    assert.equal(config.webServer.url, 'http://127.0.0.1:4173/status');
    assert.equal(config.webServer.reuseExistingServer, false);
    assert.equal(
      config.webServer.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
      'postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e',
    );
    assert.equal(
      config.webServer.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL,
      'postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e',
    );
    assert.equal(config.webServer.env.PLAYWRIGHT_PROVIDER_PORT, '4175');
    assert.equal(
      config.webServer.env.ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL,
      config.metadata.providerBaseURL,
    );
    assert.equal(config.webServer.env.LASTFM_API_KEY, '');
    assert.equal(config.webServer.env.LASTFM_API_SECRET, '');
    assert.equal(config.webServer.env.LASTFM_API_ROOT, '');
  });
}
