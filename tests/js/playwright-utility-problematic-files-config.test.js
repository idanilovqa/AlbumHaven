const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const configPath = './playwright.utility-problematic-files.config.cjs';

function loadForInventory() {
  const env = {
    ...process.env,
    ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY: '1',
    PLAYWRIGHT_BROWSER: 'chrome',
  };
  delete env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return childProcess.spawnSync(process.execPath, ['-e', [
    "process.argv.push('--list');",
    `const config = require('${configPath}');`,
    'process.stdout.write(JSON.stringify(config));',
  ].join(' ')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

test('dedicated Problematic Files config is a managed-only one-worker Chrome surface', () => {
  const discovery = loadForInventory();
  assert.equal(discovery.status, 0, discovery.stderr);
  const config = JSON.parse(discovery.stdout);

  assert.equal(path.normalize(config.testDir), path.join(repoRoot, 'tests', 'e2e', 'utilityProblematicFiles'));
  assert.equal(
    path.normalize(config.outputDir),
    path.join(repoRoot, 'test-results', 'playwright-artifacts', 'utility-problematic-files'),
  );
  assert.equal(config.workers, 1);
  assert.equal(config.fullyParallel, false);
  assert.equal(config.webServer, undefined);
  assert.match(config.use.baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.projects.length, 1);
  assert.equal(config.projects[0].name, 'utility-problematic-files');
  assert.equal(config.projects[0].use.browserName, 'chromium');
  assert.equal(config.projects[0].use.channel, 'chrome');

  const unmanaged = childProcess.spawnSync(process.execPath, ['-e', `require('${configPath}')`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.notEqual(unmanaged.status, 0);
  assert.match(unmanaged.stderr, /managed|discovery/i);
});
