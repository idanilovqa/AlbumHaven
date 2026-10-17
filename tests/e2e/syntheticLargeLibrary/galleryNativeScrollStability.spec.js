import { expect, test } from '../support/performanceFixtures.js';
import {
  analyzeNativeScrollGesture,
  GalleryRegressions,
  nativeScrollDisplacementMatchesCommand,
  nativeScrollStepsMatchCommand,
} from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

const TOUCH_ACTIVATION_DISTANCE = 15;
const TOUCH_MOVE_STEPS = 24;
const TOUCH_MOVE_FRAME_INTERVALS = 2;
const STATIONARY_TOUCH_FRAMES = 12;

async function activateNativeTouchSwipe(ui, cdp, point, startY, activatedY) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(startY)],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(activatedY)],
  });
  await ui.waitForAnimationFrame();
  await ui.waitForNativeScrollSettled();
}

async function dispatchNativeTouchSwipe(ui, cdp, point, startY, endY) {
  for (let step = 1; step <= TOUCH_MOVE_STEPS; step += 1) {
    const y = startY + ((endY - startY) * step / TOUCH_MOVE_STEPS);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(y)],
    });
    for (let frame = 0; frame < TOUCH_MOVE_FRAME_INTERVALS; frame += 1) {
      await ui.waitForAnimationFrame();
    }
  }
  for (let frame = 0; frame < STATIONARY_TOUCH_FRAMES; frame += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(endY)],
    });
    await ui.waitForAnimationFrame();
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function openDeepGallery(page, galleryActions, navigationPanelActions, mobile, view) {
  const ui = new GalleryRegressions(page);
  await galleryActions.goto('/?surface=albums&all_artists=1');
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
  await new MobileLayoutPage(page).selectView(view);
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

function expectGestureStable(samples, direction, commandedDistance, maximumForwardStep) {
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter(sample => !sample.connected)).toEqual([]);
  const coordinates = samples.map(sample => sample.viewportOffset);
  expect(coordinates.every(Number.isFinite)).toBe(true);
  const evidence = analyzeNativeScrollGesture(samples, direction);
  expect(evidence.anchorReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.originalNodeReplacementIndexes, JSON.stringify(samples)).toEqual([]);
  expect(evidence.maxReverseVisibleDrift, JSON.stringify(samples)).toBe(0);
  expect(evidence.maxForwardVisibleStep, JSON.stringify(samples))
    .toBeLessThanOrEqual(maximumForwardStep);
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
  expect(
    nativeScrollStepsMatchCommand(evidence.signedStepDeltas, maximumForwardStep),
    JSON.stringify({ evidence, maximumForwardStep, samples }),
  ).toBe(true);
}

async function observeGesture(
  ui, testInfo, name, direction, commandedDistance, maximumForwardStep, gesture,
  beforeObservation = null,
) {
  if (beforeObservation) await beforeObservation();
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
  expectGestureStable(samples, direction, commandedDistance, maximumForwardStep);
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
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, true, view);
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      const cdp = await page.context().newCDPSession(page);
      const x = Math.round(box.x + box.width / 2);
      const point = y => ({ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 });
      try {
        const lowerY = Math.round(box.y + box.height * 0.68);
        const upperY = Math.round(box.y + box.height * 0.46);
        const commandedDistance = Math.abs(lowerY - upperY);
      const maximumForwardStep = Math.ceil(commandedDistance / TOUCH_MOVE_STEPS);
        await observeGesture(
          ui, testInfo, `${view}-mobile-native-swipe-forward`, 1,
          commandedDistance, maximumForwardStep,
          () => dispatchNativeTouchSwipe(
          ui, cdp, point,
          lowerY - TOUCH_ACTIVATION_DISTANCE,
          upperY - TOUCH_ACTIVATION_DISTANCE,
          ),
        () => activateNativeTouchSwipe(
          ui, cdp, point, lowerY, lowerY - TOUCH_ACTIVATION_DISTANCE,
        ),
        );
        await observeGesture(
          ui, testInfo, `${view}-mobile-native-swipe-reverse`, -1,
          commandedDistance, maximumForwardStep,
          () => dispatchNativeTouchSwipe(
          ui, cdp, point,
          upperY + TOUCH_ACTIVATION_DISTANCE,
          lowerY + TOUCH_ACTIVATION_DISTANCE,
          ),
        () => activateNativeTouchSwipe(
          ui, cdp, point, upperY, upperY + TOUCH_ACTIVATION_DISTANCE,
        ),
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
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, false, view);
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const commandedDistance = 4 * 32;
      await observeGesture(ui, testInfo, `${view}-desktop-native-wheel-forward`, 1, commandedDistance, 32, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, 32);
          await ui.waitForAnimationFrame();
        }
      });
      await observeGesture(ui, testInfo, `${view}-desktop-native-wheel-reverse`, -1, commandedDistance, 32, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, -32);
          await ui.waitForAnimationFrame();
        }
      });
    });
  });
});
