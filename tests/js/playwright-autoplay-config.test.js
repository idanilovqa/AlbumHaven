const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const defaultConfig = require(path.join(repoRoot, 'playwright.config.js'));
const autoplayFlag = '--autoplay-policy=no-user-gesture-required';

function loadPinnedChromeProjects(configPath) {
  const script = [
    "process.argv = [process.execPath, 'playwright-cli', '--browser=chrome', '--list'];",
    `const config = require(${JSON.stringify(configPath)});`,
    'process.stdout.write(JSON.stringify(config.projects.map((project) => project.use)));',
  ].join(' ');
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLAYWRIGHT_CHROME_EXECUTABLE: 'C:\\runner-tools\\chrome-win64\\chrome.exe',
    },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('default Playwright projects never bypass Chrome autoplay policy', () => {
  for (const project of defaultConfig.projects || []) {
    const args = project.use?.launchOptions?.args || [];
    assert.equal(args.includes(autoplayFlag), false);
  }
  assert.match(
    String(defaultConfig.projects[0].testIgnore),
    /playerReloadAutoplayAllowed/,
  );
});

test('allowed-autoplay config is isolated to one installed-Chrome reload spec', () => {
  const config = require(path.join(repoRoot, 'playwright.autoplay-allowed.config.js'));
  const [project] = config.projects;

  assert.equal(config.projects.length, 1);
  assert.equal(config.workers, 1);
  assert.equal(project.use.browserName, 'chromium');
  assert.equal(project.use.channel, 'chrome');
  assert.deepEqual(
    project.use.launchOptions.args.filter((arg) => arg === autoplayFlag),
    [autoplayFlag],
  );
  assert.match(String(project.testMatch), /playerReloadAutoplayAllowed/);
  assert.match(String(config.outputDir), /autoplay-allowed$/);
});

test('default and autoplay configs launch the exact verified Chrome executable', () => {
  for (const configPath of [
    './playwright.config.js',
    './playwright.autoplay-allowed.config.js',
  ]) {
    const [use] = loadPinnedChromeProjects(configPath);
    assert.equal(use.browserName, 'chromium', configPath);
    assert.equal(use.channel, undefined, configPath);
    assert.equal(
      use.launchOptions.executablePath,
      'C:\\runner-tools\\chrome-win64\\chrome.exe',
      configPath,
    );
  }
});
