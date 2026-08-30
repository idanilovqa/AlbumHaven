const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHECKER_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'check-e2e-production-parity.cjs');
const PR_AGENT_OUTPUT_GUARD_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'require-pr-agent-review-output.cjs',
);
const PACKAGE_PATH = path.resolve(__dirname, '..', '..', 'package.json');
const PR_GATES_PATH = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'pr-gates.yml');
const checkerExists = fs.existsSync(CHECKER_PATH);
const contractTest = checkerExists ? test : test.skip;

function loadChecker() {
  return require(CHECKER_PATH);
}

function scanSnippet(filePath, source) {
  return loadChecker().scanSource({ filePath, source });
}

function ruleIds(result) {
  return new Set((result.violations || []).map((violation) => violation.ruleId));
}

function assertRejected(result, expectedRuleIds) {
  const actual = ruleIds(result);
  for (const expected of expectedRuleIds) {
    assert.equal(actual.has(expected), true, `Expected parity violation ${expected}; got ${[...actual].join(', ')}`);
  }
}

function makeFixtureRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  return root;
}

function workflowJobSource(workflow, jobName, nextJobName = null) {
  const start = workflow.indexOf(`  ${jobName}:`);
  const end = nextJobName === null
    ? workflow.length
    : workflow.indexOf(`\n  ${nextJobName}:`, start);
  assert.notEqual(start, -1, `Missing workflow job ${jobName}`);
  if (nextJobName !== null) {
    assert.notEqual(end, -1, `Missing workflow job after ${jobName}: ${nextJobName}`);
  }
  return workflow.slice(start, end);
}

function workflowStepSource(jobSource, stepName, nextStepName = null) {
  const startMarker = `      - name: ${stepName}`;
  const start = jobSource.indexOf(startMarker);
  const end = nextStepName === null
    ? jobSource.length
    : jobSource.indexOf(`\n      - name: ${nextStepName}`, start);
  assert.notEqual(start, -1, `Missing workflow step ${stepName}`);
  assert.notEqual(end, -1, `Missing workflow step after ${stepName}: ${nextStepName}`);
  return jobSource.slice(start, end);
}

test('production parity checker module exists', () => {
  assert.equal(
    checkerExists,
    true,
    'Missing scripts/check-e2e-production-parity.cjs',
  );
});

contractTest('exports the scanRepo, scanSource, and report API', () => {
  const checker = loadChecker();
  assert.equal(typeof checker.scanRepo, 'function');
  assert.equal(typeof checker.scanSource, 'function');
  assert.equal(typeof checker.report, 'function');
});

contractTest('package and PR gates expose a blocking static production-parity check', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const workflow = fs.readFileSync(PR_GATES_PATH, 'utf8');

  assert.equal(
    packageJson.scripts['check:e2e-production-parity'],
    'node scripts/check-e2e-production-parity.cjs',
  );
  assert.match(workflow, /^  e2e_production_parity:\r?$/m);
  assert.match(workflow, /run: npm run check:e2e-production-parity/);
  assert.match(workflow, /needs\.e2e_production_parity\.result == 'success'/);
  const functionalJob = workflowJobSource(workflow, 'e2e_functional', 'e2e_performance_ci');
  const performanceJob = workflowJobSource(workflow, 'e2e_performance_ci', 'pr_agent_review');
  for (const job of [functionalJob, performanceJob]) {
    assert.doesNotMatch(job, /if: \$\{\{ false \}\}/);
    assert.match(
      job,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
  }
});

contractTest('JavaScript PR gate provisions the Python used by physical-tag helper tests', () => {
  const workflow = fs.readFileSync(PR_GATES_PATH, 'utf8');
  const javascriptJob = workflowJobSource(workflow, 'test_js', 'test_python');

  assert.match(javascriptJob, /uses: actions\/setup-python@v5/);
  assert.match(javascriptJob, /python-version: "3\.11"/);
  assert.match(javascriptJob, /python -m pip install -r requirements\.txt/);
  assert.match(
    javascriptJob,
    /\$env:PLAYWRIGHT_PYTHON = Join-Path \$env:pythonLocation "python\.exe"[\s\S]*npm run test:js:all/,
  );
});

contractTest('portable JavaScript gate forwards the setup-python executable to physical-tag helpers', () => {
  const workflow = fs.readFileSync(PR_GATES_PATH, 'utf8');
  const portableJob = workflowJobSource(workflow, 'test_js', 'test_components');

  assert.match(
    portableJob,
    /name: Run JavaScript tests\s+env:\s+PLAYWRIGHT_PYTHON: \$\{\{ env\.pythonLocation \}\}\/bin\/python\s+run: npm run test:js:all/,
  );
});

