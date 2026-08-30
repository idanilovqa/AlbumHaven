const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../../package.json');

test('package scripts expose separate functional and performance Playwright entry points', () => {
  assert.equal(packageJson.scripts['test:e2e'], undefined);
  assert.equal(packageJson.scripts['test:e2e:functional'], 'node scripts/run-functional-playwright.cjs test');
  assert.equal(packageJson.scripts['test:e2e:performance'], 'node scripts/run-performance-playwright.cjs');
  assert.equal(packageJson.scripts['test:e2e:performance:idle-memory'], 'node scripts/run-performance-playwright.cjs --group idle-memory');
  assert.equal(packageJson.scripts['test:e2e:performance:local-real-data'], undefined);
  assert.equal(packageJson.scripts['test:e2e:performance:real-app'], 'node scripts/run-performance-playwright.cjs --group real-app');
  assert.equal(packageJson.scripts['test:e2e:performance:scan'], undefined);
  assert.equal(packageJson.scripts['test:e2e:performance:scan-cold'], undefined);
  assert.equal(packageJson.scripts['test:e2e:performance:scanner-index-cache'], undefined);
});
