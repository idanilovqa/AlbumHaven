const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { FullConfigInternal, ipc } = require('playwright/lib/common');

const repoRoot = path.resolve(__dirname, '..', '..');
const configPath = path.join(repoRoot, 'playwright.home-feedback.config.js');

function configForProcess(pid, manifest) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(configPath, 'utf8'), {
    module,
    require: createRequire(configPath),
    __dirname: repoRoot,
    process: {
      pid,
      argv: [process.execPath, 'playwright-cli'],
      env: { ...process.env, PLAYWRIGHT_PORT: '6270', ALBUM_HAVEN_HOME_FEEDBACK_MANIFEST: manifest },
    },
  }, { filename: configPath });
  return module.exports;
}

test('Home fixture retains the parent manifest after config reload in a different worker process', async () => {
  const location = { configDir: repoRoot, resolvedConfigFile: configPath };
  const parentManifest = path.join(repoRoot, 'test-results', 'parent-41001', 'home-feedback-manifest.json');
  const workerManifest = path.join(repoRoot, 'test-results', 'worker-41002', 'home-feedback-manifest.json');
  const parent = new FullConfigInternal(location, configForProcess(41001, parentManifest), {});
  const serialized = ipc.serializeConfig(parent, false);
  const worker = new FullConfigInternal(location, configForProcess(41002, workerManifest), {}, JSON.parse(serialized.metadata));
  const parentPath = parent.config.metadata.homeFeedbackManifest;
  assert.equal(parentPath, parentManifest);
  assert.equal(parent.config.webServer, null);
  const discoveryConfig = configForProcess(41003, '');
  assert.equal(discoveryConfig.webServer, undefined);
  assert.equal(discoveryConfig.metadata.homeFeedbackManifest, '', 'discovery imports must not require an app launch');
  assert.equal(worker.config.metadata.homeFeedbackManifest, parentPath);
  assert.notEqual(worker.config.projects[0].metadata.homeFeedbackManifest, parentPath,
    'project metadata is rebuilt locally and must not be used as the parent manifest authority');

  // Execute the real fixture body with a harness-only read spy, not a browser/app.
  const fixtureSource = fs.readFileSync(path.join(repoRoot, 'tests/e2e/fixtures/homeFeedbackTest.js'), 'utf8');
  const start = fixtureSource.indexOf('homeManifest: [') + 'homeManifest: ['.length;
  const end = fixtureSource.indexOf(", { scope: 'worker' }]", start);
  assert.ok(start >= 'homeManifest: ['.length && end > start);
  const reads = [], expected = { cases: { FB001: {} }, catalog: {} };
  const fixture = vm.runInNewContext(`(${fixtureSource.slice(start, end)})`, {
    fs: { readFile: async file => { reads.push(file); return JSON.stringify(expected); } },
    process: { env: { PLAYWRIGHT_MANAGED_APP: '1' } },
  });
  let used;
  await fixture({}, async value => { used = value; }, { config: worker.config, project: worker.config.projects[0] });
  assert.deepEqual(reads, [parentPath]);
  assert.equal(JSON.stringify(used), JSON.stringify(expected));
  assert.doesNotMatch(fixtureSource, /process\.env\.ALBUM_HAVEN_HOME_FEEDBACK_MANIFEST/);
  const unwrapped = vm.runInNewContext(`(${fixtureSource.slice(start, end)})`, {
    fs: { readFile: async () => assert.fail('unwrapped execution must reject before reading data') },
    process: { env: {} },
  });
  await assert.rejects(unwrapped({}, async () => assert.fail('unwrapped fixture must not run'), { config: worker.config }),
    /requires the runner-owned app and manifest/);
});
