import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
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

function expectGestureStable(samples, direction) {
  expect(samples.length).toBeGreaterThan(5);
  expect(samples.filter(sample => !sample.connected)).toEqual([]);
  const coordinates = samples.map(sample => sample.contentCoordinate);
  expect(coordinates.every(Number.isFinite)).toBe(true);
  let segmentCoordinate = coordinates[0];
  const segments = [[samples[0]]];
  for (let index = 1; index < samples.length; index += 1) {
    const anchorChanged = samples[index].anchorGeneration !== samples[index - 1].anchorGeneration;
    if (anchorChanged) {
      segmentCoordinate = coordinates[index];
      segments.push([samples[index]]);
      continue;
    }
    const scrollDelta = samples[index].scrollTop - samples[index - 1].scrollTop;
    const coordinateDelta = coordinates[index] - coordinates[index - 1];
    const compensatedRebase = Math.abs(scrollDelta) >= 8
      && Math.abs(coordinateDelta) >= 8;
    if (compensatedRebase) {
      const viewportDelta = samples[index].viewportOffset - samples[index - 1].viewportOffset;
      if (direction > 0) expect(viewportDelta).toBeLessThanOrEqual(1);
      else expect(viewportDelta).toBeGreaterThanOrEqual(-1);
      segmentCoordinate = coordinates[index];
      segments.push([samples[index]]);
      continue;
    }
    expect(
      Math.abs(coordinates[index] - segmentCoordinate),
      JSON.stringify({
        index,
        direction,
        segmentCoordinate,
        previous: samples[index - 1],
        current: samples[index],
      }),
    ).toBeLessThanOrEqual(1);
    segments.at(-1).push(samples[index]);
  }

  let committedSegmentCount = 0;
  for (const segment of segments) {
    const moving = segment.filter((sample, index) => (
      index === 0 || Math.abs(sample.scrollTop - segment[index - 1].scrollTop) >= 0.5
    ));
    const initial = moving[0]?.scrollTop;
    const committedIndex = moving.findIndex(sample => (
      direction > 0 ? sample.scrollTop >= initial + 8 : sample.scrollTop <= initial - 8
    ));
    if (committedIndex < 0) continue;
    committedSegmentCount += 1;
    const committed = moving.slice(committedIndex);
    const reverseDeltas = committed.slice(1).map((sample, index) => (
      sample.scrollTop - committed[index].scrollTop
    )).filter(delta => (direction > 0 ? delta < -0.5 : delta > 0.5));
    expect(reverseDeltas, JSON.stringify(committed)).toEqual([]);
  }
  expect(committedSegmentCount).toBeGreaterThan(0);
}

async function observeGesture(ui, testInfo, name, direction, gesture) {
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
  expectGestureStable(samples, direction);
}

test.describe('FTC-GALLERY-NAV-035 synthetic-large native gallery scroll stability', () => {
  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('native touch swipes track the gesture without reverse movement or layout jitter', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, true);
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
        await observeGesture(ui, testInfo, 'mobile-native-swipe-forward', 1, () => swipe(
          Math.round(box.y + box.height * 0.68),
          Math.round(box.y + box.height * 0.46),
        ));
        await observeGesture(ui, testInfo, 'mobile-native-swipe-reverse', -1, () => swipe(
          Math.round(box.y + box.height * 0.46),
          Math.round(box.y + box.height * 0.68),
        ));
      } finally {
        await cdp.detach();
      }
    });
  });

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

    test('native wheel input tracks the gesture without reverse movement or layout jitter', async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = await openDeepGallery(page, galleryActions, navigationPanelActions, false);
      const box = await ui.galleryScroll.boundingBox();
      if (!box) throw new Error('Gallery scroll surface is not visible.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await observeGesture(ui, testInfo, 'desktop-native-wheel-forward', 1, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, 32);
          await page.waitForTimeout(20);
        }
      });
      await observeGesture(ui, testInfo, 'desktop-native-wheel-reverse', -1, async () => {
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, -32);
          await page.waitForTimeout(20);
        }
      });
    });
  });
});
