import { PHONE_USER_AGENT, expect, test as base } from '../support/baseFixtures.js';
import { PERFORMANCE_AUTH_USERNAME } from '../support/performanceAuthentication.js';
import { withRestoredAppearanceFixture } from '../helpers/appearanceFixture.js';
import { InteractionSurfaces, expectPartialCoverRow } from '../poms/interactionSurfaces.js';
import {
  captureResponsiveGalleryScreenshot,
  expectCardsFillGalleryWidth,
  expectResponsiveRatingSingleLine,
  waitForResponsiveGalleryLayout,
} from '../helpers/responsiveGalleryHelpers.js';

const test = base.extend({
  appearanceBaseline: [async ({ context, managedAppLifecycle }, use) => {
    await withRestoredAppearanceFixture({
      username: PERFORMANCE_AUTH_USERNAME, context, managedAppLifecycle,
    }, use);
  }, { auto: true }],
});

const ARTIST = 'Album Rating Contract';
const RATED_ALBUM = 'Rating Numeric Authority';
const COVERLESS_ARTIST = 'ДДТ';
const COVERLESS_ALBUM = 'Студийные записи';
const GALLERY_SCALE_PERCENT = 125;
const WIDE_VIEWPORT = Object.freeze({ width: 1440, height: 960 });
const NARROW_VIEWPORT = Object.freeze({ width: 1024, height: 960 });

test('FTC-MOBILE-WEB-007 keeps ratings on one line while narrower galleries preserve selected card scale', { tag: '@area:responsive-visual' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  testArtifacts,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  let wideLayout;
  let narrowLayout;

  await stepLogger.step('Open the real Postgres gallery at an explicit 125 percent card scale', async () => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await galleryActions.goto(
      `/?surface=albums&gallery_display=cards&gallery_scale_percent=${GALLERY_SCALE_PERCENT}`,
    );
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.choosePalette('paper', 1);
    await utilityAppearanceActions.save();
    await settingsModalAppBarActions.closeSettings();
    await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, RATED_ALBUM);
    expect(new URL(page.url()).searchParams.get('gallery_scale_percent')).toBe(
      String(GALLERY_SCALE_PERCENT),
    );
  });

  await stepLogger.step('Record the wide gallery density, rating geometry, and visible screenshot', async () => {
    await galleryActions.galleryPage.lastCardInFirstAlbumRow.hover();
    wideLayout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, {
      artistName: ARTIST,
      ratedAlbumName: RATED_ALBUM,
    });
    await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 3 });
    await captureResponsiveGalleryScreenshot(
      galleryActions.galleryPage,
      testArtifacts,
      'responsive-gallery-scale-125-wide.png',
    );
  });

  await stepLogger.step('Narrow the same production view and record its settled layout and screenshot', async () => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await galleryActions.scrollToAlbumUnderHeading(ARTIST, RATED_ALBUM);
    await galleryActions.galleryPage.albumCard
      .cardsByArtistAndAlbum(ARTIST, RATED_ALBUM)
      .first()
      .hover();
    narrowLayout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, {
      artistName: ARTIST,
      ratedAlbumName: RATED_ALBUM,
    });
    await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 2 });
    await captureResponsiveGalleryScreenshot(
      galleryActions.galleryPage,
      testArtifacts,
      'responsive-gallery-scale-125-narrow.png',
    );
  });

  await stepLogger.step('Distribute available width evenly without wrapping ratings', async () => {
    expect(wideLayout.columnCount).toBeGreaterThanOrEqual(3);
    expect(narrowLayout.columnCount).toBeLessThan(wideLayout.columnCount);
    expectCardsFillGalleryWidth(expect, wideLayout);
    expectCardsFillGalleryWidth(expect, narrowLayout);

    expectResponsiveRatingSingleLine(expect, wideLayout);
    expectResponsiveRatingSingleLine(expect, narrowLayout);
  });

  await stepLogger.step('Apply the Paper palette to an exact projected coverless album card', async () => {
    await searchToolbarActions.search(COVERLESS_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(COVERLESS_ARTIST);
    await galleryActions.scrollToAlbumUnderHeading(COVERLESS_ARTIST, COVERLESS_ALBUM);
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 1,
      allowPlaceholder: true,
      placeholderScenario: `${COVERLESS_ARTIST} / ${COVERLESS_ALBUM} is the projected coverless fixture`,
    });
    const artbox = await galleryActions.galleryPage.albumCard
      .readAlbumArtboxAppearance(COVERLESS_ALBUM);
    expect(artbox.state).toBe('empty');
    expect(artbox.backgroundImage).toContain('linear-gradient');
    expect(artbox.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(Math.abs(artbox.width - artbox.height)).toBeLessThanOrEqual(1);
    expect(artbox.missingMarkVisible).toBe(true);
  });
  await stepLogger.step('Render the partly visible next row in cover-only view', async () => {
    await page.setViewportSize({ width: 1440, height: 830 });
    await galleryActions.goto('/?surface=albums&artist=Neal%20Morse&gallery_display=covers');
    await galleryActions.waitForGalleryReady();
    await expectPartialCoverRow(page, new InteractionSurfaces(page));
  });

});

