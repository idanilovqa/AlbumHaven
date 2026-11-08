import { expect, test } from '../support/baseFixtures.js';
import { LoginPage } from '../phase7/poms/authPages.js';
import { StartupProgress } from '../poms/startupProgress.js';
import {
  PERFORMANCE_AUTH_PASSWORD,
  PERFORMANCE_AUTH_USERNAME,
} from '../support/performanceAuthentication.js';

// The bar may trail its label by one rounding step while it glides.
const FILL_TOLERANCE_PERCENT = 1.5;

async function expectContinuousColdLoad({ page, stepLogger }, testInfo) {
  const startupProgress = new StartupProgress(page);
  const login = new LoginPage(page);
  let samples = [];

  await stepLogger.step('Sign in from a signed-out cold load and sample until the app releases the overlay', async () => {
    await page.context().clearCookies();
    await login.open('/');
    const sampling = startupProgress.sampleUntilAppReleasesOverlay();
    await login.signIn(PERFORMANCE_AUTH_USERNAME, PERFORMANCE_AUTH_PASSWORD);
    samples = await sampling;
    const changes = samples.filter((sample, index) => index === 0
      || ['path', 'overlayVisible', 'percent', 'barVisible', 'fillColored'].some((key) => sample[key] !== samples[index - 1][key]));
    console.log(`[startup-progress] ${samples.length} frames; changes: ${JSON.stringify(changes)}`);
    await testInfo.attach('startup-progress-frames.json', {
      body: JSON.stringify(samples, null, 1),
      contentType: 'application/json',
    });
    await expect(startupProgress.overlay).toBeHidden();
  });

  await stepLogger.step('Progress never goes back and continues across the sign-in navigation', async () => {
    const shown = samples.filter((sample) => sample.overlayVisible);
    const signInFrames = shown.filter((sample) => sample.path === '/login');
    const appFrames = shown.filter((sample) => sample.path !== '/login');
    expect(signInFrames.length).toBeGreaterThan(0);
    expect(appFrames.length).toBeGreaterThan(0);
    expect(appFrames[0].percent).toBeGreaterThanOrEqual(Math.max(...signInFrames.map((sample) => sample.percent)));
    expect(Math.max(...appFrames.map((sample) => sample.percent))).toBeGreaterThanOrEqual(75);
    const regressions = shown.filter((sample, index) => index > 0 && sample.percent < shown[index - 1].percent);
    expect(regressions).toEqual([]);
  });

  await stepLogger.step('The bar stays visible, colored and as wide as its percent on every frame', async () => {
    const broken = samples
      .filter((sample) => sample.overlayVisible)
      .filter((sample) => !sample.barVisible || !sample.trackColored || (sample.percent > 0 && !sample.fillColored)
        || Math.abs(sample.fillPercent - sample.percent) > FILL_TOLERANCE_PERCENT);
    expect(broken).toEqual([]);
  });
}

test('FTC-GALLERY-STARTUP-007 desktop sign-in progress never restarts and keeps a visible advancing bar', {
  tag: '@area:gallery-search',
}, async ({ page, stepLogger }, testInfo) => {
  await expectContinuousColdLoad({ page, stepLogger }, testInfo);
});

test.describe('mobile cold load', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('FTC-GALLERY-STARTUP-007M mobile sign-in progress never restarts and keeps a visible advancing bar', {
    tag: '@area:gallery-search',
  }, async ({ page, stepLogger }, testInfo) => {
    await expectContinuousColdLoad({ page, stepLogger }, testInfo);
  });
});
