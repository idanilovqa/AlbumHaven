import { expect, test } from '../support/performanceFixtures.js';
import {
  analyzeNativeScrollGesture,
  GalleryRegressions,
  nativeScrollDisplacementMatchesCommand,
} from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

async function openDeepGallery(page, galleryActions, navigationPanelActions, mobile) {
  const ui = new GalleryRegressions(page);
  await galleryActions.goto();
  await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
    timeout: 120000,
  });
  await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
  await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
  await navigationPanelActions.openArtistTree();
  const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
  expect(artists.length).toBeGreaterThan(250);
  const requestedArtist = artists[200];
  const row = await ui.revealArtistWithWheel(requestedArtist);
  if (mobile) await ui.longPressArtist(row);
  else await row.click({ button: 'right' });
  await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
  await ui.scrollToArtistAction.click();
  await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist))
    .toMatchObject({ anchorArtist: requestedArtist });
  const artist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist
    || requestedArtist;
  await expect.poll(() => ui.readArtistJumpPlacement(artist)).toEqual({
    rendered: true,
    chromeMatches: true,
    rowsAligned: true,
    firstCardUncut: true,
  });
  return ui;
}

function expectGestureStable(samples, direction, commandedDistance) {
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter(sample => !sample.connected)).toEqual([]);
  const coordinates = samples.map(sample => sample.contentCoordinate);
  expect(coordinates.every(Number.isFinite)).toBe(true);
  const evidence = analyzeNativeScrollGesture(samples, direction);
  expect(evidence.anchorReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.originalNodeReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.maxContentDrift, JSON.stringify(samples)).toBe(0);
  expect(evidence.firstMovementIndex, JSON.stringify(samples)).toBeGreaterThan(0);
  expect(
    evidence.signedStepDeltas.filter(delta => delta < 0),
    JSON.stringify({ evidence, samples }),
  ).toEqual([]);
  expect(
    nativeScrollDisplacementMatchesCommand(
      evidence.signedTotalDisplacement,
      commandedDistance,
    ),
    JSON.stringify({ evidence, commandedDistance, samples }),
  ).toBe(true);
}

async function observeGesture(ui, testInfo, name, direction, commandedDistance, gesture) {
  const anchor = await ui.captureMiddleVisibleCard();
  const observation = await ui.startNativeScrollFrameObservation(anchor);
  let samples;
  try {
    await gesture();
    await ui.page.waitForTimeout(300);
  } finally {
    samples = await observation.finish();
    await testInfo.attach(name, {
      body: JSON.stringify({ anchor, direction, samples }),
      contentType: 'application/json',
    });
  }
  expectGestureStable(samples, direction, commandedDistance);
}

test.describe('FTC-GALLERY-NAV-035 synthetic-large native gallery scroll stability', () => {
  for (const { label, view } of [
    { label: 'Cards', view: 'cards' },
    { label: 'Covers', view: 'covers' },
    { label: 'Rows', view: 'list' },
  ]) test.describe(`mobile ${label}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('native touch swipes track the commanded gesture without reverse movement or layout jitter', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, true);
      await new MobileLayoutPage(page).selectView(view);
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      const cdp = await page.context().newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      const point = y => ({ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 });
      const swipe = async (startY, endY) => {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart', touchPoints: [point(startY)],
        });
        for (let step = 1; step <= 18; step += 1) {
          const y = Math.round(startY + ((endY - startY) * step) / 18);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [point(y)],
          });
          await page.waitForTimeout(12);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      try {
        const lowerY = Math.round(box.y + box.height * 0.68);
        const upperY = Math.round(box.y + box.height * 0.46);
        const commandedDistance = Math.abs(lowerY - upperY);
        // Pinned Chrome consumes the first 15 px to activate native touch scrolling.
        const touchActivationDistance = 15;
        await observeGesture(
          ui, testInfo, `${view}-mobile-native-swipe-forward`, 1, commandedDistance,
          () => swipe(lowerY, upperY - touchActivationDistance),
        );
        await observeGesture(
          ui, testInfo, `${view}-mobile-native-swipe-reverse`, -1, commandedDistance,
          () => swipe(upperY, lowerY + touchActivationDistance),
        );
      } finally {
        await cdp.detach();
      }
    });
  });

  for (const { label, view } of [
    { label: 'Cards', view: 'cards' },
    { label: 'Covers', view: 'covers' },
  ]) test.describe(`desktop ${label}`, () => {
    test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

    test('native wheel input tracks the commanded gesture without reverse movement or layout jitter', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, false);
      await new MobileLayoutPage(page).selectView(view);
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const commandedDistance = 4 * 32;
      await observeGesture(ui, testInfo, `${view}-desktop-native-wheel-forward`, 1, commandedDistance, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, 32);
          await page.waitForTimeout(20);
        }
      });
      await observeGesture(ui, testInfo, `${view}-desktop-native-wheel-reverse`, -1, commandedDistance, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, -32);
          await page.waitForTimeout(20);
        }
      });
    });
  });
});
