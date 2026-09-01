import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERFORMANCE_AUTH_PASSWORD,
  PERFORMANCE_AUTH_USERNAME,
  authenticatePerformanceContext,
} from '../e2e/support/performanceAuthentication.js';

function loginPage({ accepted = true } = {}) {
  const calls = [];
  return {
    calls,
    page: {
      async goto(url) {
        calls.push(['goto', url]);
      },
      getByLabel(label, options) {
        return {
          async fill(value) {
            calls.push(['fill', label, options || null, value]);
          },
        };
      },
      getByRole(role, options) {
        return {
          async click() {
            calls.push(['click', role, options]);
          },
        };
      },
      async waitForURL(predicate) {
        calls.push(['waitForURL']);
        if (!accepted || !predicate(new URL('http://127.0.0.1:4173/health'))) {
          throw new Error('login rejected');
        }
      },
    },
  };
}

test('performance authentication submits the production browser login form', async () => {
  const fixture = loginPage();

  await authenticatePerformanceContext(fixture.page);

  assert.deepEqual(fixture.calls, [
    ['goto', '/login?return_to=%2Fhealth'],
    ['fill', 'Username', null, PERFORMANCE_AUTH_USERNAME],
    ['fill', 'Password', { exact: true }, PERFORMANCE_AUTH_PASSWORD],
    ['waitForURL'],
    ['click', 'button', { name: 'Sign in' }],
  ]);
  assert.equal(fixture.calls[0][1].includes(PERFORMANCE_AUTH_PASSWORD), false);
});

test('performance authentication fails closed when login stays on the form', async () => {
  const fixture = loginPage({ accepted: false });

  await assert.rejects(
    authenticatePerformanceContext(fixture.page),
    /Performance authentication did not leave the login route/,
  );
});