contractTest('hosted review gates fail closed without credentials and run their review actions when configured', () => {
  const workflow = fs.readFileSync(PR_GATES_PATH, 'utf8');
  const prAgentJob = workflowJobSource(workflow, 'pr_agent_review', 'codex_review');
  const codexJob = workflowJobSource(workflow, 'codex_review');
  const prAgentCredentialGuard = workflowStepSource(
    prAgentJob,
    'Require OpenAI credential for PR Agent review',
    'PR Agent action step',
  );
  const prAgentAction = workflowStepSource(
    prAgentJob,
    'PR Agent action step',
    'Require PR Agent review output',
  );
  const prAgentOutputGuard = workflowStepSource(prAgentJob, 'Require PR Agent review output');
  const codexCredentialGuard = workflowStepSource(
    codexJob,
    'Require OpenAI credential for Codex review',
    'Checkout',
  );
  const codexCheckout = workflowStepSource(codexJob, 'Checkout', 'Run Codex');
  const codexAction = workflowStepSource(codexJob, 'Run Codex', 'Require Codex review output file');
  const codexOutputGuard = workflowStepSource(
    codexJob,
    'Require Codex review output file',
    'Upload Codex review output',
  );
  const codexArtifact = workflowStepSource(
    codexJob,
    'Upload Codex review output',
    'Post Codex feedback',
  );
  const codexComment = workflowStepSource(codexJob, 'Post Codex feedback');

  assert.doesNotMatch(prAgentJob, /^    env:\r?\n\s+PR_AGENT_OPENAI_API_KEY:/m);
  assert.match(prAgentCredentialGuard, /PR_AGENT_OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(prAgentCredentialGuard, /if \[\[ -z "\$\{PR_AGENT_OPENAI_API_KEY:-\}" \]\]; then[\s\S]*?exit 1/);
  assert.doesNotMatch(prAgentCredentialGuard, /^        continue-on-error:/m);
  assert.match(
    prAgentAction,
    /- name: PR Agent action step\r?\n\s+id: pr_agent\r?\n\s+uses: the-pr-agent\/pr-agent@7267ae1f7b855e7d4a3a34918d9b6c5683db3c12/,
  );
  assert.doesNotMatch(prAgentAction, /^        (?:if|continue-on-error):/m);
  assert.match(prAgentAction, /OPENAI_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(prAgentAction, /github_action_config\.auto_review: "true"/);
  assert.match(prAgentAction, /github_action_config\.auto_describe: "false"/);
  assert.match(prAgentAction, /github_action_config\.auto_improve: "false"/);
  assert.match(
    prAgentAction,
    /github_action_config\.pr_actions: '\["opened", "reopened", "ready_for_review", "synchronize"\]'/,
  );
  assert.match(prAgentAction, /github_action_config\.enable_output: "true"/);
  assert.match(prAgentOutputGuard, /PR_AGENT_REVIEW_OUTPUT: \$\{\{ steps\.pr_agent\.outputs\.review \}\}/);
  assert.match(prAgentOutputGuard, /run: node scripts\/require-pr-agent-review-output\.cjs/);
  assert.doesNotMatch(prAgentOutputGuard, /^        (?:if|continue-on-error):/m);
  assert.doesNotMatch(prAgentOutputGuard, /(?:PR_AGENT_)?OPENAI_API_KEY/);
  assert.doesNotMatch(prAgentJob, /[Ss]kip.*(?:credential|key)|if:.*PR_AGENT_OPENAI_API_KEY/);

  assert.doesNotMatch(codexJob, /^    env:\r?\n\s+CODEX_OPENAI_API_KEY:/m);
  assert.match(codexCredentialGuard, /CODEX_OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(codexCredentialGuard, /if \[\[ -z "\$\{CODEX_OPENAI_API_KEY:-\}" \]\]; then[\s\S]*?exit 1/);
  assert.doesNotMatch(codexCredentialGuard, /^        continue-on-error:/m);
  assert.match(codexAction, /- name: Run Codex\r?\n\s+id: run_codex\r?\n\s+uses: openai\/codex-action@v1/);
  assert.doesNotMatch(codexAction, /^        (?:if|continue-on-error):/m);
  assert.match(codexAction, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(codexAction, /output-file: codex-output\.md/);
  assert.match(codexJob, /^      issues: write\r?\n      pull-requests: write$/m);
  assert.match(codexOutputGuard, /run: test -s codex-output\.md/);
  assert.match(codexArtifact, /if: \$\{\{ always\(\) \}\}/);
  assert.match(codexArtifact, /uses: actions\/upload-artifact@v4/);
  assert.match(codexArtifact, /name: codex-review-output/);
  assert.match(codexArtifact, /path: codex-output\.md/);
  assert.match(codexArtifact, /if-no-files-found: error/);
  assert.match(codexComment, /uses: actions\/github-script@v7/);
  assert.match(codexComment, /fs\.readFileSync\('codex-output\.md', 'utf8'\)\.trim\(\)/);
  assert.match(codexComment, /body,/);
  for (const repositoryControlledStep of [codexCheckout, codexOutputGuard, codexArtifact, codexComment]) {
    assert.doesNotMatch(repositoryControlledStep, /OPENAI_API_KEY|CODEX_OPENAI_API_KEY/);
  }
  assert.doesNotMatch(codexJob, /^    outputs:/m);
  assert.doesNotMatch(workflow, /^  codex_review_comment:/m);
  assert.doesNotMatch(workflow, /needs\.codex_review\.outputs|steps\.run_codex\.outputs/);
  assert.doesNotMatch(codexJob, /[Ss]kip.*(?:credential|key)|if:.*CODEX_OPENAI_API_KEY/);
});

contractTest('hosted review jobs still run after failed E2E guards', () => {
  const workflow = fs.readFileSync(PR_GATES_PATH, 'utf8');
  const prAgentJob = workflowJobSource(workflow, 'pr_agent_review', 'codex_review');
  const codexJob = workflowJobSource(workflow, 'codex_review');

  for (const reviewJob of [prAgentJob, codexJob]) {
    const condition = reviewJob.match(/^    if: .*$/m)?.[0] || '';
    assert.match(reviewJob, /needs:[\s\S]*?- e2e_functional[\s\S]*?- e2e_performance_ci/);
    assert.match(condition, /if: \$\{\{ always\(\)/);
    assert.doesNotMatch(condition, /needs\.e2e_functional\.result/);
    assert.doesNotMatch(condition, /needs\.e2e_performance_ci\.result/);
  }
});

test('PR Agent review-output guard accepts only a nonempty JSON object', () => {
  const { parseReviewOutput } = require(PR_AGENT_OUTPUT_GUARD_PATH);

  assert.deepEqual(parseReviewOutput('{"review":{"key_issues_to_review":[]}}'), {
    review: { key_issues_to_review: [] },
  });
  for (const invalid of [undefined, '', ' ', 'null', '[]', '"review"', '{}', '{broken']) {
    assert.throws(() => parseReviewOutput(invalid));
  }
});

test('PR Agent review-output guard CLI fails closed for missing output', () => {
  const env = { ...process.env };
  delete env.PR_AGENT_REVIEW_OUTPUT;
  const missing = childProcess.spawnSync(process.execPath, [PR_AGENT_OUTPUT_GUARD_PATH], {
    cwd: path.dirname(PR_AGENT_OUTPUT_GUARD_PATH),
    encoding: 'utf8',
    env,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::PR Agent completed without producing/);

  const valid = childProcess.spawnSync(process.execPath, [PR_AGENT_OUTPUT_GUARD_PATH], {
    cwd: path.dirname(PR_AGENT_OUTPUT_GUARD_PATH),
    encoding: 'utf8',
    env: { ...process.env, PR_AGENT_REVIEW_OUTPUT: '{"review":{"estimated_effort_to_review_[1-5]":2}}' },
  });
  assert.equal(valid.status, 0, valid.stderr);
});

contractTest('allows isolated pre-start setup, generated media, and annotated read-only measurement', () => {
  const setup = scanSnippet('tests/e2e/support/seedIsolatedLibrary.py', `
def seed_before_start(connection, temp_root, provider_port):
    connection.execute("select payload from app.e2e_problematic_file_fixture_seeds")
    generated_media = temp_root / "generated" / "track.mp3"
    provider_base_url = f"http://127.0.0.1:{provider_port}/musicbrainz"
    seed_normal_product_tables(connection, generated_media, provider_base_url)
  `);
  const browser = scanSnippet('tests/e2e/helpers/performanceMeasurements.js', `
// parity-check: allow-read-only-measurement-evaluate -- browser performance sampling
const metrics = await page.evaluate(() => ({
  heap: performance.memory?.usedJSHeapSize || 0,
  width: document.documentElement.clientWidth,
}));
// parity-check: allow-read-only-measurement-evaluate -- local calculations over DOM measurements
const bounds = await locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  const width = rect.width;
  const keys = Object.keys(element.dataset).sort();
  return { keys, width, visible: width > 0 };
});
  `);

  assert.deepEqual(setup.violations, []);
  assert.deepEqual(browser.violations, []);
});

contractTest('atomic evaluateAll reads require a nearby annotation without allowing mutation', () => {
  const unannotated = scanSnippet('tests/e2e/actions/coverLookupActions.js', `
return cards.evaluateAll((elements, selectors) => elements.map((card) => ({
  resolution: card.querySelector(selectors.resolution)?.textContent || '',
})), { resolution: pom.localCoverResolutionWithinCardSelector });
  `);
  assertRejected(unannotated, ['behavior-driving-evaluate']);

  const annotated = scanSnippet('tests/e2e/actions/coverLookupActions.js', `
// parity-check: allow-read-only-measurement-evaluate -- atomically read rendered cover candidate evidence
return cards.evaluateAll((elements, selectors) => elements.map((card) => ({
  resolution: card.querySelector(selectors.resolution)?.textContent || '',
})), { resolution: pom.localCoverResolutionWithinCardSelector });
  `);
  assert.deepEqual(annotated.violations, []);

  const annotatedMutation = scanSnippet('tests/e2e/actions/coverLookupActions.js', `
// parity-check: allow-read-only-measurement-evaluate -- annotation must not permit mutation
return cards.evaluateAll((elements) => {
  elements[0].setAttribute('data-selected', '1');
  return elements.length;
});
  `);
  assertRejected(annotatedMutation, ['behavior-driving-evaluate']);
});

contractTest('rejects production branches and production references to test-only seams', () => {
  for (const [filePath, source] of [
    ['app.py', 'if os.environ.get("PLAYWRIGHT_MANAGED_APP"): start_fixture_app()'],
    ['config.py', 'TESTING = os.getenv("TESTING") == "1"'],
    ['music_app/routes/read.py', 'if E2E: return fixture_payload'],
    ['music_app/services/library.py', 'select * from app.e2e_problematic_file_fixture_seeds'],
    ['music_app/routes/debug.py', '@router.get("/__e2e/ready")'],
  ]) {
    assertRejected(scanSnippet(filePath, source), ['production-test-seam']);
  }
});

contractTest('rejects support apps that augment or internally initialize the production app', () => {
  const result = scanSnippet('tests/e2e/support/augmentedApp.py', `
app = create_asgi_app()
app.include_router(test_router)
app.add_middleware(FixtureMiddleware)
app.state.library_state = injected_state
hydrate_library_state_for_config(app.state.library_state, config)
start_runtime_workers(app)
  `);

  assertRejected(result, ['production-app-augmentation']);
});

contractTest('rejects support decorators, arbitrary app state injection, and post-factory control hooks', () => {
  const augmentations = [
    "@app.get('/__e2e/state')\ndef e2e_state(): return {}",
    "@app.post('/__e2e/reset')\ndef e2e_reset(): return {'ok': True}",
    "@app.middleware('http')\nasync def fixture_middleware(request, call_next): return await call_next(request)",
    'app.state.fixture_payload = seeded_payload',
    'app.state.sampler = install_sampler(app)',
    'state_service.init_state(app)',
    'start_background_refresh_for_state(app.state.library_state)',
    'start_sampler(app)',
    'install_control_hooks(app)',
  ];
  for (const augmentation of augmentations) {
    const result = scanSnippet(
      'tests/e2e/support/controlledApp.py',
      `app = create_asgi_app()\n${augmentation}`,
    );
    assertRejected(result, ['production-app-augmentation']);
  }
});

contractTest('rejects general Playwright and E2E observation in production but ignores harmless TESTING prose', () => {
  for (const [filePath, source] of [
    ['app.py', 'port = os.getenv("PLAYWRIGHT_PORT")'],
    ['config.py', 'if config.get("PLAYWRIGHT_BROWSER"): enable_browser_mode()'],
    ['music_app/runtime.py', 'enabled = os.environ.get("E2E_MODE") == "1"'],
    ['music_app/routes/read.py', 'if settings.E2E_SEED_KEY: return fixture_payload'],
    ['music_app/services/runtime.py', 'if config.get("TESTING"): return fixture_payload'],
  ]) {
    assertRejected(scanSnippet(filePath, source), ['production-test-seam']);
  }

  const harmless = scanSnippet('music_app/services/library.py', `
# TESTING notes belong in contributor prose, not runtime behavior.
HELP_TEXT = "TESTING guidance is documented for maintainers."
def load_library(config): return config['ALBUM_HAVEN_APP_DATABASE_URL']
  `);
  assert.deepEqual(harmless.violations, []);
});

contractTest('allows sampler helper declarations before app startup', () => {
  const pythonHelper = scanSnippet('tests/e2e/support/sampler.py', `
def start_sampler(sample_interval, output_path):
    return Sampler(sample_interval, output_path)
  `);
  const javascriptHelper = scanSnippet('tests/e2e/helpers/sampler.js', `
export function startSampler(page, intervalMs) {
  return new BrowserSampler(page, intervalMs);
}
  `);

  assert.deepEqual(pythonHelper.violations, []);
  assert.deepEqual(javascriptHelper.violations, []);
});

contractTest('rejects production fixture-file magic', () => {
  for (const source of [
    'payload = json.loads(Path("tests/e2e/fixtures/problematic.json").read_text())',
    'fixture_path = os.getenv("PROBLEMATIC_FIXTURE_PATH")\nreturn fixture_path.read_text()',
    'return load_fixture_payload(config["FIXTURE_FILE"])',
  ]) {
    assertRejected(
      scanSnippet('music_app/services/problematic_albums.py', source),
      ['production-test-seam'],
    );
  }
});

contractTest('rejects Playwright routing for quoted, regex, identifier, and delegated handler forms', () => {
  const result = scanSnippet('tests/e2e/specs/problematicFiles.spec.js', `
await page.route('**/utilities/problematic-files', async route => {
  await route.fulfill({ json: { items: fixtureItems } });
});
await context.route(/\/view-data(?:\?.*)?$/, route => route.abort());
const routePattern = /\/status$/;
const delegatedHandler = async route => route.continue();
await page.route(routePattern, delegatedHandler);
  `);

  assertRejected(result, ['request-interception']);
});

contractTest('rejects routeFromHAR and standalone interception operations', () => {
  for (const source of [
    "await page.routeFromHAR('fixtures/api.har');",
    "await context.routeFromHAR(harPath, { update: false });",
    "await renamedFixture.routeFromHAR('fixtures/api.har');",
    "await transport.routeWebSocket('/socket', handler);",
    "await renamedFixture.unroute('/api', handler);",
    'await arbitraryOwner.unrouteAll();',
    "await renamedFixture.route('/api', handler);",
    "await page['route'](routePattern, delegatedHandler);",
    "await context['routeFromHAR'](harPath);",
    'async function handleRoute(route) { await route.fulfill({ json: payload }); }',
    'async function rejectRoute(route) { await route.abort(); }',
    'async function passRoute(route) { await route.continue(); }',
    'const fulfillLater = route.fulfill.bind(route);',
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/support/requestInterception.js', source),
      ['request-interception'],
    );
  }
});

contractTest('scans executable template substitutions while ignoring regex literal bodies', () => {
  assertRejected(
    scanSnippet(
      'tests/e2e/support/templateInterception.js',
      'const result = `intercepted: ${page.route(pattern, handler)}`;',
    ),
    ['request-interception'],
  );

  const regexProse = scanSnippet(
    'tests/e2e/support/regexAssertions.js',
    String.raw`const forbiddenSyntax = /page\.route\(|route\.continue\(\/api\//;`,
  );
  assert.deepEqual(regexProse.violations, []);

  for (const source of [
    String.raw`if (ready && matches(value)) /page\.route\(|route\.continue\(/.test(source);`,
    String.raw`if (ready) observe(); else /page\.route\(/.test(source);`,
    String.raw`do /page\.route\(/.test(source); while (ready);`,
    String.raw`while (ready) /page\.route\(/.test(source);`,
    String.raw`for (const value of values) /page\.route\(/.test(value);`,
    String.raw`async function inspect(values) { for await (const value of values) /page\.route\(/.test(value); }`,
  ]) {
    const controlStatementRegex = scanSnippet(
      'tests/e2e/support/controlStatementRegex.js',
      source,
    );
    assert.deepEqual(controlStatementRegex.violations, [], source);
  }
});

contractTest('allows unrelated member names and passive Playwright observation', () => {
  const result = scanSnippet('tests/e2e/support/benignWorkflow.js', `
workflow.continue();
router.route('/health');
page.on('request', request => observedUrls.push(request.url()));
page.on('response', response => observedStatuses.push(response.status()));
  `);

  assert.deepEqual(result.violations, []);
});

contractTest('allows benign request observation and ignores interception prose', () => {
  const result = scanSnippet('tests/e2e/support/requestObservations.js', `
page.on('request', request => observedUrls.push(request.url()));
page.on('response', response => observedStatuses.push(response.status()));
const prose = 'page.route(routePattern, handler) and route.fulfill() are forbidden';
// context.route(/api/, handler) is forbidden too.
  `);

  assert.deepEqual(result.violations, []);
});

contractTest('rejects selectors owned by nested retained specs, actions, and helpers', () => {
  const violations = [
    ['tests/e2e/actions/nested/galleryActions.js', `page.locator('.album-card')`],
    ['tests/e2e/helpers/nested/readiness.js', 'document.querySelector(`[data-album="${albumKey}"]`)'],
    ['tests/e2e/localRealData/nested/core.spec.js', `document.querySelector(buildSelector(albumKey))`],
    ['tests/e2e/localRealData/nested/core.spec.js', `page['locator']('#toast-layer .toast.is-error')`],
  ];
  for (const [filePath, source] of violations) {
    assertRejected(scanSnippet(filePath, source), ['selector-ownership']);
  }
});

contractTest('rejects literal locators in retained specs for every executable script extension', () => {
  for (const extension of ['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx']) {
    assertRejected(
      scanSnippet(
        `tests/e2e/localRealData/nested/selectorOwnership.spec.${extension}`,
        `page.locator('.album-card')`,
      ),
      ['selector-ownership'],
    );
  }
});

contractTest('allows POM-owned selectors and selector references consumed by retained actions', () => {
  const pom = scanSnippet('tests/e2e/poms/nested/galleryPage.js', `
this.cards = page.locator('.album-card');
document.querySelector(buildSelector(albumKey));
  `);
  const action = scanSnippet('tests/e2e/actions/nested/galleryActions.js', `
document.querySelector(selectors.albumCardSelector);
document.querySelectorAll(expected.sidebarArtistSelector);
  `);

  assert.deepEqual(pom.violations, []);
  assert.deepEqual(action.violations, []);
});

contractTest('rejects browser startup script injection for page, context, browser, and arbitrary receivers', () => {
  for (const source of [
    `await page.addInitScript(() => { localStorage.setItem('mode', 'test'); });`,
    `await context.addInitScript(() => { window.__fixture = true; });`,
    `await browser.addInitScript({ content: 'document.body.dataset.ready = "1"' });`,
    `await arbitraryOwner.addInitScript(runtimeMutation);`,
    `await renamedFixture['addInitScript'](() => state.ready = true);`,
    `const result = ` + '`${context.addInitScript(() => window.injected = true)}`' + `;`,
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/support/runtimeMutation.js', source),
      ['browser-init-script'],
    );
  }
});

contractTest('ignores browser startup script syntax in strings, comments, and regex literals', () => {
  const result = scanSnippet('tests/e2e/support/initScriptProse.js', String.raw`
const prose = 'page.addInitScript(runtimeMutation) is forbidden';
// context.addInitScript(runtimeMutation) is forbidden too.
const syntax = /browser\.addInitScript\(/;
  `);

  assert.deepEqual(result.violations, []);
});

contractTest('rejects behavior-driving evaluate blocks while permitting no unannotated evaluate escape hatch', () => {
  const result = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
await page.evaluate(() => {
  state.utility.selectedProblemFilters = ['missing-year'];
  window.__fixtureReady = true;
  renderUtilityModalContent();
  reconcileProblematicSelectionForFilters([]);
  hydrateLibrary();
  document.querySelector('button').click();
  document.body.dispatchEvent(new Event('change'));
  return fetch('/utilities/problematic-files');
});
  `);

  assertRejected(result, ['behavior-driving-evaluate']);
});

contractTest('read-only evaluate annotations cannot permit DOM, state, or interaction mutations', () => {
  for (const source of [
    `// parity-check: allow-read-only-measurement-evaluate -- invalid mutation
await locator.evaluate((element) => { element.setAttribute('data-ready', 'true'); });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid state write
await page.evaluate(() => { state.ready = true; });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid interaction
await frame.evaluate(() => document.querySelector('button').click());`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid dataset write
await locator.evaluate((element) => { element.dataset.ready = '1'; });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid style write
await locator.evaluate((element) => { element.style.display = 'none'; });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid arbitrary property write
await locator.evaluate((element) => { element.testState ||= {}; });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid mutating method
await page.evaluate(() => { document.body.style.setProperty('display', 'none'); });`,
    `// parity-check: allow-read-only-measurement-evaluate -- invalid callback collection mutation
await frame.evaluate((values) => { values.push('synthetic'); }, []);`,
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/helpers/measurements.js', source),
      ['behavior-driving-evaluate'],
    );
  }
});

contractTest('rejects behavior-driving inline and aliased browser polling callbacks', () => {
  for (const source of [
    `await page.waitForFunction(() => document.querySelector('button').click());`,
    `await frame.waitForFunction(() => { state.utility.ready = true; return true; });`,
    `await page.waitForFunction(() => { localStorage.setItem('ready', '1'); return true; });`,
    `await actions.waitForPageCondition(() => {
  document.body.setAttribute('data-ready', '1');
  return true;
});`,
    `const driveApplication = () => {
  document.querySelector('[data-open-utility]').click();
  return true;
};
await page.waitForFunction(driveApplication);`,
    `function mutateApplicationState() {
  state.utility.selectedProblemFilters.push('missing-year');
  return true;
}
await actions.waitForPageCondition(mutateApplicationState);`,
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/actions/problematicFilesActions.js', source),
      ['behavior-driving-poll'],
    );
  }
});

contractTest('allows annotated and ordinary read-only browser polling callbacks', () => {
  const result = scanSnippet('tests/e2e/helpers/readiness.js', `
await page.waitForFunction((selectors) => (
  document.querySelector(selectors.readySelector)?.getAttribute('data-ready') === '1'
), { readySelector: pageModel.readySelector });
// parity-check: allow-read-only-measurement-evaluate -- readiness telemetry only
await frame.waitForFunction(() => Number(performance.now()) > 0);
const readOnlyReady = (selectors) => {
  const row = document.querySelector(selectors.problemRowSelector);
  return row instanceof HTMLElement && !row.hidden && row.textContent.trim().length > 0;
};
await actions.waitForPageCondition(readOnlyReady, {}, { problemRowSelector: pageModel.problemRowSelector });
  `);

  assert.deepEqual(result.violations, []);
});

contractTest('rejects direct dispatchEvent calls and synthetic browser events', () => {
  const result = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
await checkbox.dispatchEvent('change');
const event = new MouseEvent('click', { bubbles: true });
  `);

  assertRejected(result, ['synthetic-browser-event']);
});

contractTest('rejects forced actions and force-enabled defaults', () => {
  const forcedClick = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
await problemRow.click({ force: true });
  `);
  const forceDefault = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
async function activate(locator, { force = true } = {}) {
  await locator.click({ force });
}
  `);

  assertRejected(forcedClick, ['forced-browser-action']);
  assertRejected(forceDefault, ['forced-browser-action']);
});

contractTest('rejects behavior and image-success fallbacks', () => {
  const result = scanSnippet('tests/e2e/actions/galleryActions.js', `
await waitForVisibleCovers({ allowPendingRemoteFallback: true });
const loaded = image.complete && (image.naturalWidth > 0 || image.naturalWidth === 0);
try { await requiredProductAction(); } catch (_error) { return fallbackPayload; }
  `);

  assertRejected(result, ['behavior-fallback', 'image-success-fallback']);
});

contractTest('rejects direct CI skips in retained core suites', () => {
  const result = scanSnippet('tests/e2e/specs/problematicFiles.spec.js', `
test.skip(process.env.CI === 'true', 'not stable in CI');
if (process.env.CI) test.skip();
  `);

  assertRejected(result, ['core-ci-skip']);
});

contractTest('rejects multiline CI fixme and describe skip variants', () => {
  const result = scanSnippet('tests/e2e/specs/problematicFiles.spec.js', `
test.describe.skip(
  process.env.CI === 'true',
  'not stable in CI',
);
if (CI) {
  test.fixme();
}
  `);

  assertRejected(result, ['core-ci-skip']);
});

contractTest('rejects swallowed required requests and conditional populated success', () => {
  const result = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
const payload = await request.get('/utilities/problematic-files').catch(() => null);
if (payload?.items?.length) {
  await expect(listItems).not.toHaveCount(0);
} else {
  await expect(emptyState).toBeVisible();
}
  `);

  assertRejected(result, ['swallowed-required-request', 'conditional-populated-success']);
});

contractTest('rejects swallowed browser failures and timeout-to-success paths', () => {
  const result = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
await problemRows.first().waitFor().catch(() => {});
try {
  await expect(problemRows.first()).toBeVisible({ timeout: 250 });
} catch (error) {
  if (error.name === 'TimeoutError') return false;
  throw error;
}
  `);

  assertRejected(result, ['swallowed-browser-failure']);
});

contractTest('rejects comment-only swallowed catches and catch callbacks', () => {
  for (const source of [
    `try { await locator.click(); } catch (_error) { /* ignored */ }`,
    `try { await locator.click(); } catch { // best effort only
    }`,
    `await locator.click().catch(() => { /* ignored */ });`,
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/actions/problematicFilesActions.js', source),
      ['swallowed-browser-failure'],
    );
  }

  const rethrown = scanSnippet('tests/e2e/actions/problematicFilesActions.js', `
try { await locator.click(); } catch (error) {
  console.error(error);
  throw error;
}
  `);
  assert.equal(ruleIds(rethrown).has('swallowed-browser-failure'), false);
});

contractTest('rejects response-conditional assertions', () => {
  const result = scanSnippet('tests/e2e/specs/problematicFiles.spec.js', `
const response = await page.waitForResponse('**/utilities/problematic-files');
if (response.ok()) {
  await expect(problemRows).toHaveCount(3);
}
  `);

  assertRejected(result, ['conditional-response-assertion']);
});

contractTest('rejects braceless and aliased response-result conditional assertions', () => {
  for (const source of [
    `if (response.ok()) await expect(problemRows).toHaveCount(3);`,
    `const result = response;
if (result.ok) {
  await expect(problemRows).toHaveCount(3);
}`,
    `if (requestOutcome.success) assert.equal(problemRows.length, 3);`,
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/specs/problematicFiles.spec.js', source),
      ['conditional-response-assertion'],
    );
  }

  const unconditionalAssertion = scanSnippet('tests/e2e/specs/problematicFiles.spec.js', `
if (response.ok()) recordResponse(response);
await expect(problemRows).toHaveCount(3);
  `);
  assert.equal(ruleIds(unconditionalAssertion).has('conditional-response-assertion'), false);
});

contractTest('rejects permissive fallback-success flags and defaults', () => {
  for (const source of [
    'await waitForRows({ allowPendingRemoteFallback: true });',
    'async function waitForRows({ allowMissing = true } = {}) {}',
    'const options = { fallbackSuccess: true };',
    'await waitForRows({ ignoreErrors: true });',
  ]) {
    assertRejected(
      scanSnippet('tests/e2e/actions/problematicFilesActions.js', source),
      ['behavior-fallback'],
    );
  }
});

contractTest('allows ignore_errors only for Python temporary-directory cleanup', () => {
  const result = scanSnippet('tests/e2e/support/isolatedLibraryApp.py', `
shutil.rmtree(temp_root, ignore_errors=True)
  `);

  assert.deepEqual(result.violations, []);
});

contractTest('scanRepo aggregates file findings and report renders a failing summary', (t) => {
  const root = makeFixtureRepo(t, {
    'music_app/routes/debug.py': '@router.get("/__e2e/state")\ndef state(): return {}',
    'tests/e2e/specs/core.spec.js': "test.skip(process.env.CI === 'true');",
    'tests/e2e/helpers/deep/nested/readiness.js': "document.querySelector(buildSelector(albumKey));",
  });
  const checker = loadChecker();
  const result = checker.scanRepo(root);
  const output = checker.report(result);

  assert.equal(result.ok, false);
  assert.equal(result.violations.length >= 2, true);
  assert.match(output, /production parity/i);
  assert.match(output, /production-test-seam/);
  assert.match(output, /core-ci-skip/);
  assert.match(output, /selector-ownership/);
});

contractTest('scanRepo excludes the repository temporary-artifact directory', (t) => {
  const root = makeFixtureRepo(t, {
    'tests/e2e/support/seed.py': 'seed_normal_product_tables(connection)',
    '.tmp/playwright-artifacts/deep/generated.spec.js': "test.skip(process.env.CI === 'true');",
  });
  const originalReaddirSync = fs.readdirSync;
  let temporaryDirectoryVisits = 0;
  fs.readdirSync = function parityFixtureReaddirSync(directory, ...args) {
    if (path.basename(String(directory)) === '.tmp') {
      temporaryDirectoryVisits += 1;
      throw new Error('Parity checker traversed the repository temporary-artifact directory.');
    }
    return originalReaddirSync.call(this, directory, ...args);
  };
  t.after(() => {
    fs.readdirSync = originalReaddirSync;
  });

  const result = loadChecker().scanRepo(root);

  assert.equal(temporaryDirectoryVisits, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

contractTest('CLI exits zero for a clean tree and nonzero with the parity report for violations', (t) => {
  const cleanRoot = makeFixtureRepo(t, {
    'tests/e2e/support/seed.py': 'seed_normal_product_tables(connection)',
  });
  const dirtyRoot = makeFixtureRepo(t, {
    'music_app/routes/debug.py': '@router.get("/__e2e/state")\ndef state(): return {}',
    'tests/e2e/actions/deep/nested/galleryActions.js': "page.locator('.album-card');",
  });

  const clean = childProcess.spawnSync(process.execPath, [CHECKER_PATH, '--root', cleanRoot], {
    encoding: 'utf8',
  });
  const dirty = childProcess.spawnSync(process.execPath, [CHECKER_PATH, '--root', dirtyRoot], {
    encoding: 'utf8',
  });

  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.equal(dirty.status, 1);
  assert.match(`${dirty.stdout}\n${dirty.stderr}`, /production-test-seam/);
  assert.match(`${dirty.stdout}\n${dirty.stderr}`, /selector-ownership/);
});