// Owner (11-08): toggling Chrome's device toolbar between a phone and the web layout sometimes left the
// mouse acting as touch, or a wide window still showing half of the phone layout with empty sides.
test('FTC-MOBILE-WEB-008 switching Chrome device emulation from phone back to web restores the full web layout and mouse input', { tag: '@area:responsive-visual' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  testArtifacts,
}) => {
  const cdp = await page.context().newCDPSession(page);
  const desktopUserAgent = await page.evaluate(() => navigator.userAgent);
  const readShell = () => page.evaluate(() => ({
    profile: document.documentElement.dataset.clientProfile,
    hover: matchMedia('(hover: hover) and (pointer: fine)').matches,
    touchPoints: navigator.maxTouchPoints,
    userAgentMobile: /Android|iPhone/i.test(navigator.userAgent),
    mobileHeaderVisible: Boolean(document.getElementById('mobile-library-button')?.checkVisibility?.()),
    searchVisible: Boolean(document.getElementById('search-input')?.checkVisibility?.()),
  }));
  let desktopLayout;

  await stepLogger.step('Record the web gallery layout before any device emulation', async () => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await galleryActions.goto('/?surface=albums&gallery_display=cards');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, RATED_ALBUM);
    desktopLayout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, { artistName: ARTIST, ratedAlbumName: RATED_ALBUM });
    expect(await readShell()).toMatchObject({ profile: 'web_desktop', hover: true, mobileHeaderVisible: false, searchVisible: true });
  });

  for (const [round, userAgentLast] of [[1, true], [2, false], [3, true]]) {
    await stepLogger.step(`Round ${round}: toggle the device toolbar to a phone and back to the web layout`, async () => {
      const phone = [
        ['Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }],
        ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
        ['Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }],
        ['Emulation.setUserAgentOverride', { userAgent: PHONE_USER_AGENT, platform: 'Linux armv8l' }],
      ];
      for (const [method, params] of phone) await cdp.send(method, params);
      await expect.poll(readShell).toMatchObject({ profile: 'mobile', mobileHeaderVisible: true });
      const web = [
        ['Emulation.setEmitTouchEventsForMouse', { enabled: false }],
        ['Emulation.setTouchEmulationEnabled', { enabled: false }],
        ['Emulation.setDeviceMetricsOverride', { ...WIDE_VIEWPORT, deviceScaleFactor: 1, mobile: false }],
      ];
      const restoreUserAgent = ['Emulation.setUserAgentOverride', { userAgent: desktopUserAgent }];
      if (userAgentLast) web.push(restoreUserAgent); else web.unshift(restoreUserAgent);
      for (const [method, params] of web) await cdp.send(method, params);

      await expect.poll(readShell, { message: 'The web layout and mouse input are restored.' }).toEqual({
        profile: 'web_desktop', hover: true, touchPoints: 0, userAgentMobile: false, mobileHeaderVisible: false, searchVisible: true,
      });
      const layout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, { artistName: ARTIST, ratedAlbumName: RATED_ALBUM });
      await captureResponsiveGalleryScreenshot(galleryActions.galleryPage, testArtifacts, `responsive-gallery-device-toggle-${round}.png`);
      expectCardsFillGalleryWidth(expect, layout);
      expect(layout.galleryBounds).toEqual(desktopLayout.galleryBounds);
      expect(layout.columnCount).toBe(desktopLayout.columnCount);
      expect(layout.cardWidths).toEqual(desktopLayout.cardWidths);

      // A real mouse click opens the web album dialog rather than a phone page.
      await galleryActions.galleryPage.albumCard.detailsButtonByArtistAndAlbum(ARTIST, RATED_ALBUM).click();
      const albumDialog = page.locator('#track-modal');
      await expect(albumDialog).toBeVisible();
      await expect(albumDialog).not.toHaveClass(/\bis-mobile-page\b/);
      await page.keyboard.press('Escape');
      await expect(albumDialog).toBeHidden();
    });
  }
});
