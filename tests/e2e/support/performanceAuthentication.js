export const PERFORMANCE_AUTH_USERNAME = 'rendref';
export const PERFORMANCE_AUTH_PASSWORD = 'Phase Seven Performance Passphrase 2026!';

export async function authenticateProductionContext(page) {
  // Land on the lightweight health document after login. Starting the gallery here
  // would create background status/view requests that a benchmark's first page
  // navigation legitimately aborts and then misclassifies as product failures.
  await page.goto('/login?return_to=%2Fhealth');
  await page.getByLabel('Username').fill(PERFORMANCE_AUTH_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(PERFORMANCE_AUTH_PASSWORD);
  try {
    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname !== '/login'),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
  } catch (_error) {
    throw new Error('Production E2E authentication did not leave the login route.');
  }
}

export async function authenticatePerformanceContext(page) {
  try {
    await authenticateProductionContext(page);
  } catch (_error) {
    throw new Error('Performance authentication did not leave the login route.');
  }
}
